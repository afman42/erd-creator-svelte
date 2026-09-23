// Server validation boundary: what the HTTP API refuses, and how. The schema
// POST endpoints take untrusted JSON and turn it into SQL text, so every value
// that cannot be represented safely must be rejected with a terse 400 — never
// echoed, never persisted. These pin the rejects (and the one 405) against the
// real server, complementing the Go unit tests with the wire contract the
// frontend depends on.
import { expect, test } from "@playwright/test";

const goodSchema = {
	tables: [
		{
			id: "t1",
			name: "users",
			columns: [
				{
					name: "id",
					type: "INT",
					pk: true,
					nn: true,
					ai: true,
					ux: false,
					ix: false,
					comment: "",
					ref: null,
				},
			],
			indexes: [],
		},
	],
};

async function expect400(req, label) {
	const res = await req;
	expect(res.status(), label).toBe(400);
	// the message is terse and must not echo the rejected payload
	const text = await res.text();
	expect(text.length, label).toBeLessThan(200);
	expect(text, label).toMatch(/invalid schema|unknown dialect/);
}

test("lint is POST-only; GET is refused", async ({ request }) => {
	expect((await request.get("/api/lint")).status()).toBe(405);
	expect((await request.get("/api/inserts")).status()).toBe(405);
});

test("bad JSON body → 400", async ({ request }) => {
	const res = await request.post("/api/lint", { data: "{not json" });
	expect(res.status()).toBe(400);
});

test("duplicate table names → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables.push(structuredClone(s.tables[0]));
	await expect400(request.post("/api/lint", { data: { schema: s } }), "dupe");
});

test("duplicate column names → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].columns.push(structuredClone(s.tables[0].columns[0]));
	await expect400(request.post("/api/lint", { data: { schema: s } }), "dupe");
});

test("semicolon in a table name → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].name = "users; DROP TABLE x";
	await expect400(request.post("/api/lint", { data: { schema: s } }), "semi");
});

test("newline control character in a name → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].name = "users\nx";
	await expect400(request.post("/api/lint", { data: { schema: s } }), "nl");
});

test("SQL-injection type expression → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].columns[0].type = "VARCHAR(1;DROP TABLE users;--)";
	await expect400(request.post("/api/lint", { data: { schema: s } }), "type");
});

test("FK action injection → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].columns[0].ref = {
		tableId: "t1",
		action: "CASCADE; DROP TABLE users;--",
		onUpdate: "",
	};
	await expect400(request.post("/api/lint", { data: { schema: s } }), "fk");
});

test("ENUM array type → 400 in every dialect", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].columns[0].type = "ENUM('a','b')[]";
	for (const dialect of ["mysql", "postgres", "sqlite"]) {
		await expect400(
			request.post("/export", { data: { dialect, schema: s } }),
			dialect,
		);
	}
});

test("array type is refused for mysql/sqlite but accepted for postgres", async ({
	request,
}) => {
	const s = structuredClone(goodSchema);
	// a non-PK column: validate.go rejects arrays on PK columns by design,
	// which would mask the dialect check this test is about
	s.tables[0].columns = [{ name: "id", type: "INT", pk: false, nn: true }];
	s.tables[0].columns.push({ name: "labels", type: "INT[]", nn: true });
	for (const dialect of ["mysql", "sqlite"]) {
		await expect400(
			request.post("/export", { data: { dialect, schema: s } }),
			dialect,
		);
	}
	expect(
		(
			await request.post("/export", {
				data: { dialect: "postgres", schema: s },
			})
		).status(),
	).toBe(200);
});

test("single-column table-level index → 400 (unrepresentable shape)", async ({
	request,
}) => {
	const s = structuredClone(goodSchema);
	s.tables[0].indexes = [{ name: "ix1", cols: ["id"] }];
	await expect400(request.post("/api/lint", { data: { schema: s } }), "ix");
});

test("duplicate derived index names → 400", async ({ request }) => {
	const s = structuredClone(goodSchema);
	s.tables[0].indexes = [
		{ name: "ix1", cols: ["id"] },
		{ name: "ix1", cols: ["id"] },
	];
	await expect400(request.post("/api/lint", { data: { schema: s } }), "ix");
});

test("oversized body (over 1 MiB) → 400", async ({ request }) => {
	const big = "x".repeat(1 << 20); // 1 MiB of padding in a column name
	const s = structuredClone(goodSchema);
	s.tables[0].name = big;
	const res = await request.post("/api/lint", { data: { schema: s } });
	expect([400, 413]).toContain(res.status());
});

test("security headers are set on every reply including errors", async ({
	request,
}) => {
	const res = await request.get("/api/lint"); // 405, an error path
	expect(res.headers()["content-security-policy"]).toContain(
		"default-src 'self'",
	);
	expect(res.headers()["x-frame-options"]).toBe("DENY");
	expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});

test("parent with no PK: lint reports it and DDL omits the FK", async ({
	request,
}) => {
	const s = {
		tables: [
			{
				id: "t1",
				name: "parent",
				columns: [{ name: "id", type: "INT", ref: null }],
			},
			{
				id: "t2",
				name: "child",
				columns: [
					{
						name: "parent_id",
						type: "INT",
						ref: { tableId: "t1", action: "CASCADE", onUpdate: "" },
					},
				],
			},
		],
	};
	const diags = await (
		await request.post("/api/lint", { data: { schema: s } })
	).json();
	expect(diags.join(" ")).toContain("no PK");
	const sql = await (
		await request.post("/export", { data: { dialect: "mysql", schema: s } })
	).text();
	expect(sql).not.toContain("FOREIGN KEY");
});
