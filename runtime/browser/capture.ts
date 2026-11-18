// Build-time worker. The published visitor worker can only restore a pristine VM.
import { launchMachine, serialPort } from "../../src/emulator";

async function capture(base: string, revision: string): Promise<void> {
  const decoder = new TextDecoder();
  let tail = "";
  const serial = serialPort(bytes => {
    tail = (tail + decoder.decode(Uint8Array.from(bytes), { stream: true })).slice(-32768);
  });
  const module = await launchMachine(base, revision, { cold: true }, serial.port,
    () => self.postMessage({ status: "Booting the native Atlas guest" }),
    reason => self.postMessage({ error: String(reason) }));

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function expect(pattern: RegExp, timeout: number) {
    const deadline = Date.now() + timeout;
    while (!pattern.test(tail)) {
      if (Date.now() > deadline || /Kernel panic/.test(tail))
        throw new Error("Guest failed to reach " + pattern + "\n" + tail.slice(-1400));
      await delay(100);
    }
    tail = "";
  }
  await expect(/ATLAS1 \{"type":"hello","version":1\}/, 240_000);
  // QEMU's stdio multiplexer accepts Ctrl-A C to switch into the monitor.
  // No user input or mathematical session has been created at this point.
  serial.write("\x01c");
  await expect(/\(qemu\) /, 10_000);
  serial.write("migrate -d file:/pristine.state\r");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    serial.write("info migrate\r");
    await delay(500);
    if (/Migration status: completed/.test(tail)) {
      const bytes = module.FS.readFile("/pristine.state");
      const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
      self.postMessage({ blob: await new Response(compressed).blob() });
      return;
    }
    if (/Migration status: failed/.test(tail)) throw new Error(tail.slice(-1500));
    tail = "";
  }
  throw new Error("QEMU did not finish saving the guest");
}

self.onmessage = event => {
  capture(event.data.base, event.data.revision).catch(error => self.postMessage({ error: String(error) }));
};
