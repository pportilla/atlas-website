import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    terminalGuest: { input: string; output: (text: string) => void };
  }
}

test.describe.configure({ timeout: 20_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class TerminalGuest {
      input = "";
      onmessage?: (event: { data: object }) => void;
      constructor() { window.terminalGuest = this; }
      terminate() {}
      emit(data: object) { queueMicrotask(() => this.onmessage?.({ data })); }
      output(text: string) { this.emit({ type: "output", data: btoa(text) }); }
      postMessage(envelope: { type: string; message?: { type: string; data: string } }) {
        if (envelope.type === "boot") this.emit({ type: "hello", version: 1 });
        if (envelope.message?.type === "init") this.emit({ type: "ready", role: "terminal" });
        if (envelope.message?.type === "input") this.input += atob(envelope.message.data);
      }
    }
    Object.defineProperty(window, "Worker", { value: TerminalGuest });
  });
});

const guestInput = (page: Page) => page.evaluate(() => window.terminalGuest.input);
const guestOutput = (page: Page, text: string) => page.evaluate(chunk => window.terminalGuest.output(chunk), text);

test("an editable draft passes to the terminal only when its coloured prompt finishes", async ({ page }) => {
  await page.goto("terminal/");
  await page.waitForFunction(() => crossOriginIsolated);
  const status = page.getByRole("status");
  const announcements = await status.evaluateHandle(element => {
    const messages: string[] = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) messages.push(node.textContent || "");
      }
    }).observe(element, { childList: true });
    return messages;
  });
  await page.getByRole("button", { name: "Start terminal" }).click();
  const draft = page.getByRole("textbox", { name: "First Atlas command" });
  await expect(status).toHaveText("Waiting for the Atlas prompt…");
  await expect(draft).toBeFocused();
  const palette = await page.locator("#terminal-screen").evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color, blue: style.caretColor };
  });
  await expect(page.locator("#terminal-startup")).toHaveCSS("background-color", palette.background);
  await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", palette.background);
  await expect(page.locator(".xterm-rows")).toHaveCSS("color", palette.foreground);
  await page.keyboard.type("helx");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("p");
  await expect(draft).toHaveValue("help");

  const rows = page.locator(".xterm-rows > div");
  await guestOutput(page, "Welcome! Commands begin at atlas>.\r\n");
  await expect(rows.filter({ hasText: "Welcome! Commands begin at atlas>." })).toHaveCount(1);
  await expect(status).toHaveText("Waiting for the Atlas prompt…");
  await guestOutput(page, "\x1b[34matl");
  await expect(rows.filter({ hasText: /^\s*atl\s*$/ })).toHaveCount(1);
  await expect(rows.getByText("atl", { exact: true })).toHaveCSS("color", palette.blue);
  await expect(draft).toBeEditable();
  await expect(status).toHaveText("Waiting for the Atlas prompt…");
  expect((await announcements.jsonValue()).join("\n")).not.toMatch(/running on this device/i);
  expect(await guestInput(page)).toBe("");

  await guestOutput(page, "as\x1b[0m> ");
  await expect(status).toHaveText("Session running on this device.");
  await expect.poll(() => guestInput(page)).toBe("help");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(" rings");
  await expect.poll(() => guestInput(page)).toBe("help rings");
  await page.keyboard.press("Enter");
  await expect.poll(() => guestInput(page)).toBe("help rings\r");
});

test("a queued first command survives the browser isolation reload", async ({ page, context }) => {
  let resumeRegistration!: () => void;
  const registration = new Promise<void>(resolve => { resumeRegistration = resolve; });
  // Allow the visitor to finish typing before the real service worker claims this page.
  await context.route("**/isolate.js", async route => {
    await registration;
    await route.continue();
  });
  const draft = page.getByRole("textbox", { name: "First Atlas command" });
  try {
    await page.goto("terminal/", { waitUntil: "domcontentloaded" });
    test.skip(await page.evaluate(() => crossOriginIsolated), "This host supplies isolation headers on the initial page.");
    await page.getByRole("button", { name: "Start terminal" }).click();
    await page.keyboard.type("help coordinates");
    await page.keyboard.press("Enter");
    await expect(draft).toHaveValue("help coordinates");
    await expect(draft).toHaveJSProperty("readOnly", true);
  } finally {
    resumeRegistration();
  }

  await page.waitForFunction(() => crossOriginIsolated);
  await expect(page.getByRole("status")).toHaveText("Waiting for the Atlas prompt…");
  await expect(draft).toHaveValue("help coordinates");
  await expect(draft).toHaveJSProperty("readOnly", true);
  expect(await guestInput(page)).toBe("");
  await guestOutput(page, "atlas> ");
  await expect.poll(() => guestInput(page)).toBe("help coordinates\r");
});

test("stopping before the prompt clears a queued command for the next session", async ({ page }) => {
  await page.goto("terminal/");
  await page.waitForFunction(() => crossOriginIsolated);
  const start = page.getByRole("button", { name: "Start terminal" });
  await start.click();
  const draft = page.getByRole("textbox", { name: "First Atlas command" });
  await page.keyboard.type("help abandoned");
  await page.keyboard.press("Enter");
  await expect(draft).toHaveJSProperty("readOnly", true);
  await page.getByRole("button", { name: "Stop session" }).click();
  await start.click();
  await expect(draft).toBeEditable();
  await expect(draft).toHaveValue("");
  await expect(page.getByRole("status")).toHaveText("Waiting for the Atlas prompt…");
  await guestOutput(page, "atlas> ");
  await expect(page.getByRole("status")).toHaveText("Session running on this device.");
  await page.keyboard.type("help");
  await page.keyboard.press("Enter");
  await expect.poll(() => guestInput(page)).toBe("help\r");
});
