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

test("FK type mismatch surfaces server lint in header", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	// second table, first row FK → users
	const fk = page.locator("section.table").nth(1).locator("select.fk").first();
	await fk.selectOption({ index: 1 });
	// clear FK, change type to VARCHAR (type select is the non-FK select)
	await fk.selectOption("");
	const typeSel = page
		.locator("section.table")
		.nth(1)
		.locator(".row")
		.first()
		.locator("select")
		.first();
	await typeSel.selectOption("VARCHAR"); // becomes VARCHAR(255)
	await fk.selectOption({ index: 1 });
	await expect(page.locator("header .warn")).toContainText("vs", {
		timeout: 5000,
	});
});

test("table delete × removes box and clears dangling FKs", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	await page
		.locator("section.table")
		.nth(1)
		.locator("select.fk")
		.first()
		.selectOption({ index: 1 });
	await page
		.locator("section.table")
		.first()
		.getByTitle("delete table (Del)")
		.click();
	await expect(page.locator("section.table")).toHaveCount(1);
	await expect(
		page.locator("section.table").locator("select.fk").first(),
	).toHaveValue("");
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
	// duplicated column retains type
	const dupType = page
		.locator("section.table")
		.nth(1)
		.locator("select")
		.first();
	await expect(dupType).toHaveValue("INT");
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
	await page.locator("section.table .rmcol").nth(1).click();
	await expect(page.locator("section.table .row")).toHaveCount(1);
	// removing last column should flash error, row stays 1
	await page.locator("section.table .rmcol").first().click();
	await expect(page.locator("section.table .row")).toHaveCount(1);
	await expect(page.locator("header .err")).toContainText(
		"needs at least one column",
	);
});

test("PK toggle forces NN and clears on untoggle", async ({ page }) => {
	await page.goto("/");
	// users.id starts pk=true, nn disabled checked
	const pk = page
		.locator("section.table label")
		.filter({ hasText: "PK" })
		.locator("input")
		.first();
	const nn = page
		.locator("section.table label")
		.filter({ hasText: /^NN/ })
		.locator("input")
		.first();
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
	const cmt = page.locator("section.table .cmt input").first();
	await cmt.fill("hello comment");
	await cmt.blur();
	await expect(async () => {
		const body = await (await request.get("/api/files/cmt.sql")).text();
		expect(body).toContain("hello comment");
	}).toPass({ timeout: 5000 });
	await page.reload();
	await expect(page.locator("section.table .cmt input").first()).toHaveValue(
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
	await page.locator(".cname").first().fill("col_renamed");
	await page.locator(".cname").first().blur();
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

test("mariadb is offered as saveable and drives the panel", async ({
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
	// and the only export-only entry is sqlite
	await expect(
		page.getByTestId("dialect").locator('option[value="sqlite"]'),
	).toHaveText("SQLite (export only)");
});

// The column row is dense: name, type, five flag checkboxes, FK select, action
// select and the remove button — ten flex children in a 280px card. They used
// to spill outside the card's right border, because box-sizing was left at
// content-box (so the declared widths understated every control) and nothing
// was allowed to shrink. Measured in the real DOM rather than asserted from
// constants, since the failure is a layout one.
test("column controls stay inside the table box, even with an FK set", async ({
	page,
}) => {
	await page.goto("/");
	// worst case: a second table to reference, so the FK + action selects appear
	await page.getByRole("button", { name: "+ Table" }).click();
	const second = page.locator("section.table").nth(1);
	await second.locator("select.fk").selectOption({ index: 1 });
	await expect(second.locator("select.act")).toBeVisible();
	// and a name long enough to tempt the row wider
	const name = second.locator(".cname").first();
	await name.fill("a_very_long_column_name");
	await name.blur();

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
			`table ${i} controls extend past the card border`,
		).toBeLessThanOrEqual(0);
	}
});
