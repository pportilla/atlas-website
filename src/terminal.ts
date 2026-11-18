import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AtlasRuntime } from "./runtime";

const start = document.querySelector<HTMLButtonElement>("#start-terminal")!;
const stop = document.querySelector<HTMLButtonElement>("#stop-terminal")!;
const screen = document.getElementById("terminal-screen")!;
const status = document.getElementById("runtime-status")!;
const encoder = new TextEncoder();
let session: AtlasRuntime | undefined;
let terminal: Terminal | undefined;
let observer: ResizeObserver | undefined;

function endSession(message: string, stopRuntime = true) {
  const previous = session;
  session = undefined;
  if (stopRuntime) previous?.stop();
  observer?.disconnect();
  if (terminal) terminal.options.disableStdin = true;
  stop.hidden = true;
  start.disabled = false;
  start.textContent = "Start terminal";
  status.textContent = message;
}

start.addEventListener("click", async () => {
  if (session) return;
  start.disabled = true;
  stop.hidden = false;
  screen.hidden = false;
  status.textContent = "Starting Atlas…";
  terminal?.dispose();
  terminal = new Terminal({
    cursorBlink: true, disableStdin: true, screenReaderMode: true,
    fontFamily: '"Source Code Pro", monospace', fontSize: 15, scrollback: 6000,
    theme: { background: "#12221f", foreground: "#e6f3e9", cursor: "#93d8c7" },
  });
  const display = terminal;
  const fit = new FitAddon();
  display.loadAddon(fit);
  display.open(screen);
  let ready = false;
  const current = new AtlasRuntime("terminal", (text) => {
    if (session === current) status.textContent = text;
  }, (bytes) => {
    if (session === current) display.write(bytes);
  }, (error) => {
    if (ready && session === current) endSession(error.message, false);
  });
  session = current;
  display.onData((text) => current.write(encoder.encode(text)));
  display.onBinary((binary) => current.write(Uint8Array.from(binary, (byte) => byte.charCodeAt(0))));
  display.onResize(({ cols, rows }) => { if (ready) current.resize(cols, rows); });
  observer = new ResizeObserver(() => { if (session === current) fit.fit(); });
  observer.observe(screen);
  void document.fonts.ready.then(() => { if (session === current) fit.fit(); });
  try {
    await current.start();
    if (session !== current) return;
    ready = true;
    fit.fit();
    current.resize(display.cols, display.rows);
    display.options.disableStdin = false;
    status.textContent = "Session running on this device.";
    display.focus();
  } catch (error) {
    if (session === current) {
      endSession(`Atlas could not start. ${error instanceof Error ? error.message : String(error)}`);
      start.focus();
    }
  }
});
stop.addEventListener("click", () => {
  endSession("Session stopped.");
  start.focus();
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) endSession("Session closed.");
});

const resumeKey = "atlas:resume-terminal:" + location.pathname;
window.addEventListener("atlas:before-reload", () => {
  if (session) sessionStorage.setItem(resumeKey, "start");
});
if (sessionStorage.getItem(resumeKey)) {
  sessionStorage.removeItem(resumeKey);
  start.click();
}
