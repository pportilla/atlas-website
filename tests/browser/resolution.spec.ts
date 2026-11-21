import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
    const progress = await page.locator("#runtime-status, .run-status, .run-message").allTextContents();
    console.error("Resolution workspace at failure:", progress.join(" | "));
  }
});

test("resolve a cusp locally, replay its monodromy zeta, and export the charts", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const requests = new Set<string>();
  page.context().on("request", request => { requests.add(request.url()); });

  await page.goto("resolution/");
  await page.waitForFunction(() => crossOriginIsolated);
  await page.locator("#polynomial").fill("y^2-x^3");
  await page.locator("#zeta").uncheck();
  await page.locator("#topological").uncheck();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  const status = page.locator(".run-status");
  await test.step("Start Atlas and submit the cusp", async () => {
    // The cold browser session can spend up to four minutes starting Atlas.
    // A fast computation may already be finished when submission returns.
    await expect(status.filter({ hasNotText: /^Starting$/ })).toBeVisible({ timeout: 255_000 });
  });
  await test.step("Wait for the submitted search to finish", async () => {
    const finished = status.filter({ hasNotText: /^(Starting|Queued|Searching|Cancelling)$/ });
    await expect(finished).toBeVisible({ timeout: 300_000 });
    await expect(finished).toHaveText("Resolved");
  });

  await page.getByRole("button", { name: "Compute monodromy zeta function" }).click();
  await expect(page.getByRole("button", { name: "Compute monodromy zeta function" }))
    .toHaveCount(0, { timeout: 60_000 });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("resolution-atlas-embedded.json");
  const file = await download.path();
  if (!file) throw new Error("The resolution JSON download did not complete.");
  const record = JSON.parse(await readFile(file, "utf8"));
  expect(record.status).toBe("resolved");
  expect(record.charts.length).toBeGreaterThan(0);
  expect(record.monodromy_zeta.expression).toBe("(1-T^6)/((1-T^2)*(1-T^3))");

  const site = new URL(page.url()).origin;
  for (const address of requests) {
    const url = new URL(address);
    if (["http:", "https:"].includes(url.protocol)) {
      expect(url.origin).toBe(site);
      expect(url.pathname).not.toMatch(/\/api\//);
    }
  }
});
