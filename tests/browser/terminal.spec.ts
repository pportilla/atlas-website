import { expect, test } from "@playwright/test";

test("the website runs a stateful native terminal on the visitor's device", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto("terminal/");
  await page.waitForFunction(() => crossOriginIsolated);
  await page.getByRole("button", { name: "Start terminal" }).click();
  await expect(page.getByRole("status")).toHaveText("Session running on this device.", { timeout: 210_000 });
  await expect(page.locator(".xterm-accessibility-tree")).toContainText("atlas>", { timeout: 150_000 });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText('x, y = coordinates("x", "y")');
  await page.keyboard.press("Enter");
  await page.keyboard.insertText('print("Milnor result", milnor_number(y^2 - x^3).value)');
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-accessibility-tree")).toContainText("Milnor result 2", { timeout: 70_000 });
  await page.getByRole("button", { name: "Stop session" }).click();
  await expect(page.getByRole("button", { name: "Start terminal" })).toBeEnabled();
});
