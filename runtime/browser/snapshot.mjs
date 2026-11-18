// Build one pristine QEMU migration file per Atlas revision under headless Chromium.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error("Usage: node runtime/browser/snapshot.mjs DIST_VM");
const vm = resolve(process.argv[2]);
const revision = (await readFile(join(vm, "REVISION"), "utf8")).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid native Atlas revision");
const worker = await build({
  entryPoints: [join(here, "capture.ts")], bundle: true, write: false, format: "esm", target: "es2022"
});
const source = worker.outputFiles[0].contents;
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
  if (path === "/capture.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(source);
  const match = /^\/vm\/((?:rom\/)?[a-zA-Z0-9_.-]+)$/.exec(path);
  if (!match || match[1].includes("..")) return res.writeHead(404).end();
  const file = join(vm, match[1]);
  try {
    const info = await stat(file);
    const type = file.endsWith(".js") ? "text/javascript" :
                 file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": info.size });
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise((ready, reject) => server.once("error", reject).listen(0, "127.0.0.1", ready));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  page.on("console", msg => console.log(msg.text()));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 480000 }),
    page.evaluate(revision => new Promise((resolve, reject) => {
      const worker = new Worker("/capture.js", { type: "module" });
      worker.onerror = error => reject(new Error(error.message));
      worker.onmessage = ({ data }) => {
        if (data.error) return reject(new Error(data.error));
        if (data.status) console.log(data.status);
        if (data.blob) {
          const link = document.createElement("a");
          link.href = URL.createObjectURL(data.blob);
          link.download = "snapshot.gz";
          link.click();
          resolve();
        }
      };
      worker.postMessage({ base: new URL("/vm/", location.href).href, revision });
    }), revision)
  ]);
  const temporary = join(vm, ".snapshot.gz");
  await download.saveAs(temporary);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(temporary)) hash.update(chunk);
  const file = "atlas-" + hash.digest("hex") + ".state.gz";
  await rename(temporary, join(vm, file));
  await writeFile(join(vm, "snapshot.json"), JSON.stringify({ atlas: revision, state: file }) + "\n");
  console.log("Saved " + file + " for Atlas " + revision);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
