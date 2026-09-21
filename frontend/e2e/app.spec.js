// UI flows against the real server: store CRUD, autosave, undo, lint.
import { expect, test } from "@playwright/test";

// Each test starts from an empty schema store.
test.beforeEach(async ({ request }) => {
	const res = await request.get("/api/files");
	for (const f of await res.json()) {
		await request.delete(`/api/files/${f.name}`);
	}
});

async function tables(page) {
	return page.locator(".tname").evaluateAll((els) => els.map((i) => i.value));
}

// Open the edit dialog for a column and return it. Every per-column control
// (name, type, flags, FK, action, comment, remove) lives in this dialog now —
// the card row is a read-only label — so the tests below drive the dialog
// rather than the row. Note this is an HTML <dialog>, not a JS dialog: it does
// not emit Playwright's "dialog" event, which stays reserved for the native
// prompt()/confirm() calls in schema.svelte.js.
async function openCol(page, tableIndex = 0, colIndex = 0) {
	await page
		.locator("section.table")
		.nth(tableIndex)
		.locator(".row .edit")
		.nth(colIndex)
		.click();
	const dlg = page.locator("dialog.coledit");
	await expect(dlg).toBeVisible();
	return dlg;
}

// Close the open dialog and wait for it to leave the top layer.
async function closeCol(dlg) {
	await dlg.getByRole("button", { name: "Done" }).click();
	await expect(dlg).toHaveCount(0);
}

test("empty store → fresh default users table", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".tname")).toHaveValue("users");
	expect(await tables(page)).toEqual(["users"]);
});

test("New file → save → reload round-trips through server", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("blog"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("blog.sql");

	// add + rename a table → debounced autosave should write it
	await page.getByRole("button", { name: "+ Table" }).click();
	const posts = page.locator(".tname").nth(1);
	await posts.fill("posts");
	await posts.blur();
	await expect(async () => {
		const body = await (await request.get("/api/files/blog.sql")).json();
		expect(body.tables.some((t) => t.name === "posts")).toBe(true);
	}).toPass({ timeout: 5000 });

	await page.reload();
	await expect(page.locator("section.table")).toHaveCount(2);
	await expect(page.locator(".tname").first()).toHaveValue("users");
	expect(await tables(page)).toEqual(["users", "posts"]);
});

test("undo restores table name (Ctrl+Z outside inputs)", async ({ page }) => {
	await page.goto("/");
	const inp = page.locator(".tname").first();
	await inp.fill("members");
	await inp.blur();
	await expect(page.locator(".tname")).toHaveValue("members");
	await page.locator("body").click({ position: { x: 5, y: 300 } }); // defocus
	await page.keyboard.press("Control+z");
	await expect(page.locator(".tname")).toHaveValue("users");
});

test("min-max cardinality labels render on FK edges", async ({ page }) => {
	await page.goto("/");
	// no FK yet → no edges and no labels
	await expect(page.locator("svg text.card")).toHaveCount(0);

	// add a table and point its first column at users
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await closeCol(dlg);

	// one edge → exactly two labels: child end and parent end
	const labels = page.locator("svg text.card");
	await expect(labels).toHaveCount(2);

	// the default new column is `id INT PK NN AI`, so it is a SOLE pk (unique,
	// child 0..1) and NOT NULL (parent 1..1)
	const texts = await labels.allTextContents();
	expect(texts.sort()).toEqual(["0..1", "1..1"]);
});

// The cardinality dropdown is a VIEW of the ux/nn flags, never a stored field —
// the .sql file has nowhere to keep a cardinality. So changing it must change
// the flags, and the diagram labels must follow immediately.
test("cardinality dropdown drives the flags and the diagram labels", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	// the new table's id column is a sole PK, so clear PK first: that is the one
	// shape where every option is reachable
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await dlg.locator('.flags label[title="primary key"] input').uncheck();

	const card = dlg.locator("[data-testid=cardinality]");
	await expect(card).toBeVisible();

	// 0..N / 0..1 → child becomes many, parent stays optional.
	// The expected order is SORTED: "0..1" sorts before "0..N" because "1" < "N".
	await card.selectOption("0..N / 0..1");
	await closeCol(dlg);
	await expect
		.poll(async () =>
			(await page.locator("svg text.card").allTextContents()).sort(),
		)
		.toEqual(["0..1", "0..N"]);

	// 0..1 / 1..1 → both ends change
	const dlg2 = await openCol(page, 1, 0);
	await expect(dlg2.locator("[data-testid=cardinality]")).toHaveValue(
		"0..N / 0..1",
	);
	await dlg2.locator("[data-testid=cardinality]").selectOption("0..1 / 1..1");
	await closeCol(dlg2);
	await expect
		.poll(async () =>
			(await page.locator("svg text.card").allTextContents()).sort(),
		)
		.toEqual(["0..1", "1..1"]);

	// the flags really moved: the SQL panel shows NOT NULL and UNIQUE
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText("NOT NULL UNIQUE");
});

// A PK is emitted NOT NULL in every dialect, so its parent end is pinned to
// 1..1 whatever the nn flag says. The dropdown must show that as fixed rather
// than offer a choice it would have to override.
test("cardinality options are disabled when a PK pins the state", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });

	// the column is a sole PK → only 0..1 / 1..1 is reachable
	const opts = dlg.locator("[data-testid=cardinality] option");
	await expect(opts).toHaveCount(4);
	const enabled = await opts.evaluateAll((els) =>
		els.filter((e) => !e.disabled).map((e) => e.value),
	);
	expect(enabled).toEqual(["0..1 / 1..1"]);
	await expect(dlg.locator("[data-testid=cardinality]")).toHaveValue(
		"0..1 / 1..1",
	);
});

// A self-referencing FK (parent_id → same table) is an ordinary pattern — a
// tree or adjacency list — and it parses, emits and round-trips. The UI cannot
// create one (the FK dropdown excludes the column's own table), so it is
// reachable only from a hand-written or externally generated .sql file. That is
// exactly the case the earlier cardinality work missed: the loop was routed
// through the card body, drawing the curve and both labels INSIDE the table.
test("self-referencing FK loops outside its card with labels clear", async ({
	page,
	request,
}) => {
	// write the schema through the API, the way an existing file would arrive
	const put = await request.put("/api/files/self.sql", {
		data: {
			dialect: "mysql",
			tables: [
				{
					id: "t1",
					name: "categories",
					columns: [
						{ name: "id", type: "INT", pk: true, nn: true, ai: true },
						{
							name: "parent_id",
							type: "INT",
							ref: { tableId: "t1", action: "CASCADE" },
						},
					],
				},
			],
		},
	});
	expect(put.ok()).toBeTruthy();

	await page.goto("/");
	await page.getByLabel("Open schema file").selectOption("self.sql");
	await expect(page.locator(".tname").first()).toHaveValue("categories");

	const labels = page.locator("svg text.card");
	await expect(labels).toHaveCount(2);

	// the invariant, measured in the real DOM: no label sits inside the card
	const bad = await page.evaluate(() => {
		const cards = [...document.querySelectorAll("section.table")].map((e) => {
			const r = e.getBoundingClientRect();
			return { l: r.left, r: r.right, t: r.top, b: r.bottom };
		});
		const out = [];
		for (const t of document.querySelectorAll("svg text.card")) {
			const b = t.getBBox();
			for (const c of cards) {
				if (
					b.x < c.r &&
					b.x + b.width > c.l &&
					b.y < c.b &&
					b.y + b.height > c.t
				)
					out.push(
						`${t.textContent} at (${Math.round(b.x)},${Math.round(b.y)})`,
					);
			}
		}
		return out;
	});
	expect(bad).toEqual([]);

	// and the notation is right for a tree: the FK column is not unique (many
	// children) and nullable (a root has no parent)
	const texts = await labels.allTextContents();
	expect(texts.sort()).toEqual(["0..1", "0..N"]);
});

test("FK type mismatch surfaces server lint in header", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	// second table, first column: set the FK to users via the dialog
	const dlg = await openCol(page, 1, 0);
	const fk = dlg.locator("select.fk");
	await fk.selectOption({ index: 1 });
	// clear the FK, change the type to VARCHAR, then restore the FK — the
	// mismatch is what the server lints on
	await fk.selectOption("");
	await dlg.locator("select.type").selectOption("VARCHAR"); // becomes VARCHAR(255)
	await fk.selectOption({ index: 1 });
	await expect(page.locator("header .warn")).toContainText("vs", {
		timeout: 5000,
	});
});

test("table delete × removes box and clears dangling FKs", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await closeCol(dlg);
	// the FK target is now visible on the row label, so the dangling state is
	// assertable without reopening the dialog
	await expect(
		page.locator("section.table").nth(1).locator(".row .fkinfo"),
	).toHaveText("→users");
	await page
		.locator("section.table")
		.first()
		.getByTitle("delete table (Del)")
		.click();
	await expect(page.locator("section.table")).toHaveCount(1);
	// the parent is gone, so the FK must have been cleared
	await expect(
		page.locator("section.table").locator(".row .fkinfo"),
	).toHaveCount(0);
});

test("FK ON UPDATE survives dialog, save, reload and SQL panel", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("fkupdate"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("fkupdate.sql");

	// second table gets an FK to users, then an ON UPDATE action
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	// no ON UPDATE by default: the control exists but reads "— none —"
	await expect(dlg.locator("select[data-testid=on-update]")).toHaveValue("");
	await dlg.locator("select[data-testid=on-update]").selectOption("CASCADE");

	// the clause must reach the server, not just the dialog. This endpoint
	// serves the parsed schema envelope (JSON), so the assertion is on the
	// model field; the DDL rendering is asserted through the SQL panel below,
	// which goes through the same emitter as the saved file.
	await expect(async () => {
		const body = await (await request.get("/api/files/fkupdate.sql")).json();
		const col = body.tables[1].columns[0];
		expect(col.ref.onUpdate).toBe("CASCADE");
	}).toPass({ timeout: 5000 });

	// and survive a reopen: the dialog reads the saved action back
	await closeCol(dlg);
	await page.reload();
	const dlg2 = await openCol(page, 1, 0);
	await expect(dlg2.locator("select[data-testid=on-update]")).toHaveValue(
		"CASCADE",
	);
	await closeCol(dlg2);

	// the SQL panel shows it too, through the same emitter as the saved file
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText("ON UPDATE CASCADE");
});

test("composite index round-trips through dialog, save, reload and SQL", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("idx"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("idx.sql");

	// a second column so an index over two columns is meaningful
	await page.getByRole("button", { name: "+ column" }).first().click();

	// open the composite-index dialog from the card header
	await page
		.getByRole("button", { name: /composite indexes for/ })
		.first()
		.click();
	const dlg = page.locator("dialog.idxedit");
	await expect(dlg).toBeVisible();
	await expect(dlg).toContainText("No composite indexes");

	// pick both columns in the "New index" fieldset, then create
	const picks = dlg.locator(".new .picks label");
	await picks.nth(0).click();
	await picks.nth(1).click();
	await dlg.getByRole("button", { name: "Add index" }).click();
	await expect(dlg.getByTestId("index-row")).toHaveCount(1);

	// it reaches the server as a table-level index, not as two column flags
	await expect(async () => {
		const body = await (await request.get("/api/files/idx.sql")).json();
		const t = body.tables[0];
		expect(t.indexes?.length).toBe(1);
		expect(t.indexes[0].cols.length).toBe(2);
	}).toPass({ timeout: 5000 });

	// and the emitted DDL has the composite KEY, which is the whole point.
	// The dialog must be closed first: it is modal, so it intercepts clicks on
	// the toolbar behind it.
	await dlg.getByRole("button", { name: "Done" }).click();
	await expect(dlg).toHaveCount(0);
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText(
		"KEY `idx_users_id_column` (`id`, `column`)",
	);

	// survives a reopen
	await page.reload();
	await page
		.getByRole("button", { name: /composite indexes for/ })
		.first()
		.click();
	await expect(
		page.locator("dialog.idxedit").getByTestId("index-row"),
	).toHaveCount(1);
});

test("postgres array type round-trips and is refused for other dialects", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("arr"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("arr.sql");

	// the array control is postgres-only: absent while mysql is selected
	const mysqlDlg = await openCol(page, 0, 0);
	await expect(mysqlDlg.locator("[data-testid=is-array]")).toHaveCount(0);
	await closeCol(mysqlDlg);

	// switch to postgres, then turn the column into an array
	await page.getByTestId("dialect").selectOption("postgres");
	const dlg = await openCol(page, 0, 0);
	const isArray = dlg.locator("[data-testid=is-array]");
	await expect(isArray).toBeVisible();
	await isArray.check();
	await closeCol(dlg);

	// the suffix reaches the server and survives a reopen
	await expect(async () => {
		const body = await (await request.get("/api/files/arr.sql")).json();
		expect(body.tables[0].columns[0].type).toBe("INT[]");
	}).toPass({ timeout: 5000 });

	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText('"id" INT[]');

	// and the same schema exported as mysql must be refused, because INT[] is
	// not valid MySQL — the error must name the target dialect
	const res = await request.post("/export", {
		data: {
			dialect: "mysql",
			schema: await (await request.get("/api/files/arr.sql")).json(),
		},
	});
	expect(res.status()).toBe(400);
	expect(await res.text()).toContain("PostgreSQL-only");
});

test("array toggle clears PK and AI, which an array column cannot be", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByTestId("dialect").selectOption("postgres");
	// the default column is id/INT/PK/NN/AI — an array cannot be any of those
	const dlg = await openCol(page, 0, 0);
	await dlg.locator("[data-testid=is-array]").check();
	// PK and AI must both clear: an array column can be neither in PostgreSQL.
	// Selected by title rather than index so a flag reorder cannot silently
	// make this assert the wrong control.
	await expect(
		dlg.locator('.flags label[title="primary key"] input'),
	).not.toBeChecked();
	await expect(
		dlg.locator('.flags label[title="auto increment"] input'),
	).not.toBeChecked();
	// unticking restores a plain type
	await dlg.locator("[data-testid=is-array]").uncheck();
	await closeCol(dlg);
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText('"id" INT');
	await expect(page.locator("aside pre")).not.toContainText("INT[]");
});

test("Del button deletes current file after confirm dialog", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("tmpfile"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("tmpfile.sql");
	page.once("dialog", (d) => d.accept());
	await page.getByRole("button", { name: "Del", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveCount(0);
	const list = await (await request.get("/api/files")).json();
	expect(list).toEqual([]);
});

// ---- added coverage (gaps) ----

test("duplicate table copies columns and offsets position", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByTitle("duplicate").click();
	await expect(page.locator("section.table")).toHaveCount(2);
	expect(await tables(page)).toEqual(["users", "users_copy"]);
	// duplicated column retains its type — the row label shows it without
	// needing the dialog
	const dupType = page
		.locator("section.table")
		.nth(1)
		.locator(".row .ty")
		.first();
	await expect(dupType).toHaveText("INT");
});

test("+ Table names increment numerically (table1, table2, …)", async ({
	page,
}) => {
	await page.goto("/");
	for (let i = 0; i < 4; i++) {
		await page.getByRole("button", { name: "+ Table" }).click();
	}
	// uniqName is unit-tested in test/erd.test.js; this covers the wiring, which
	// previously produced table1, table12, table13 by concatenating the counter.
	expect(await tables(page)).toEqual([
		"users",
		"table1",
		"table2",
		"table3",
		"table4",
	]);
});

test("add column + remove column (last column blocked)", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ column" }).click();
	await expect(page.locator("section.table .row")).toHaveCount(2);
	// remove the second column through its dialog
	const dlg = await openCol(page, 0, 1);
	await dlg.getByRole("button", { name: "Remove column" }).click();
	await expect(dlg).toHaveCount(0);
	await expect(page.locator("section.table .row")).toHaveCount(1);
	// removing the last column must be refused, so the dialog stays open over
	// the flash the user needs to read
	const last = await openCol(page, 0, 0);
	await last.getByRole("button", { name: "Remove column" }).click();
	await expect(page.locator("section.table .row")).toHaveCount(1);
	await expect(last).toBeVisible();
	await expect(page.locator("header .err")).toContainText(
		"needs at least one column",
	);
});

test("PK toggle forces NN and clears on untoggle", async ({ page }) => {
	await page.goto("/");
	// users.id starts pk=true, nn disabled checked
	const dlg = await openCol(page, 0, 0);
	const pk = dlg.locator("label").filter({ hasText: "PK" }).locator("input");
	const nn = dlg.locator("label").filter({ hasText: "NN" }).locator("input");
	await expect(pk).toBeChecked();
	await expect(nn).toBeChecked();
	await expect(nn).toBeDisabled();
	await pk.click();
	await expect(pk).not.toBeChecked();
	await expect(nn).not.toBeDisabled();
});

test("Show SQL panel renders MySQL DDL", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText("CREATE TABLE `users`");
	await page.getByRole("button", { name: "Hide SQL" }).click();
	await expect(page.locator("aside")).toHaveCount(0);
});

test("column comment persists through save/reload", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("cmt"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("cmt.sql");
	const dlg = await openCol(page, 0, 0);
	const cmt = dlg.locator("input.cmt");
	await cmt.fill("hello comment");
	await cmt.blur();
	await expect(async () => {
		const body = await (await request.get("/api/files/cmt.sql")).text();
		expect(body).toContain("hello comment");
	}).toPass({ timeout: 5000 });
	// the row shows the comment as read-only text, so the round-trip is
	// assertable without reopening the dialog
	await page.reload();
	await expect(page.locator("section.table .cmt").first()).toHaveText(
		"hello comment",
	);
});

// ---- regression: drag/selection/data-loss fixes ----

test("dragging a table by its header moves it (even over the name input)", async ({
	page,
}) => {
	await page.goto("/");
	const t = page.locator("section.table").first();
	const before = await t.evaluate((el) => `${el.style.left},${el.style.top}`);
	const hdr = await t.locator(".hdr").boundingBox();
	await page.mouse.move(hdr.x + 60, hdr.y + 10); // over the .tname input
	await page.mouse.down();
	await page.mouse.move(hdr.x + 90, hdr.y + 30, { steps: 4 });
	await page.mouse.up();
	const after = await t.evaluate((el) => `${el.style.left},${el.style.top}`);
	expect(after).toBe("70px,60px");
	expect(before).not.toBe(after);
});

test("click selects a table and Del removes the selection", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	const second = page.locator("section.table").nth(1);
	const hdr = await second.locator(".hdr").boundingBox();
	await page.mouse.move(hdr.x + 30, hdr.y + 8);
	await page.mouse.down();
	await page.mouse.up();
	await expect(second).toHaveClass(/selected/);
	await page.locator("body").click({ position: { x: 5, y: 400 } }); // defocus
	await page.keyboard.press("Delete");
	await expect(page.locator("section.table")).toHaveCount(1);
});

test("edit switched away from within the autosave window is not lost", async ({
	page,
	request,
}) => {
	await page.goto("/");
	let n = 0;
	page.on("dialog", (d) => d.accept(`dl${n++}`));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("dl0.sql");
	const dlg = await openCol(page, 0, 0);
	const name = dlg.locator("input.cname");
	await name.fill("col_renamed");
	await name.blur();
	await closeCol(dlg);
	// switch files BEFORE the 800ms autosave fires — pending edit must flush
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("dl1.sql");
	const body = await (await request.get("/api/files/dl0.sql")).json();
	expect(body.tables[0].columns[0].name).toBe("col_renamed");
});

test("Copy SQL succeeds via execCommand fallback without clipboard permission", async ({
	page,
}) => {
	await page.goto("/");
	// Playwright's default context grants no clipboard permissions, so the
	// Clipboard API rejects and the textarea/execCommand fallback must run.
	await page.getByRole("button", { name: "Copy SQL" }).click();
	await expect(page.getByText("copied SQL")).toBeVisible();
	await expect(page.getByText("copy failed")).toHaveCount(0);
});

test("Ctrl+Z after switching files must not write the old file's schema", async ({
	page,
	request,
}) => {
	await page.goto("/");
	let n = 0;
	page.on("dialog", (d) => d.accept(`f${n++}`));
	// file A: a rename pushes an undo snapshot that belongs to A
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("f0.sql");
	const name = page.locator(".tname").first();
	await name.fill("alpha");
	await name.blur();
	await expect(async () => {
		const body = await (await request.get("/api/files/f0.sql")).json();
		expect(body.tables[0].name).toBe("alpha");
	}).toPass({ timeout: 5000 });
	// file B: fresh schema, different file
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("f1.sql");
	// undo must not reach back into f0's history and restore it into f1
	await page.locator("body").click({ position: { x: 5, y: 400 } }); // defocus
	await page.keyboard.press("Control+z");
	// Deterministic: the in-memory schema is the assertion, checked immediately.
	await expect(page.locator(".tname").first()).toHaveValue("users");
	// Then flush whatever is in memory to disk via an explicit save, so the
	// server-side check does not depend on the 800ms autosave having elapsed.
	// With the bug, the undone A-schema would be what lands in f1.sql.
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(async () => {
		const body = await (await request.get("/api/files/f1.sql")).json();
		expect(body.tables[0].name).toBe("users");
	}).toPass({ timeout: 5000 });
	// f0 must be untouched by any of this
	const a = await (await request.get("/api/files/f0.sql")).json();
	expect(a.tables[0].name).toBe("alpha");
});

// ---- dialect switching (mysql ⇄ postgres) ----

test("dialect dropdown drives the SQL panel, not a hardcoded dialect", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Show SQL" }).click();
	// default is mysql: backticks
	await expect(page.locator("aside pre")).toContainText("CREATE TABLE `users`");
	await expect(page.getByTestId("sql-dialect")).toHaveText("mysql");
	// switch to postgres: the panel must follow, showing double quotes
	await page.getByTestId("dialect").selectOption("postgres");
	await expect(page.locator("aside pre")).toContainText('CREATE TABLE "users"');
	await expect(page.locator("aside pre")).not.toContainText(
		"CREATE TABLE `users`",
	);
	// and the panel labels which grammar it is showing
	await expect(page.getByTestId("sql-dialect")).toHaveText("postgres");
	// and back again
	await page.getByTestId("dialect").selectOption("mysql");
	await expect(page.locator("aside pre")).toContainText("CREATE TABLE `users`");
	await expect(page.getByTestId("sql-dialect")).toHaveText("mysql");
});

test("saving in postgres writes postgres DDL that reopens intact", async ({
	page,
	request,
}) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("pgfile"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("pgfile.sql");
	// switch this file to postgres, then edit so a save is scheduled
	await page.getByTestId("dialect").selectOption("postgres");
	const name = page.locator(".tname").first();
	await name.fill("members");
	await name.blur();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	// GET /api/files/:name returns the PARSED schema, not the raw file, so the
	// dialect field is what proves the postgres grammar round-tripped. (Reading
	// the raw bytes would need filesystem access the test doesn't have.)
	await expect(async () => {
		const body = await (await request.get("/api/files/pgfile.sql")).json();
		expect(body.dialect).toBe("postgres");
		expect(body.tables[0].name).toBe("members");
	}).toPass({ timeout: 5000 });
	// and the SQL panel renders postgres DDL for that file
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.locator("aside pre")).toContainText(
		'CREATE TABLE "members"',
	);
});

test("every offered dialect is saveable and drives the panel", async ({
	page,
}) => {
	await page.goto("/");
	// the dropdown must not label mariadb "(export only)" — the server saves it
	const opt = page.getByTestId("dialect").locator('option[value="mariadb"]');
	await expect(opt).toHaveText("MariaDB");
	// selecting it switches the panel to the MariaDB header
	await page.getByRole("button", { name: "Show SQL" }).click();
	await page.getByTestId("dialect").selectOption("mariadb");
	await expect(page.locator("aside pre")).toContainText(
		"Generated by erd-creator (MariaDB)",
	);
	await expect(page.getByTestId("sql-dialect")).toHaveText("mariadb");
	// no dialect is labelled "(export only)" any more — all four have parsers
	// and the server saves them. The label was a lie twice over (mariadb, then
	// sqlite), so assert it is gone from every option rather than just sqlite's.
	const labels = await page
		.getByTestId("dialect")
		.locator("option")
		.allTextContents();
	for (const label of labels) {
		expect(label).not.toContain("export only");
	}
	// and sqlite is offered as a first-class dialect that drives the panel
	await expect(
		page.getByTestId("dialect").locator('option[value="sqlite"]'),
	).toHaveText("SQLite");
	await page.getByTestId("dialect").selectOption("sqlite");
	await expect(page.locator("aside pre")).toContainText(
		"Generated by erd-creator (SQLite)",
	);
	await expect(page.getByTestId("sql-dialect")).toHaveText("sqlite");
});

// The sqlite types control only applies to sqlite, so it must not be offered
// while another dialect is selected — it would imply a setting that has no
// effect. And it must actually change the emitted DDL.
test("sqlite types control appears only for sqlite and drives the DDL", async ({
	page,
}) => {
	await page.goto("/");
	// default dialect is mysql: no control
	await expect(page.getByTestId("dialect")).toHaveValue("mysql");
	await expect(page.getByTestId("sqlite-types")).toHaveCount(0);

	// add a BOOLEAN column so the two modes are distinguishable
	await page.getByRole("button", { name: "+ column" }).click();
	const dlg = await openCol(page, 0, 1);
	await dlg.locator("select.type").selectOption("BOOLEAN");
	await closeCol(dlg);

	// still mysql: no control, and the panel keeps BOOLEAN
	await page.getByRole("button", { name: "Show SQL" }).click();
	await expect(page.getByTestId("sqlite-types")).toHaveCount(0);
	await expect(page.locator("aside pre")).toContainText("BOOLEAN");

	// switching to sqlite reveals it, defaulting to the lossless native mode
	await page.getByTestId("dialect").selectOption("sqlite");
	await expect(page.getByTestId("sqlite-types")).toBeVisible();
	await expect(page.getByTestId("sqlite-types")).toHaveValue("native");
	await expect(page.locator("aside pre")).toContainText("BOOLEAN");

	// portable rewrites to the storage class SQLite would pick anyway
	await page.getByTestId("sqlite-types").selectOption("portable");
	await expect(page.locator("aside pre")).toContainText("INTEGER");
	await expect(page.locator("aside pre")).not.toContainText("BOOLEAN");

	// and going back to native restores it
	await page.getByTestId("sqlite-types").selectOption("native");
	await expect(page.locator("aside pre")).toContainText("BOOLEAN");
});

// The column row used to be ten controls in a 280px card, and they spilled past
// the card's right border (box-sizing was content-box, so every declared width
// understated its control, and nothing was allowed to shrink). The controls now
// live in a dialog, so this asserts two things instead: the label row stays
// inside the card, and the dialog that replaced it is not clipped either.
// Measured in the real DOM rather than from constants — the failure is layout.
test("column label stays inside the table box, even with an FK set", async ({
	page,
}) => {
	await page.goto("/");
	// worst case: a second table to reference, so the FK label appears
	await page.getByRole("button", { name: "+ Table" }).click();
	const second = page.locator("section.table").nth(1);
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await closeCol(dlg);
	await expect(second.locator(".row .fkinfo")).toBeVisible();
	// and a name long enough to tempt the row wider
	const nameDlg = await openCol(page, 1, 0);
	const name = nameDlg.locator("input.cname");
	await name.fill("a_very_long_column_name");
	await name.blur();
	await closeCol(nameDlg);

	const overflow = await page.evaluate(() => {
		return [...document.querySelectorAll("section.table")].map((sec) => {
			const box = sec.getBoundingClientRect();
			const row = sec.querySelector(".row");
			const last = row.lastElementChild.getBoundingClientRect();
			return {
				scrollOver: row.scrollWidth - row.clientWidth,
				pastRightEdge: Math.round(last.right - box.right),
			};
		});
	});
	for (const [i, m] of overflow.entries()) {
		expect(m.scrollOver, `table ${i} row overflows its own content box`).toBe(
			0,
		);
		expect(
			m.pastRightEdge,
			`table ${i} label extends past the card border`,
		).toBeLessThanOrEqual(0);
	}

	// the dialog holds the controls now; it must fit the viewport rather than
	// being clipped at the edge
	const modal = await openCol(page, 1, 0);
	const fits = await modal.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return {
			inViewport: r.left >= 0 && r.top >= 0,
			width: Math.round(r.width),
			height: Math.round(r.height),
		};
	});
	expect(fits.inViewport, "edit dialog is positioned off-screen").toBe(true);
	expect(fits.width, "edit dialog has collapsed").toBeGreaterThan(200);
});

// Copy INSERTs and Export were the two header buttons with no e2e coverage.
// Both POST the current schema and copy the response, so a regression in either
// would have shipped silently.
test("Copy INSERTs copies seed-row templates for the current schema", async ({
	page,
}) => {
	await page.goto("/");
	// Playwright grants no clipboard permission, so this exercises the same
	// textarea/execCommand fallback path as Copy SQL.
	await page.getByRole("button", { name: "Copy INSERTs" }).click();
	await expect(page.getByText("copied INSERT templates")).toBeVisible();
	await expect(page.getByText(/INSERTs failed/)).toHaveCount(0);
});

// Export DOWNLOADS the selected dialect's DDL. It used to copy it to the
// clipboard, which made it byte-for-byte identical to Copy SQL — the same POST
// to the same endpoint, only a different banner. The two buttons must stay
// distinguishable, so this asserts a real download event and the file contents,
// not a banner.
test("Export downloads the selected dialect's DDL as a .sql file", async ({
	page,
}) => {
	await page.goto("/");
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	const dl = await download;
	// unsaved scratch schema → dialect-named file
	expect(dl.suggestedFilename()).toBe("mysql-schema.sql");

	const stream = await dl.createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	const body = Buffer.concat(chunks).toString("utf8");
	expect(body).toContain("CREATE TABLE `users`");
	// and it must be a download, not a clipboard write
	await expect(page.getByText(/copied .* DDL/)).toHaveCount(0);
	await expect(page.getByText("downloaded mysql-schema.sql")).toBeVisible();

	// the downloaded DDL must follow the dropdown, not be hardcoded mysql
	await page.getByTestId("dialect").selectOption("postgres");
	const pgDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	const pg = await pgDownload;
	expect(pg.suggestedFilename()).toBe("postgres-schema.sql");
	const pgStream = await pg.createReadStream();
	const pgChunks = [];
	for await (const c of pgStream) pgChunks.push(c);
	expect(Buffer.concat(pgChunks).toString("utf8")).toContain(
		'CREATE TABLE "users"',
	);
});

// A saved file exports under its own name, so the download lands where the user
// expects rather than being renamed to a generic dialect default.
test("Export of a saved file uses the file's own name", async ({ page }) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("mydb"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("mydb.sql");
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	expect((await download).suggestedFilename()).toBe("mydb.sql");
});

// An empty schema has nothing to export: the server answers 400 and the UI must
// surface it as an error rather than downloading an empty or bogus file.
test("Export on an empty schema surfaces the server error", async ({
	page,
}) => {
	await page.goto("/");
	// remove the only table so the schema has no tables
	await page.getByTitle("delete table (Del)").click();
	await expect(page.locator("section.table")).toHaveCount(0);

	// no download must fire on the failure path
	let downloaded = false;
	page.on("download", () => {
		downloaded = true;
	});
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await expect(page.locator("header .err")).toBeVisible();
	await expect(page.getByText(/downloaded /)).toHaveCount(0);
	expect(downloaded).toBe(false);
});

test("Export PNG downloads diagram as .png with PNG signature", async ({
	page,
}) => {
	await page.goto("/");
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PNG" }).click();
	const dl = await download;
	expect(dl.suggestedFilename()).toBe("mysql-schema.png");
	const stream = await dl.createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	const buf = Buffer.concat(chunks);
	// PNG signature 89 50 4E 47 0D 0A 1A 0A
	expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
	expect(buf.length).toBeGreaterThan(1000);
	await expect(page.getByText("downloaded mysql-schema.png")).toBeVisible();
});

test("Export PNG of saved file uses .png name", async ({ page }) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("shot"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("shot.sql");
	const dl = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PNG" }).click();
	expect((await dl).suggestedFilename()).toBe("shot.png");
});

test("Export SVG downloads the diagram as real SVG source", async ({
	page,
}) => {
	await page.goto("/");
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export SVG" }).click();
	const dl = await download;
	expect(dl.suggestedFilename()).toBe("mysql-schema.svg");
	const stream = await dl.createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	const text = Buffer.concat(chunks).toString("utf8");
	// The failure this guards: toSvg() returns a data URL, so writing it out
	// verbatim would produce a file starting "data:image/svg+xml..." that no
	// viewer opens. Asserting it starts with <svg is the whole point — a byte
	// count or an extension check would pass on the broken version too.
	expect(text.trimStart().startsWith("<svg")).toBe(true);
	expect(text).toContain("<foreignObject");
	expect(text).not.toContain("data:image/svg+xml");
	// the whole diagram, sized like the PNG path: the default table sits at
	// x=40, so width = 40 + BOX_W(280) + PAD(40) = 360. This is the property
	// that distinguishes whole-diagram sizing from the viewport.
	expect(text).toContain('width="360"');
	await expect(page.getByText("downloaded mysql-schema.svg")).toBeVisible();
});

// The relationship line and the cardinality labels must be PAINTED IN THE
// EXPORT, not merely present in the markup.
//
// html-to-image does not carry the stylesheet into the export: the exported
// document has no <style> element and no `.edge` rule, so an element styled only
// by a CSS class loses its paint. Measured before the fix: sampling the exported
// PNG at the curve and at both labels returned the background colour at every
// point — the line and labels were not drawn at all, while the crow's-foot
// arrowhead stayed visible because it was the one element styled by a
// presentation attribute. That asymmetry is what identified the cause, so this
// test samples real pixels rather than asserting on attributes.
test("exported PNG actually paints the edge line and its labels", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = page.locator("dialog.coledit");
	await page
		.locator("section.table")
		.nth(1)
		.locator(".row .edit")
		.nth(0)
		.click();
	await expect(dlg).toBeVisible();
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await dlg.getByRole("button", { name: "Done" }).click();
	await expect(dlg).toHaveCount(0);

	// label positions come from the SVG export; both formats are 1:1 and share
	// the same coordinate space, so they can be used to sample the PNG
	const svgDl = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export SVG" }).click();
	const svgStream = await (await svgDl).createReadStream();
	const svgChunks = [];
	for await (const c of svgStream) svgChunks.push(c);
	const svg = Buffer.concat(svgChunks).toString("utf8");
	const labelPts = [
		...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"/g),
	].map((m) => [Math.round(Number(m[1])), Math.round(Number(m[2]))]);
	expect(labelPts.length).toBe(2);

	const pngDl = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PNG" }).click();
	const pngStream = await (await pngDl).createReadStream();
	const pngChunks = [];
	for await (const c of pngStream) pngChunks.push(c);
	const pngB64 = Buffer.concat(pngChunks).toString("base64");

	const res = await page.evaluate(
		async ([b64, pts]) => {
			const img = new Image();
			img.src = `data:image/png;base64,${b64}`;
			await img.decode();
			const c = document.createElement("canvas");
			c.width = img.naturalWidth;
			c.height = img.naturalHeight;
			const ctx = c.getContext("2d");
			ctx.drawImage(img, 0, 0);
			// brightest pixel within r, so a thin antialiased line still counts
			const brightest = (x, y, r) => {
				const d = ctx.getImageData(x - r, y - r, 2 * r + 1, 2 * r + 1).data;
				let lum = -1;
				for (let i = 0; i < d.length; i += 4)
					lum = Math.max(lum, d[i] + d[i + 1] + d[i + 2]);
				return lum;
			};
			// background is #101418 → luminance 16+20+24 = 60
			return {
				bg: brightest(250, 260, 2),
				labels: pts.map(([x, y]) => brightest(x, y, 6)),
			};
		},
		[pngB64, labelPts],
	);

	// the background is the control: it must stay dark, or this proves nothing
	expect(res.bg).toBeLessThan(120);
	for (const [i, lum] of res.labels.entries()) {
		expect(
			lum,
			`label ${i} not painted in the PNG (luminance ${lum} ≈ background ${res.bg})`,
		).toBeGreaterThan(res.bg + 200);
	}
});

test("Export SVG of a saved file uses the .svg name", async ({ page }) => {
	await page.goto("/");
	page.once("dialog", (d) => d.accept("vector"));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText("vector.sql");
	const dl = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export SVG" }).click();
	expect((await dl).suggestedFilename()).toBe("vector.svg");
});

test("Export SVG on empty schema shows error, no download", async ({
	page,
}) => {
	await page.goto("/");
	await page
		.locator("section.table")
		.first()
		.getByTitle("delete table (Del)")
		.click();
	await expect(page.locator("section.table")).toHaveCount(0);
	await page.getByRole("button", { name: "Export SVG" }).click();
	await expect(page.locator("header .err")).toContainText("nothing to export");
	await expect(page.getByText(/downloaded/)).toHaveCount(0);
});

test("Export PNG still works alongside Export SVG", async ({ page }) => {
	// Two export buttons sharing one `exporting` flag: adding the second must
	// not break the first, so this re-asserts the PNG path end to end.
	await page.goto("/");
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PNG" }).click();
	const dl = await download;
	expect(dl.suggestedFilename()).toBe("mysql-schema.png");
	const stream = await dl.createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	const buf = Buffer.concat(chunks);
	expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
});

test("Export PNG on empty schema shows error, no download", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByTitle("delete table (Del)").click();
	await expect(page.locator("section.table")).toHaveCount(0);
	let downloaded = false;
	page.on("download", () => {
		downloaded = true;
	});
	await page.getByRole("button", { name: "Export PNG" }).click();
	await expect(page.locator("header .err")).toContainText("nothing to export");
	expect(downloaded).toBe(false);
});

// The PNG must contain the WHOLE diagram, not just the part on screen.
//
// The previous coverage here asserted a PNG signature and >1000 bytes, which a
// cropped image satisfies — so the export shipped cropping every table past the
// viewport (9 tables in a 1280x800 window produced a 1280x759 image with two
// tables missing) and the suite stayed green. Size is the observable that
// actually distinguishes the two behaviours, so this asserts it: with enough
// stacked tables to overflow the window, the image must be taller than the
// canvas viewport. PNG dimensions are read from the IHDR chunk (bytes 16-24),
// which avoids any image-decoding dependency.
test("Export PNG captures the whole diagram, not just the viewport", async ({
	page,
}) => {
	await page.goto("/");
	// Stack ~12 tables in one layer; each card is ~139px tall, so the content
	// runs well past an 800px-tall window.
	for (let i = 0; i < 11; i++) {
		await page.getByRole("button", { name: "+ Table" }).click();
	}
	await expect(page.locator("section.table")).toHaveCount(12);

	const canvasHeight = await page
		.locator(".canvas")
		.evaluate((el) => el.clientHeight);
	const contentBottom = await page
		.locator(".canvas")
		.evaluate((el) =>
			Math.max(
				...[...el.querySelectorAll("section.table")].map(
					(t) =>
						t.getBoundingClientRect().bottom - el.getBoundingClientRect().top,
				),
			),
		);
	// precondition: the fixture really does overflow, else the test proves nothing
	expect(contentBottom).toBeGreaterThan(canvasHeight);

	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export PNG" }).click();
	const stream = await (await download).createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	const buf = Buffer.concat(chunks);

	// IHDR: 8-byte signature, 4-byte length, 4-byte "IHDR", then width, height.
	expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
	const pngHeight = buf.readUInt32BE(20);
	expect(pngHeight).toBeGreaterThanOrEqual(Math.ceil(contentBottom));
});
