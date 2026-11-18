import { expect, test } from "@playwright/test";

test("a job retries a transient read and displays a permanent transport failure", async ({ page }) => {
  // Isolate the polling/error path. The separate resolution test boots the real guest.
  await page.addInitScript(() => {
    const id = "c".repeat(32);
    let reads = 0;
    class WorkerWithOversizedResult {
      onmessage?: (event: { data: object }) => void;
      terminate() {}
      postMessage(envelope: { type: string; message?: { type: string; id: number; method: string; path: string } }) {
        const message = envelope.message;
        const emit = (data: object) => queueMicrotask(() => this.onmessage?.({ data }));
        if (envelope.type === "boot") {
          emit({ type: "hello", version: 1 });
        } else if (message?.type === "init") {
          emit({ type: "ready", role: "resolution" });
        } else if (message?.type === "http") {
          if (message.path === "/api/searches") {
            const body = message.method === "POST" ? { id, state: "running" } : { jobs: [] };
            emit({ type: "response", id: message.id, status: 200,
                   contentType: "application/json", body: btoa(JSON.stringify(body)) });
          } else {
            reads += 1;
            emit({ type: "error", id: message.id, permanent: reads > 1,
                   message: reads === 1 ? "Temporary I/O error" : "Atlas response exceeds the 16 MiB browser limit." });
          }
        }
      }
    }
    Object.defineProperty(window, "Worker", { value: WorkerWithOversizedResult });
  });

  await page.goto("resolution/");
  await page.waitForFunction(() => crossOriginIsolated);
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.locator(".run-message")).toContainText("Reconnecting");
  await expect(page.locator(".run-status")).toHaveText("Failed", { timeout: 15_000 });
  await expect(page.locator(".run-message")).toContainText("16 MiB browser limit");
  await expect(page.getByRole("button", { name: "Retry resolution" })).toBeVisible();
});
