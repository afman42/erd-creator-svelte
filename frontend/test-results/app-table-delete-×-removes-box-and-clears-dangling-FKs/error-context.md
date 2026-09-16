# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.js >> table delete × removes box and clears dangling FKs
- Location: e2e/app.spec.js:73:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: '+ Table' })

```

# Test source

```ts
  1   | // UI flows against the real server: store CRUD, autosave, undo, lint.
  2   | import { expect, test } from "@playwright/test";
  3   | 
  4   | // Each test starts from an empty schema store.
  5   | test.beforeEach(async ({ request }) => {
  6   | 	const res = await request.get("/api/files");
  7   | 	for (const f of await res.json()) {
  8   | 		await request.delete("/api/files/" + f.name);
  9   | 	}
  10  | });
  11  | 
  12  | async function tables(page) {
  13  | 	return page.locator(".tname").evaluateAll((els) => els.map((i) => i.value));
  14  | }
  15  | 
  16  | test("empty store → fresh default users table", async ({ page }) => {
  17  | 	await page.goto("/");
  18  | 	await expect(page.locator(".tname")).toHaveValue("users");
  19  | 	expect(await tables(page)).toEqual(["users"]);
  20  | });
  21  | 
  22  | test("New file → save → reload round-trips through server", async ({
  23  | 	page,
  24  | 	request,
  25  | }) => {
  26  | 	await page.goto("/");
  27  | 	page.once("dialog", (d) => d.accept("blog"));
  28  | 	await page.getByRole("button", { name: "New", exact: true }).click();
  29  | 	await expect(page.locator("header .ok")).toHaveText("blog.sql");
  30  | 
  31  | 	// add + rename a table → debounced autosave should write it
  32  | 	await page.getByRole("button", { name: "+ Table" }).click();
  33  | 	const posts = page.locator(".tname").nth(1);
  34  | 	await posts.fill("posts");
  35  | 	await posts.blur();
  36  | 	await expect(async () => {
  37  | 		const body = await (await request.get("/api/files/blog.sql")).text();
  38  | 		expect(body).toContain("CREATE TABLE `posts`");
  39  | 	}).toPass({ timeout: 5000 });
  40  | 
  41  | 	await page.reload();
  42  | 	await expect(page.locator(".tname")).toHaveValue("users");
  43  | 	expect(await tables(page)).toEqual(["users", "posts"]);
  44  | });
  45  | 
  46  | test("undo restores table name (Ctrl+Z outside inputs)", async ({ page }) => {
  47  | 	await page.goto("/");
  48  | 	const inp = page.locator(".tname").first();
  49  | 	await inp.fill("members");
  50  | 	await inp.blur();
  51  | 	await expect(page.locator(".tname")).toHaveValue("members");
  52  | 	await page.locator("body").click({ position: { x: 5, y: 300 } }); // defocus
  53  | 	await page.keyboard.press("Control+z");
  54  | 	await expect(page.locator(".tname")).toHaveValue("users");
  55  | });
  56  | 
  57  | test("FK type mismatch surfaces server lint in header", async ({ page }) => {
  58  | 	await page.goto("/");
  59  | 	await page.getByRole("button", { name: "+ Table" }).click();
  60  | 	// first column row of the second table → FK→ users
  61  | 	const fk = page.locator("section.table").nth(1).locator("select.fk").first();
  62  | 	await fk.selectOption({ index: 1 });
  63  | 	// id is INT vs users.id INT would pass; change type to VARCHAR first
  64  | 	await fk.selectOption("");
  65  | 	const typeSel = page.locator("section.table").nth(1).locator("select").nth(1);
  66  | 	await typeSel.selectOption("VARCHAR"); // becomes VARCHAR(255)
  67  | 	await fk.selectOption({ index: 1 });
  68  | 	await expect(page.locator("header .warn")).toContainText("vs", {
  69  | 		timeout: 5000,
  70  | 	});
  71  | });
  72  | 
  73  | test("table delete × removes box and clears dangling FKs", async ({ page }) => {
  74  | 	await page.goto("/");
> 75  | 	await page.getByRole("button", { name: "+ Table" }).click();
      |                                                      ^ Error: locator.click: Test timeout of 30000ms exceeded.
  76  | 	await page
  77  | 		.locator("section.table")
  78  | 		.nth(1)
  79  | 		.locator("select.fk")
  80  | 		.first()
  81  | 		.selectOption({ index: 1 });
  82  | 	await page
  83  | 		.locator("section.table")
  84  | 		.first()
  85  | 		.getByTitle("delete table (Del)")
  86  | 		.click();
  87  | 	await expect(page.locator("section.table")).toHaveCount(1);
  88  | 	await expect(
  89  | 		page.locator("section.table").locator("select.fk").first(),
  90  | 	).toHaveValue("");
  91  | });
  92  | 
  93  | test("Del button deletes current file after confirm dialog", async ({
  94  | 	page,
  95  | 	request,
  96  | }) => {
  97  | 	await page.goto("/");
  98  | 	page.once("dialog", (d) => d.accept("tmpfile"));
  99  | 	await page.getByRole("button", { name: "New", exact: true }).click();
  100 | 	await expect(page.locator("header .ok")).toHaveText("tmpfile.sql");
  101 | 	page.once("dialog", (d) => d.accept());
  102 | 	await page.getByRole("button", { name: "Del", exact: true }).click();
  103 | 	await expect(page.locator("header .ok")).toHaveCount(0);
  104 | 	const list = await (await request.get("/api/files")).json();
  105 | 	expect(list).toEqual([]);
  106 | });
  107 | 
```