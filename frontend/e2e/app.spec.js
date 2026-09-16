// UI flows against the real server: store CRUD, autosave, undo, lint.
import { expect, test } from "@playwright/test";

// Each test starts from an empty schema store.
test.beforeEach(async ({ request }) => {
	const res = await request.get("/api/files");
	for (const f of await res.json()) {
		await request.delete("/api/files/" + f.name);
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
	await expect(page.locator("header .ok")).toHaveText("blog.sql");

	// add + rename a table → debounced autosave should write it
	await page.getByRole("button", { name: "+ Table" }).click();
	const posts = page.locator(".tname").nth(1);
	await posts.fill("posts");
	await posts.blur();
	await expect(async () => {
		const body = await (await request.get("/api/files/blog.sql")).text();
		expect(body).toContain("CREATE TABLE `posts`");
	}).toPass({ timeout: 5000 });

	await page.reload();
	await expect(page.locator(".tname")).toHaveValue("users");
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
	// first column row of the second table → FK→ users
	const fk = page.locator("section.table").nth(1).locator("select.fk").first();
	await fk.selectOption({ index: 1 });
	// id is INT vs users.id INT would pass; change type to VARCHAR first
	await fk.selectOption("");
	const typeSel = page.locator("section.table").nth(1).locator("select").nth(1);
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
	await expect(page.locator("header .ok")).toHaveText("tmpfile.sql");
	page.once("dialog", (d) => d.accept());
	await page.getByRole("button", { name: "Del", exact: true }).click();
	await expect(page.locator("header .ok")).toHaveCount(0);
	const list = await (await request.get("/api/files")).json();
	expect(list).toEqual([]);
});
