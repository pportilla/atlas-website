import { expect, test } from "@playwright/test";

test("browse and search the published catalogue without a resolution runtime", async ({ page, context }) => {
  const requests: string[] = [];
  context.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.goto("./");
  await page.locator(".topnav").getByRole("link", { name: "Resolution Zoo" }).click();
  await expect(page.getByRole("heading", { name: "Resolution Zoo", exact: true })).toBeVisible();

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
