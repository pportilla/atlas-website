import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AtlasRuntime } from "./runtime";

const start = document.querySelector<HTMLButtonElement>("#start-terminal")!;
const stop = document.querySelector<HTMLButtonElement>("#stop-terminal")!;
const screen = document.getElementById("terminal-screen")!;
const host = document.getElementById("terminal-display")!;
const startup = document.querySelector<HTMLFormElement>("#terminal-startup")!;
const command = document.querySelector<HTMLInputElement>("#first-command")!;
const hint = document.getElementById("command-hint")!;
const initialHint = hint.textContent;
const status = document.getElementById("runtime-status")!;
const encoder = new TextEncoder();
let session: AtlasRuntime | undefined;
let terminal: Terminal | undefined;
let observer: ResizeObserver | undefined;
let promptTimer: number | undefined;

function queueCommand() {
  command.readOnly = true;
  hint.textContent = "Command queued. Atlas will run it when the prompt appears.";
}

startup.addEventListener("submit", (event) => {
  event.preventDefault();
  if (command.value) queueCommand();
});
startup.addEventListener("click", (event) => {
  if (event.target === startup) command.focus();
});

function endSession(message: string, stopRuntime = true) {
  const previous = session;
  session = undefined;
  if (stopRuntime) previous?.stop();
  window.clearTimeout(promptTimer);
  observer?.disconnect();
  if (!startup.hidden) screen.hidden = true;
  startup.hidden = true;
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
  startup.hidden = false;
  host.inert = true;
  command.value = "";
  command.readOnly = false;
  hint.textContent = initialHint;
  command.focus();
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
  display.open(host);
  let connected = false;
  const current = new AtlasRuntime("terminal", (text) => {
    if (session === current) status.textContent = text;
  }, (bytes) => {
    if (session === current) display.write(bytes);
  }, (error) => {
    if (connected && session === current) endSession(error.message, false);
  });
  session = current;
  display.onData((text) => current.write(encoder.encode(text)));
  display.onBinary((binary) => current.write(Uint8Array.from(binary, (byte) => byte.charCodeAt(0))));
  display.onResize(({ cols, rows }) => current.resize(cols, rows));
  fit.fit();
  current.resize(display.cols, display.rows);
  observer = new ResizeObserver(() => { if (session === current) fit.fit(); });
  observer.observe(host);
  void document.fonts.ready.then(() => { if (session === current) fit.fit(); });

  // Creating a guest PTY precedes the interpreter's first prompt. Inspect the
  // parsed cursor line so split writes and Atlas's ANSI colours are handled by xterm.
  function acceptPrompt() {
    if (session !== current || !connected || startup.hidden) return;
    const buffer = display.buffer.active;
    const row = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (row?.translateToString(true).trim() !== "atlas>") return;
    promptListener.dispose();
    window.clearTimeout(promptTimer);
    const transferFocus = startup.contains(document.activeElement) || document.activeElement === document.body;
    startup.hidden = true;
    host.inert = false;
    display.options.disableStdin = false;
    if (transferFocus) display.focus();
    status.textContent = "Session running on this device.";
    if (command.value) display.paste(command.value);
    if (command.readOnly) current.write(encoder.encode("\r"));
    command.value = "";
  }
  const promptListener = display.onWriteParsed(acceptPrompt);
  try {
    await current.start();
    if (session !== current) return;
    connected = true;
    current.resize(display.cols, display.rows);
    status.textContent = "Waiting for the Atlas prompt…";
    promptTimer = window.setTimeout(() => {
      if (session === current) endSession("Atlas did not display its prompt. Start the terminal to try again.");
    }, 240_000);
    acceptPrompt();
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
  if (session) {
    sessionStorage.setItem(resumeKey, new URLSearchParams({
      command: command.value, queued: String(command.readOnly),
    }).toString());
  }
});
const resume = sessionStorage.getItem(resumeKey);
if (resume) {
  sessionStorage.removeItem(resumeKey);
  start.click();
  const saved = new URLSearchParams(resume);
  command.value = saved.get("command") || "";
  if (command.value && saved.get("queued") === "true") queueCommand();
}
