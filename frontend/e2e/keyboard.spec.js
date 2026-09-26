// Keyboard surface: App.svelte's window onKey handler. These pin the wiring
// that the mouse tests cannot reach: arrow-key nudging (plain and Shift+),
// Escape deselect, Backspace delete, and the guard that hands the keyboard to
// an open dialog instead of acting on the canvas.
import { expect, test } from "@playwright/test";
import { selectTable, wipeStore } from "./helpers.js";

test.beforeEach(async ({ request }) => {
	await wipeStore(request);
});

test("arrow keys nudge the selected table; Shift doubles the step", async ({
	page,
}) => {
	await page.goto("/");
	await selectTable(page, 0);

	const left = () =>
		page
			.locator("section.table")
			.nth(0)
			.evaluate((el) => el.style.left);
	const top = () =>
		page
			.locator("section.table")
			.nth(0)
			.evaluate((el) => el.style.top);

	const beforeLeft = await left();
	await page.keyboard.press("ArrowRight");
	await expect.poll(left).toBe(`${parseInt(beforeLeft, 10) + 10}px`);

	const beforeTop = await top();
	await page.keyboard.press("Shift+ArrowDown");
	await expect.poll(top).toBe(`${parseInt(beforeTop, 10) + 20}px`);
});

test("arrow keys do not move an unselected table", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	const second = page.locator("section.table").nth(1);
	const before = await second.evaluate((el) => el.style.left);
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => second.evaluate((el) => el.style.left)).toBe(before);
});

test("Escape clears the selection; clicking reselects", async ({ page }) => {
	await page.goto("/");
	await selectTable(page, 0);
	await page.keyboard.press("Escape");
	await expect(page.locator("section.table.selected")).toHaveCount(0);
	await selectTable(page, 0);
	await expect(page.locator("section.table.selected")).toHaveCount(1);
});

test("Backspace deletes the selected table (same guard as Delete)", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	await selectTable(page, 1);
	await page.keyboard.press("Backspace");
	await expect(page.locator("section.table")).toHaveCount(1);
});

test("Escape inside the column dialog closes it, not the selection", async ({
	page,
}) => {
	await page.goto("/");
	await selectTable(page, 0);
	await page
		.locator("section.table")
		.nth(0)
		.locator(".row .edit")
		.first()
		.click();
	const dlg = page.locator("dialog.coledit");
	await expect(dlg).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dlg).toHaveCount(0);
	await expect(page.locator("section.table")).toHaveCount(1);
	// the selection survives: the dialog closed, the card did not get deleted
	await expect(page.locator("section.table.selected")).toHaveCount(1);
});
