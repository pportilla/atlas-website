import { expect, test } from "@playwright/test";

test("the terminal accepts a command during startup and continues the native session", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto("terminal/");
  await page.waitForFunction(() => crossOriginIsolated);
  await page.getByRole("button", { name: "Start terminal" }).click();

  const firstCommand = page.getByRole("textbox", { name: "First Atlas command" });
  await expect(firstCommand).toBeVisible();
  await expect(firstCommand).toBeFocused();
  await page.keyboard.type("chmod 3");
  await expect(firstCommand).toHaveValue("chmod 3");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toHaveText("Session running on this device.", { timeout: 270_000 });
  await expect(page.locator("#terminal-startup")).toBeHidden();
  const rows = page.locator("#terminal-screen .xterm-rows");
  await expect(rows).toBeVisible();
  await expect(rows).toContainText("atlas>");
  await expect(rows).toContainText("chmod 3: invalid syntax", { timeout: 60_000 });
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();

  const overflow = await rows.evaluate(element => {
    const panel = element.closest("#terminal-screen")!.getBoundingClientRect();
    const text = element.getBoundingClientRect();
    return Math.max(panel.left - text.left, text.right - panel.right, panel.top - text.top, text.bottom - panel.bottom);
  });
  expect(overflow, "All rendered terminal rows fit inside the terminal panel").toBeLessThanOrEqual(1);

  await page.keyboard.type('x, y = coordinates("x", "y")');
  await page.keyboard.press("Enter");
  await page.keyboard.type('print("Milnor result", milnor_number(y^2 - x^3).value)');
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("Milnor result 2", { timeout: 70_000 });
  const catalogue = await (await page.request.get("zoo/zoo-data/index.json")).json();
  await page.keyboard.type('print("Zoo records", len(zoo_search("").ids))');
  await page.keyboard.press("Enter");
  await expect(rows).toContainText(`Zoo records ${catalogue.entries.length}`, { timeout: 70_000 });
  await page.getByRole("button", { name: "Stop session" }).click();
  await expect(page.getByRole("button", { name: "Start terminal" })).toBeEnabled();
});
