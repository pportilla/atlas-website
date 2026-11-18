// The browser emulator talks to a Linux serial TTY. The same machine configuration
// runs the build-time cold boot and the visitor's restored VM.
export function serialPort(receive: (bytes: number[]) => void) {
  const input: Uint8Array[] = [];
  const readable = new Set<() => void>();
  let termios = { iflag: 0, oflag: 0, cflag: 0, lflag: 0, cc: Array(32).fill(0) };

  function write(text: string): void {
    input.push(new TextEncoder().encode(text));
    for (const callback of Array.from(readable)) callback();
  }

  const port = {
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
      receive(bytes);
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

  return { write, port };
}

export interface Emulator {
  FS: { mkdir(path: string): void; readFile(path: string): Uint8Array<ArrayBuffer>; writeFile(path: string, data: Uint8Array): void };
  TTY: { stream_ops: { poll: (stream: unknown, timeout: number) => number } };
}
type BootMode = { cold: true } | { state: string };
const rom = ["rom/bios-256k.bin", "rom/efi-virtio.rom", "rom/kvmvapic.bin",
             "rom/linuxboot_dma.bin", "rom/vgabios-stdvga.bin"];

export async function launchMachine(base: string, revision: string, mode: BootMode,
                                    serial: ReturnType<typeof serialPort>["port"],
                                    onStart: () => void, onAbort: (reason: unknown) => void): Promise<Emulator> {
  const asset = (name: string) => {
    const url = new URL(name, base);
    url.searchParams.set("v", revision);
    return url.href;
  };
  const cold = "cold" in mode;
  const files = cold ? [...rom, "vmlinuz", "atlas.cpio.gz"] : [...rom, mode.state];
  const [qemu, payloads] = await Promise.all([
    import(asset("out.js")),
    Promise.all(files.map(async file => {
      const response = await fetch(asset(file));
      if (!response.ok) throw new Error("Could not load " + file + " (HTTP " + response.status + ").");
      const content = file.endsWith(".gz") && response.body
        ? new Response(response.body.pipeThrough(new DecompressionStream("gzip")))
        : response;
      return new Uint8Array(await content.arrayBuffer());
    }))
  ]);

  const bootArgs = cold
    ? ["-kernel", "/vmlinuz", "-initrd", "/atlas.cpio.gz", "-append", "console=ttyS0 rdinit=/init loglevel=3"]
    : ["-incoming", "file:/" + mode.state];
  onStart();
  const module: Emulator = await qemu.default({
    pty: serial, locateFile: asset, mainScriptUrlOrBlob: asset("out.js"),
    arguments: ["-nographic", "-M", "pc", "-m", "512M", "-accel", "tcg,tb-size=96",
                "-L", "/rom", "-nic", "none", ...bootArgs],
    preRun: [(module: Emulator) => {
      module.FS.mkdir("/rom");
      files.forEach((path, i) => module.FS.writeFile("/" + path, payloads[i]));
      payloads.length = 0;
    }],
    onAbort
  });
  const ops = module.TTY.stream_ops;
  const poll = ops.poll.bind(ops);
  ops.poll = (stream, timeout) => serial.readable ? poll(stream, timeout) : 4;
  return module;
}
