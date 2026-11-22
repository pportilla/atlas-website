import { expect, test } from "@playwright/test";

test("browse and search the published catalogue without a resolution runtime", async ({ page, context }) => {
  const requests: string[] = [];
  context.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.goto("./");
  await page.getByRole("navigation", { name: "Atlas destinations" }).getByRole("link", { name: "Resolution Zoo" }).click();
  await expect(page.getByRole("heading", { name: "Resolution Zoo", exact: true })).toBeVisible();

  const instructions = page.locator("#zoo-search-help");
  await expect(instructions).toBeHidden();
  const help = page.getByLabel("Monomial search help");
  await help.hover();
  await expect(instructions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(instructions).toBeHidden();

  const query = page.getByRole("searchbox", { name: "Search by monomials" });
  await query.fill("1/2*a*b^3, -b^4");
  await expect(page.locator("#zoo-count")).toHaveText("1 record");
  await expect(page.locator("#zoo-detail h2")).toContainText("Quartic cone with a rational mixed coefficient");
  await page.locator("#zoo-detail summary").filter({ hasText: "Topological zeta function" }).click();
  await expect(page.locator("#zoo-detail .zoo-expression").last()).toBeVisible();

  await query.fill("1/2*a*b^3, b^4");
  await expect(page.locator("#zoo-count")).toHaveText("0 records");
  await query.fill("1/0*x");
  await expect(query).toHaveAttribute("aria-invalid", "true");
  await query.fill("x^2");
  await expect(page.locator("#zoo-count")).toHaveText(/^[1-9][0-9]* records?$/);

  expect(requests.some(path => path.endsWith("zoo-kernel.wasm"))).toBeTruthy();
  expect(requests.some(path => /\/(vm|api)\//.test(path))).toBeFalsy();
  await page.getByRole("link", { name: "Resolution suite", exact: true }).click();
  await expect(page.locator("#resolve-form")).toBeVisible();
  await page.locator(".masthead").getByRole("link", { name: "Resolution Zoo" }).click();
  await expect(query).toBeVisible();
});

test("the colour theme selected on the homepage follows the reader into each tool", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("./");
  const pageColour = () => page.locator("body").evaluate(body => getComputedStyle(body).backgroundColor);
  const light = await pageColour();
  const toggle = page.getByRole("button", { name: "Colour theme" });
  await toggle.click(); // System to light.
  await toggle.click(); // Light to dark.
  const dark = await pageColour();
  expect(dark).not.toBe(light);
  for (const path of ["docs/", "terminal/", "resolution/", "zoo/"]) {
    await page.goto(path);
    if (path === "terminal/" || path === "resolution/") {
      await page.waitForFunction(() => crossOriginIsolated);
    }
    await expect(page.locator("body")).toHaveCSS("background-color", dark);
  }
});

test("the Zoo link fits the homepage and manual navigation and its logo returns home", async ({ page }) => {
  for (const width of [320, 910, 1251]) {
    await page.setViewportSize({ width, height: 780 });
    for (const path of ["./", "docs/reference/index.html"]) {
      await page.goto(path);
      const navigation = path === "./" ? page.getByRole("navigation", { name: "Atlas destinations" }) : page.locator("header");
      const link = navigation.getByRole("link", { name: "Resolution Zoo" });
      await expect(link).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await link.click();
      await expect(page.locator("#zoo-detail h2")).toBeVisible();
      await page.locator("header").getByRole("link", { name: "Atlas home" }).click();
      await expect(page.getByRole("navigation", { name: "Atlas destinations" })).toBeVisible();
    }
  }
});
