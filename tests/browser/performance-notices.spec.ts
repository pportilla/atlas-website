import { expect, test } from "@playwright/test";

const tools = [
  { name: "Terminal", path: "terminal/" },
  { name: "Resolution suite", path: "resolution/" },
];
const performanceComparison = /much (?:longer|slower).*native Atlas/i;

for (const tool of tools) {
  test(`${tool.name} explains browser performance on the homepage and tool page`, async ({ page }) => {
    await page.goto("./");
    const destinations = page.getByRole("navigation", { name: "Atlas destinations" });
    const link = destinations.getByRole("link", { name: tool.name, exact: true });
    const button = destinations.getByRole("button", { name: `${tool.name} performance` });
    await expect(button).toHaveAttribute("aria-describedby", /\S+/);
    const tooltip = page.locator(`[id="${await button.getAttribute("aria-describedby")}"]`);
    await expect(tooltip).toHaveRole("tooltip");
    await expect(tooltip).toBeHidden();

    await button.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(performanceComparison);
    await expect(button).toHaveAccessibleDescription(performanceComparison);
    const bounds = (await tooltip.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 8 });
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();

    await page.mouse.move(0, 0);
    await link.focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(button).toBeFocused();

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${tool.path}$`));
    await expect(page.getByText(performanceComparison)).toBeVisible();
    await expect(page.locator('a[href="../docs/installation.html#build-atlas"]')).toBeVisible();
  });
}

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 800 } });

  test("tapping each performance button opens its tooltip without following the tool link", async ({ page }) => {
    await page.goto("./");
    const home = page.url();
    for (const tool of tools) {
      const button = page.getByRole("button", { name: `${tool.name} performance` });
      await button.tap();
      const tooltip = page.locator(`[id="${await button.getAttribute("aria-describedby")}"]`);
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText(performanceComparison);
      await expect(tooltip).toBeInViewport();
      await expect(page).toHaveURL(home);
    }
    await page.getByRole("button", { name: "Resolution suite performance" }).tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
});
