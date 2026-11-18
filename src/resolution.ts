import { AtlasRuntime } from "./runtime";

// Install before app.js. Its exact JSON codec reads the original HTTP bytes from the guest.
const fetchStatic = window.fetch.bind(window);
const localApi = new URL("api/", document.baseURI);
let session: AtlasRuntime | undefined;
let starting: Promise<void> | undefined;
let releaseHistory!: () => void;
const firstCalculation = new Promise<void>((resolve) => { releaseHistory = resolve; });

function showStatus(text: string) {
  const element = document.getElementById("runtime-status");
  if (element) element.textContent = text;
}

async function getSession(): Promise<AtlasRuntime> {
  if (!starting) {
    releaseHistory();
    showStatus("Starting Atlas on this device…");
    const current = new AtlasRuntime("resolution", showStatus, undefined, (error) => {
      if (session === current) {
        session = undefined;
        starting = undefined;
        showStatus(`${error.message} Press Resolve to start another session.`);
      }
    });
    session = current;
    starting = current.start().then(() => {
      showStatus("Atlas is running on this device.");
    }).catch((error) => {
      current.stop();
      session = undefined;
      starting = undefined;
      showStatus(`Atlas could not start. ${error instanceof Error ? error.message : String(error)} Try Resolve again.`);
      throw error;
    });
  }
  await starting;
  return session!;
}

window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), document.baseURI);
  if (url.origin !== location.origin) return fetchStatic(input, init);
  const path = url.pathname.startsWith(localApi.pathname)
    ? "/api/" + url.pathname.slice(localApi.pathname.length)
    : url.pathname;
  if (!path.startsWith("/api/")) return fetchStatic(input, init);
  const request = new Request(input, init);
  // Upstream restores history on load. A fresh tab can show the workspace before
  // downloading the guest. An addressed polynomial or the first submission releases this read.
  if (!starting && request.method === "GET" && path === "/api/searches"
      && !new URLSearchParams(location.hash.slice(1)).get("f")) {
    await firstCalculation;
  }
  const runtime = await getSession();
  request.signal.throwIfAborted();
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  return runtime.request(request.method, path + url.search, body);
};

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) session?.stop();
});

// The first visit can reload once to enable WebAssembly threads. Keep unsent
// form edits through that reload. Submitted polynomials already have an Atlas URL.
const draftKey = "atlas:resolution-draft:" + location.pathname;
window.addEventListener("atlas:before-reload", () => {
  const form = document.querySelector<HTMLFormElement>("#resolve-form");
  if (!form) return;
  const values = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") values.append(name, value);
  }
  sessionStorage.setItem(draftKey, values.toString());
});
document.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem(draftKey);
  if (!saved) return;
  sessionStorage.removeItem(draftKey);
  const values = new URLSearchParams(saved);
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "#resolve-form input[name], #resolve-form textarea[name], #resolve-form select[name]",
  );
  for (const field of fields) {
    if (field instanceof HTMLInputElement && ["checkbox", "radio"].includes(field.type)) {
      field.checked = values.getAll(field.name).includes(field.value);
    } else if (values.has(field.name)) {
      field.value = values.get(field.name)!;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
});
