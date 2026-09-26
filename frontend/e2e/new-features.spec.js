// ---- column DEFAULT + table comment + lint panel + theme ----
import { expect, test } from "@playwright/test";
import {
	awaitFile,
	closeCol,
	downloadBytes,
	newFile,
	openCol,
	panelSql,
	wipeStore,
} from "./helpers.js";

// Each test starts from an empty schema store.
test.beforeEach(async ({ request }) => {
	await wipeStore(request);
});

test("column DEFAULT: set, autosave, SQL, reload", async ({
	page,
	request,
}) => {
	await page.goto("/");
	await newFile(page, "def");

	// add a column and set ITS default — the default id column is AI, and
	// AI + DEFAULT is refused (the next test pins that refusal)
	await page.getByRole("button", { name: "+ column" }).click();
	const dlg = await openCol(page, 0, 1);
	await dlg.locator("input.dflt").fill("CURRENT_TIMESTAMP");
	await dlg.locator("input.dflt").blur();
	await closeCol(dlg);

	// autosave persists it in the file JSON (columns[1] = the new column)
	await awaitFile(request, "def.sql", (_b) => {
		expect(_b.tables[0].columns[1].default).toBe("CURRENT_TIMESTAMP");
	});

	// the SQL panel shows the clause (mysql = schema dialect)
	expect(await panelSql(page)).toContain("DEFAULT CURRENT_TIMESTAMP");

	// reload keeps the value in the dialog and the DDL
	await page.reload();
	const dlg2 = await openCol(page, 0, 1);
	await expect(dlg2.locator("input.dflt")).toHaveValue("CURRENT_TIMESTAMP");
	await closeCol(dlg2);
});

test("AI + DEFAULT is refused client-side with a flash", async ({ page }) => {
	await page.goto("/");
	const dlg = await openCol(page, 0, 0); // users.id is AI
	await dlg.locator("input.dflt").fill("0");
	await dlg.locator("input.dflt").blur(); // commit on change
	await expect(page.getByTestId("toast").first()).toContainText(
		"auto-increment",
	);
	// the input reverts: no default was stored
	await expect(dlg.locator("input.dflt")).toHaveValue("");
	await closeCol(dlg);
});

test("table comment: set through the table dialog, emitted, round-trips", async ({
	page,
	request,
}) => {
	await page.goto("/");
	await newFile(page, "tc");

	await page.getByRole("button", { name: /composite indexes for/ }).click();
	const dlg = page.locator("dialog.idxedit");
	await dlg.locator("input.tcmt").fill("the users table");
	await dlg.getByRole("button", { name: "Done" }).click();
	await expect(dlg).toHaveCount(0);

	await awaitFile(request, "tc.sql", (_b) => {
		expect(_b.tables[0].comment).toBe("the users table");
	});

	// mysql emits it as a table option
	expect(await panelSql(page)).toContain("COMMENT='the users table'");

	// the card carries it as a tooltip, and a reload keeps everything
	await expect(page.locator("section.table").first()).toHaveAttribute(
		"title",
		"the users table",
	);
	await page.reload();
	expect(await panelSql(page)).toContain("COMMENT='the users table'");
});

test("lint panel lists findings and jumps to the offending table", async ({
	page,
}) => {
	await page.goto("/");
	// a type-mismatch FK: table1.id is VARCHAR by default? no — a new table's
	// first column is INT pk ai (same as users.id), so change its type first
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.type").selectOption("VARCHAR");
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await closeCol(dlg);

	// the toast already flashes one; the panel shows the durable list
	await page.getByTestId("lint-toggle").click();
	const aside = page.locator("aside[aria-label='lint findings']");
	await expect(aside.locator("[data-testid=lint-list] li")).toHaveCount(1);
	await expect(aside.locator("li")).toContainText("vs");

	// clicking a row selects + scrolls to that table
	await aside.locator("li button").click();
	await expect(page.locator("section.table.selected .tname")).toHaveValue(
		"table1",
	);
});

test("theme toggle flips html[data-theme] and persists across reload", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

	await page.getByTestId("theme-toggle").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

// The SVG export embeds the paint as presentation attributes — the light
// constants from geometry.js must actually reach the file, or a light-theme
// export would render with the dark palette jammed on a white background.
test("light-theme SVG export carries the light paint constants", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByTestId("theme-toggle").click();

	const { buf } = await downloadBytes(page, "Export SVG");
	const svg = buf.toString("utf8");
	// the crow marker always carries the theme edge stroke
	expect(svg).toContain("#5b83a5"); // EDGE_STROKE_LIGHT
	expect(svg).not.toContain("#7fa3c0"); // dark EDGE_STROKE must not leak
});

test("lint panel shows a clean state when there are no findings", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByTestId("lint-toggle").click();
	const aside = page.locator("aside[aria-label='lint findings']");
	await expect(aside.getByTestId("lint-clean")).toHaveText("no issues");
	await expect(aside.getByTestId("lint-list")).toHaveCount(0);
});

// Column order IS the DDL order, so ↑/↓ in the dialog must move both the card
// rows and the emitted CREATE TABLE column list.
test("column ↑ reorders the DDL and the card rows", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ column" }).click(); // id, column
	await page.getByRole("button", { name: "Show SQL" }).click();
	const sql = page.locator("aside pre");
	await expect(sql).toContainText(/`id` INT/);

	// move the second column up
	const dlg = await openCol(page, 0, 1);
	await dlg.getByRole("button", { name: "move column up" }).click();
	await closeCol(dlg);

	// card rows follow the new order
	const rows = page.locator("section.table .row .cname");
	await expect(rows.nth(0)).toHaveText("column");
	await expect(rows.nth(1)).toHaveText("id");
	// and the emitted DDL opens with the moved column
	await expect(sql).toContainText(/`column` VARCHAR/);
	await expect(sql).toContainText(/`id` INT/);
});

test("rename + duplicate file round-trip through the store", async ({
	page,
	request,
}) => {
	await page.goto("/");
	await newFile(page, "orig");

	// rename via the prompt
	page.once("dialog", (d) => d.accept("renamed"));
	await page.getByRole("button", { name: "Rename file" }).click();
	await expect(page.getByTestId("current-file")).toHaveText("renamed.sql");
	await expect(async () => {
		expect((await request.get("/api/files/renamed.sql")).ok()).toBe(true);
		expect((await request.get("/api/files/orig.sql")).ok()).toBe(false);
	}).toPass({ timeout: 5000 });

	// duplicate, accepting the derived name explicitly (dialog.accept() with
	// no value yields an empty prompt — the copy would be silently cancelled)
	page.once("dialog", (d) => d.accept("renamed_copy.sql"));
	await page.getByRole("button", { name: "Duplicate file" }).click();
	await expect(page.getByTestId("current-file")).toHaveText("renamed.sql");
	await expect(async () => {
		expect((await request.get("/api/files/renamed_copy.sql")).ok()).toBe(true);
	}).toPass({ timeout: 5000 });
	// both files listed in the dropdown
	await expect(
		page.getByLabel("Open schema file").locator("option"),
	).toContainText(["renamed.sql", "renamed_copy.sql"]);
});
