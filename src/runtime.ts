type Role = "terminal" | "resolution";
type Reply = { resolve: (response: Response) => void; reject: (error: Error) => void };

const root = new URL("../", document.baseURI);
const storageKey = "atlas-isolation-reload";
const maxRequestBytes = 8 * 1024 * 1024; // Matches the guest's serial request limit.

export class PermanentRequestError extends Error {}

async function prepareBrowser(): Promise<void> {
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(storageKey);
    return;
  }
  if (!isSecureContext || !("serviceWorker" in navigator)) {
    throw new Error("Open the workspace over HTTPS or localhost in a browser that supports WebAssembly threads.");
  }
  const service = navigator.serviceWorker;
  await service.register(new URL("isolate.js", root), { scope: root.href });
  await service.ready;
  if (!service.controller) {
    await new Promise<void>(resolve => {
      service.addEventListener("controllerchange", () => resolve(), { once: true });
      if (service.controller) resolve();
    });
  }
  if (sessionStorage.getItem(storageKey) === location.pathname) {
    sessionStorage.removeItem(storageKey);
    throw new Error("This browser could not enable WebAssembly threads. Open this page in its own browser tab.");
  }
  sessionStorage.setItem(storageKey, location.pathname);
  window.dispatchEvent(new Event("atlas:before-reload"));
  location.reload();
  await new Promise<void>(() => {});
}

// Establish isolation before a visitor starts entering a calculation.
const environment = prepareBrowser().then(() => null, error => error as Error);

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
function decode(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

export class AtlasRuntime {
  private worker?: Worker;
  private startup?: Promise<void>;
  private ready?: () => void;
  private failed?: (error: Error) => void;
  private cols = 80;
  private rows = 24;
  private id = 0;
  private pending = new Map<number, Reply>();
  private timer?: number;
  private active = false;

  constructor(private role: Role, private onStatus: (text: string) => void,
              private onOutput?: (bytes: Uint8Array) => void, private onExit?: (error: Error) => void) {}

  start(): Promise<void> {
    if (this.startup) return this.startup;
    this.startup = new Promise<void>((resolve, reject) => {
      this.ready = resolve;
      this.failed = reject;
    });
    this.onStatus("Preparing the local workspace…");
    void this.boot().catch(error => this.close(error));
    return this.startup;
  }

  private async boot(): Promise<void> {
    const error = await environment;
    if (error) throw error;
    if (!this.startup) return;
    const worker = new Worker(new URL("assets/vm-worker.js", root), { type: "module" });
    this.worker = worker;
    this.timer = window.setTimeout(() => this.close(new Error("Atlas did not finish starting. Reload the page to try again.")), 240000);
    worker.onerror = event => this.close(new Error(event.message || "The local Atlas worker stopped."));
    worker.onmessage = ({ data }) => {
      try {
        switch (data.type) {
          case "status": this.onStatus(data.message); break;
          case "hello":
            if (data.version !== 1) throw new Error("This Atlas runtime needs a newer website. Reload the page.");
            this.onStatus(this.role === "terminal" ? "Loading the Atlas prompt…" : "Loading the resolution engine…");
            this.send({ type: "init", role: this.role, cols: this.cols, rows: this.rows });
            break;
          case "ready":
            if (data.role !== this.role) throw new Error("Atlas started the wrong workspace.");
            window.clearTimeout(this.timer);
            this.active = true;
            this.ready?.();
            break;
          case "output": this.onOutput?.(decode(data.data)); break;
          case "response": {
            const reply = this.pending.get(data.id);
            if (!reply) break;
            const bytes = decode(data.body);
            reply.resolve(new Response(bytes.length ? bytes : null, {
              status: data.status, headers: { "Content-Type": data.contentType }
            }));
            this.pending.delete(data.id);
            break;
          }
          case "error": {
            if (data.fatal) throw new PermanentRequestError(data.message);
            const reply = this.pending.get(data.id);
            if (!reply) throw new Error(data.message);
            this.pending.delete(data.id);
            reply.reject(data.permanent ? new PermanentRequestError(data.message) : new Error(data.message));
            break;
          }
          case "exit": this.close(new Error("The Atlas session has ended.")); break;
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    };
    worker.postMessage({ type: "boot", base: new URL("vm/", root).href });
  }

  private send(message: object): void { this.worker?.postMessage({ type: "send", message }); }

  write(bytes: Uint8Array): void {
    if (!this.active) return;
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      this.send({ type: "input", data: encode(bytes.subarray(offset, offset + 8192)) });
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.active) this.send({ type: "resize", cols, rows });
  }

  async request(method: string, path: string, body?: Uint8Array): Promise<Response> {
    if (body && body.byteLength > maxRequestBytes) {
      throw new PermanentRequestError("The request exceeds the 8 MiB browser limit.");
    }
    await this.start();
    if (!this.active) throw new Error("The Atlas workspace has stopped.");
    const id = ++this.id;
    const encoded = body ? encode(body) : "";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "http", id, method, path, body: encoded });
    });
  }

  private close(error: Error): void {
    window.clearTimeout(this.timer);
    this.active = false;
    this.worker?.terminate();
    this.worker = undefined;
    this.failed?.(error);
    this.failed = this.ready = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.startup = undefined;
    this.onStatus(error.message);
    this.onExit?.(error);
  }

  stop(): void { this.close(new Error("The Atlas session has ended.")); }
}
