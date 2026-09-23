// Dialog surface: flags, types, FK dropdown — the per-column controls that
// moved into ColumnEditModal. These pin the DIALOG's behavior against the real
// server: what a toggle does in the DDL, what the type list offers, and what
// the FK select excludes (its own table — a self-ref is a file-only pattern).
import { expect, test } from "@playwright/test";

// Each test starts from an empty schema store.
test.beforeEach(async ({ request }) => {
	const res = await request.get("/api/files");
	for (const f of await res.json()) {
		await request.delete(`/api/files/${f.name}`);
	}
});

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

async function closeCol(dlg) {
	await dlg.getByRole("button", { name: "Done" }).click();
	await expect(dlg).toHaveCount(0);
}

// Open the SQL panel and return its text once loaded (the panel renders a
// skeleton while the export is in flight, then the DDL).
async function panelSql(page) {
	await page.getByRole("button", { name: "Show SQL" }).click();
	const pre = page.locator("#sql-panel pre");
	await expect(pre).toBeVisible();
	return pre.innerText();
}

// The default column (id INT PK NN AI) has NN disabled by its PK, so flag
// tests use a freshly added column: `column VARCHAR(255)`, all flags off.
async function addPlainColumn(page, tableIndex = 0) {
	await page
		.locator("section.table")
		.nth(tableIndex)
		.getByRole("button", { name: "+ column" })
		.click();
	return openCol(page, tableIndex, 1);
}

test("NN/UQ/IX flag toggles drive the DDL from a plain column", async ({
	page,
}) => {
	await page.goto("/");
	const dlg = await addPlainColumn(page);
	await dlg.getByLabel("NN").check();
	await dlg.getByLabel("UQ").check();
	await dlg.getByLabel("IX").check();
	await dlg.locator("input.cname").fill("slug");
	await closeCol(dlg);

	const sql = await panelSql(page);
	expect(sql).toContain("`slug` VARCHAR(255) NOT NULL UNIQUE");
	expect(sql).toContain("KEY `idx_users_slug` (`slug`)");
});

test("AI applies only to integer types; checkbox disabled otherwise", async ({
	page,
}) => {
	await page.goto("/");
	const dlg = await addPlainColumn(page);
	// default type VARCHAR is not an int → AI disabled
	await expect(dlg.getByLabel("AI")).toBeDisabled();
	await dlg.locator("select.type").selectOption("INT");
	await expect(dlg.getByLabel("AI")).toBeEnabled();
	await dlg.getByLabel("AI").check();
	await closeCol(dlg);
	expect(await panelSql(page)).toContain("AUTO_INCREMENT");
});

test("type list offers the documented types and emits JSON verbatim", async ({
	page,
}) => {
	await page.goto("/");
	const dlg = await openCol(page);
	const options = await dlg.locator("select.type option").allTextContents();
	for (const want of [
		"INT",
		"BIGINT",
		"DECIMAL",
		"VARCHAR",
		"BOOLEAN",
		"DATETIME",
		"JSON",
		"ENUM",
	]) {
		expect(options).toContain(want);
	}
	await dlg.locator("select.type").selectOption("JSON");
	await closeCol(dlg);
	expect(await panelSql(page)).toContain("JSON");
});

test("ENUM type prompts for values and emits ENUM('a','b')", async ({
	page,
}) => {
	await page.goto("/");
	const dlg = await openCol(page);
	page.once("dialog", (d) => d.accept("'a','b'"));
	await dlg.locator("select.type").selectOption("ENUM");
	await closeCol(dlg);
	expect(await panelSql(page)).toContain("ENUM('a','b')");
});

test("FK dropdown excludes the column's own table", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	const names = await dlg.locator("select.fk option").allTextContents();
	expect(names).not.toContain("table1"); // own table absent
	expect(names).toContain("users"); // the other table is offered
	await closeCol(dlg);
});

test("relationship section edits type and deletes the edge without dropping the column", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();

	// create the FK through the column dialog: the default new column is
	// id/INT/PK/AI, and a sole PK is unique — so the edge reads 1:1 even
	// though no UQ flag is set (relKind reads ux only, the legend tells truth)
	let dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await expect(dlg.locator("fieldset.rel legend")).toContainText("0..1 / 1..1");
	await closeCol(dlg);
	await expect(page.locator("svg path.edge")).toHaveCount(1);

	// edit: clear PK (sole-PK uniqueness goes), then the radio 1:N ↔ 1:1
	// flips UQ and the edge label follows
	dlg = await openCol(page, 1, 0);
	await dlg.locator("label").filter({ hasText: "PK" }).locator("input").click();
	await expect(dlg.locator("fieldset.rel legend")).toContainText("0..N / 1..1");
	await dlg.locator('[data-testid="rel-kind-11"]').click();
	await expect(dlg.locator("fieldset.rel legend")).toContainText("0..1 / 1..1");
	await expect(page.locator("svg text.card").first()).toContainText("0..1");
	await closeCol(dlg);

	// delete: Remove relationship clears the FK, keeps the column
	dlg = await openCol(page, 1, 0);
	await dlg.getByTestId("rel-remove").click();
	await expect(dlg.locator("fieldset.rel")).toHaveCount(0);
	await closeCol(dlg);
	await expect(page.locator("svg path.edge")).toHaveCount(0);
	await expect(
		page.locator("section.table").nth(1).locator(".row"),
	).toHaveCount(1);
});
