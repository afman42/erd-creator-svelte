// Keyboard surface: App.svelte's window onKey handler. These pin the wiring
// that the mouse tests cannot reach: arrow-key nudging (plain and Shift+),
// Escape deselect, Backspace delete, and the guard that hands the keyboard to
// an open dialog instead of acting on the canvas.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
	const res = await request.get("/api/files");
	for (const f of await res.json()) {
		await request.delete(`/api/files/${f.name}`);
	}
});

// Select a table with a real mouse press on its header (matches the repo's
// existing selection test: press on .hdr without moving marks it selected,
// because a <4px pointer delta is a click, not a drag). The header click lands
// on the name INPUT, so focus is blurred afterwards — otherwise every key the
// onKey handler guards with `!editing` (arrows, Backspace) is swallowed by
// the input instead of acting on the canvas.
async function select(page, i = 0) {
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

test("arrow keys nudge the selected table; Shift doubles the step", async ({
	page,
}) => {
	await page.goto("/");
	await select(page, 0);

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
	await select(page, 0);
	await page.keyboard.press("Escape");
	await expect(page.locator("section.table.selected")).toHaveCount(0);
	await select(page, 0);
	await expect(page.locator("section.table.selected")).toHaveCount(1);
});

test("Backspace deletes the selected table (same guard as Delete)", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "+ Table" }).click();
	await select(page, 1);
	await page.keyboard.press("Backspace");
	await expect(page.locator("section.table")).toHaveCount(1);
});

test("Escape inside the column dialog closes it, not the selection", async ({
	page,
}) => {
	await page.goto("/");
	await select(page, 0);
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
