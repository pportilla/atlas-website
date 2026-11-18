// The emulator reads and writes a serial port. Guest frames contain ASCII JSON
// with binary terminal/HTTP bodies encoded as base64. The guest owns its PTY.
const notify = (message: object) => self.postMessage(message);
const textDecoder = new TextDecoder();
const input: Uint8Array[] = [];
const readable = new Set<() => void>();
let line = "";
let termios = { iflag: 0, oflag: 0, cflag: 0, lflag: 0, cc: Array(32).fill(0) };

function queueFrame(message: object): void {
  input.push(new TextEncoder().encode("ATLAS1 " + JSON.stringify(message) + "\n"));
  for (const callback of Array.from(readable)) callback();
}

const serial = {
  get readable() { return input.length > 0; },
  writable: true,
  read(count: number) {
    const first = input[0];
    if (!first) return [];
    const bytes = first.subarray(0, count);
    if (bytes.length === first.length) input.shift();
    else input[0] = first.subarray(bytes.length);
    return bytes;
  },
  write(bytes: number[]) {
    const chunk = textDecoder.decode(Uint8Array.from(bytes), { stream: true });
    let begin = 0;
    let end;
    while ((end = chunk.indexOf("\n", begin)) >= 0) {
      const frame = line + chunk.slice(begin, end);
      line = "";
      begin = end + 1;
      if (frame.startsWith("ATLAS1 ")) {
        notify(JSON.parse(frame.slice(7)));
      } else if (/Kernel panic|Attempted to kill init/.test(frame)) {
        notify({ type: "error", message: "The local Atlas system could not boot: " + frame.trim() });
      }
    }
    line += chunk.slice(begin);
  },
  onReadable(callback: () => void) {
    readable.add(callback);
    return { dispose: () => readable.delete(callback) };
  },
  onSignal() { return { dispose() {} }; },
  ioctl(request: string, value?: typeof termios) {
    if (request === "TCSETS" && value) termios = value;
    if (request === "TIOCGWINSZ") return [80, 24];
    return termios;
  }
};

interface Emulator {
  FS: { mkdir(path: string): void; writeFile(path: string, data: Uint8Array): void };
  TTY: { stream_ops: { poll: (stream: unknown, timeout: number) => number } };
}
const files = [
  "vmlinuz", "atlas.cpio.gz", "rom/bios-256k.bin", "rom/efi-virtio.rom",
  "rom/kvmvapic.bin", "rom/linuxboot_dma.bin", "rom/vgabios-stdvga.bin"
];

async function boot(base: string): Promise<void> {
  const revisionResponse = await fetch(new URL("REVISION", base), { cache: "no-cache" });
  if (!revisionResponse.ok) throw new Error("The compiled Atlas runtime is unavailable.");
  const revision = (await revisionResponse.text()).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("The site's runtime revision is missing.");
  function asset(name: string): string {
    const url = new URL(name, base);
    url.searchParams.set("v", revision);
    return url.href;
  }

  notify({ type: "status", message: "Downloading the compiled Atlas runtime…" });
  const [qemu, payloads] = await Promise.all([
    import(asset("out.js")),
    Promise.all(files.map(async file => {
      const response = await fetch(asset(file));
      if (!response.ok) throw new Error("Could not load " + file + " (HTTP " + response.status + ").");
      // Let the browser inflate the initramfs at host speed before handing it to Linux.
      const unpacked = file === "atlas.cpio.gz" && response.body
        ? new Response(response.body.pipeThrough(new DecompressionStream("gzip")))
        : response;
      return new Uint8Array(await unpacked.arrayBuffer());
    }))
  ]);

  notify({ type: "status", message: "Starting Atlas on this device…" });
  const module: Emulator = await qemu.default({
    pty: serial,
    locateFile: asset,
    mainScriptUrlOrBlob: asset("out.js"),
    arguments: [
      "-nographic", "-monitor", "none", "-M", "pc", "-m", "512M",
      "-accel", "tcg,tb-size=96", "-L", "/rom", "-nic", "none", "-kernel", "/vmlinuz",
      "-initrd", "/atlas.cpio.gz", "-append", "console=ttyS0 rdinit=/init loglevel=3"
    ],
    preRun: [(module: Emulator) => {
      module.FS.mkdir("/rom");
      files.forEach((path, i) => module.FS.writeFile("/" + path, payloads[i]));
      payloads.length = 0;
    }],
    onAbort: (reason: unknown) => notify({ type: "error", message: "The local emulator stopped: " + String(reason) })
  });
  // The serial polling contract used by this precompiled QEMU build expects
  // an immediate writable result when there are no input bytes to consume.
  const ops = module.TTY.stream_ops;
  const poll = ops.poll.bind(ops);
  ops.poll = (stream, timeout) => serial.readable ? poll(stream, timeout) : 4;
}

self.onmessage = ({ data }) => {
  if (data.type === "send") queueFrame(data.message);
  if (data.type === "boot") void boot(data.base).catch(error => {
    notify({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
};
