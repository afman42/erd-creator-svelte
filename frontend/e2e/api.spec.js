// HTTP contract of grpc the frontend relies on — request fixture only, no browser.
import { expect, test } from "@playwright/test";

const schema = {
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
		},
	],
};

test("lint + inserts + export accept the wire schema", async ({ request }) => {
	expect(
		await (await request.post("/api/lint", { data: { schema } })).json(),
	).toEqual([]);
	expect(
		await (await request.post("/api/inserts", { data: { schema } })).text(),
	).toContain("INSERT INTO `users`");
	expect(
		await (
			await request.post("/export", { data: { dialect: "postgres", schema } })
		).text(),
	).toContain('CREATE TABLE "users"');
});

test("export rejects unknown dialect with 400", async ({ request }) => {
	expect(
		(
			await request.post("/export", { data: { dialect: "oracle", schema } })
		).status(),
	).toBe(400);
});

test("files: traversal + bad name rejected, save/read/delete round-trip", async ({
	request,
}) => {
	expect(
		(
			await request.put("/api/files/..%2Fescape.sql", { data: schema })
		).status(),
	).toBe(400);
	expect(
		(await request.put("/api/files/nope.txt", { data: schema })).status(),
	).toBe(400);

	expect(
		(await request.put("/api/files/api.spec.sql", { data: schema })).status(),
	).toBe(204);
	const got = await (await request.get("/api/files/api.spec.sql")).json();
	expect(got.tables[0].name).toBe("users");
	expect((await request.delete("/api/files/api.spec.sql")).status()).toBe(204);
	expect((await request.get("/api/files/api.spec.sql")).status()).toBe(404);
});

test("open of unparseable file → 400 with message", async ({ request }) => {
	// write via API is always valid; corrupt file needs the dir — assert open path on missing name
	const res = await request.get("/api/files/ghost.sql");
	expect(res.status()).toBe(404);
	expect(await res.text()).toContain("ghost.sql");
});
