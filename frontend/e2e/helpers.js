// e2e/helpers.js — shared Playwright harnesses. Extracted from copy-paste
// across app.spec.js, dialog.spec.js, keyboard.spec.js, new-features.spec.js:
// openCol/closeCol was byte-identical in 3 files, store-wipe beforeEach in 4,
// new-file-via-prompt ~15x, autosave-poll ~13x, download-drain ~8x.
import { expect } from "@playwright/test";

// Each test starts from an empty schema store.
export async function wipeStore(request) {
	const res = await request.get("/api/files");
	for (const f of await res.json()) {
		await request.delete(`/api/files/${f.name}`);
	}
}

// Open the edit dialog for a column and return it. Every per-column control
// lives in this HTML <dialog> (not a JS dialog: no Playwright "dialog"
// event, which stays reserved for prompt()/confirm()).
export async function openCol(page, tableIndex = 0, colIndex = 0) {
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
export async function closeCol(dlg) {
	await dlg.getByRole("button", { name: "Done" }).click();
	await expect(dlg).toHaveCount(0);
}

// Open the SQL panel and return its text once loaded (skeleton first, DDL
// after the export lands).
export async function panelSql(page) {
	await page.getByRole("button", { name: "Show SQL" }).click();
	const pre = page.locator("#sql-panel pre");
	await expect(pre).toBeVisible();
	return pre.innerText();
}

// Create a new file via the native prompt.
export async function newFile(page, name) {
	page.once("dialog", (d) => d.accept(name));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await expect(page.getByTestId("current-file")).toHaveText(`${name}.sql`);
}

// Poll until the saved file satisfies pred (autosave debounce window).
export async function awaitFile(request, name, pred) {
	await expect(async () => {
		const body = await (await request.get(`/api/files/${name}`)).json();
		pred(body);
	}).toPass({ timeout: 5000 });
}

// Click an export button and return the download and its bytes.
export async function downloadBytes(page, buttonName) {
	const dlPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: buttonName }).click();
	const dl = await dlPromise;
	const stream = await dl.createReadStream();
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	return { dl, buf: Buffer.concat(chunks) };
}

// Add a second table and set its first column as FK to the first table.
export async function addTableWithFk(page) {
	await page.getByRole("button", { name: "+ Table" }).click();
	const dlg = await openCol(page, 1, 0);
	await dlg.locator("select.fk").selectOption({ index: 1 });
	await closeCol(dlg);
}

// Set a column's FK target by dropdown index.
export async function setFk(page, tableIndex, colIndex, optionIndex = 1) {
	const dlg = await openCol(page, tableIndex, colIndex);
	await dlg.locator("select.fk").selectOption({ index: optionIndex });
	await closeCol(dlg);
}

// Select a table via real mouse press on its header, then defocus so the
// onKey handler (guarded by !editing) receives keys instead of the input.
export async function selectTable(page, i = 0) {
	const box = await page
		.locator("section.table")
		.nth(i)
		.locator(".hdr")
		.boundingBox();
	await page.mouse.move(box.x + 30, box.y + 8);
	await page.mouse.down();
	await page.mouse.up();
	await page.locator("body").click({ position: { x: 5, y: 400 } }); // defocus
	await expect(page.locator("section.table").nth(i)).toHaveClass(/selected/);
}
