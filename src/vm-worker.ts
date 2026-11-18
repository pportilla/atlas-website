import { launchMachine, serialPort } from "./emulator";

const notify = (message: object) => self.postMessage(message);
const decoder = new TextDecoder();
let line = "";
let resumed = false;
let handshake: ReturnType<typeof setInterval> | undefined;
const serial = serialPort(bytes => {
  const chunk = decoder.decode(Uint8Array.from(bytes), { stream: true });
  let begin = 0;
  let end;
  while ((end = chunk.indexOf("\n", begin)) >= 0) {
    const frame = line + chunk.slice(begin, end);
    line = "";
    begin = end + 1;
    if (frame.startsWith("ATLAS1 ")) {
      const message = JSON.parse(frame.slice(7));
      if (!resumed) {
        // The UART may contain a partial line while QEMU restores its registers.
        // Re-synchronize the stream with the next handshake, before exposing it.
        if (message.type === "hello" && message.resumed === true) {
          resumed = true;
          clearInterval(handshake);
          notify(message);
        } else if (message.type === "error" && /random|entropy|permission/i.test(message.message)) {
          clearInterval(handshake);
          notify(message);
        }
      } else if (message.type !== "hello") {
        notify(message);
      }
    } else if (/Kernel panic|Attempted to kill init/.test(frame)) {
      notify({ type: "error", message: "The local Atlas system could not boot: " + frame.trim() });
    }
  }
  line += chunk.slice(begin);
});

function send(frame: object): void { serial.write("ATLAS1 " + JSON.stringify(frame) + "\n"); }

async function boot(base: string): Promise<void> {
  const response = await fetch(new URL("snapshot.json", base), { cache: "no-cache" });
  if (!response.ok) throw new Error("The compiled Atlas runtime is unavailable.");
  const snapshot = await response.json();
  if (!/^[a-f0-9]{40}$/.test(snapshot.atlas) || !/^atlas-[a-f0-9]{64}\.state\.gz$/.test(snapshot.state))
    throw new Error("The Atlas runtime has an invalid snapshot manifest.");
  notify({ type: "status", message: "Downloading the compiled Atlas runtime…" });
  await launchMachine(base, snapshot.atlas, { state: snapshot.state }, serial.port,
    () => notify({ type: "status", message: "Starting Atlas on this device…" }),
    reason => notify({ type: "error", message: "The local emulator stopped: " + String(reason) }));
  // The snapshot is paused after the guest's unsolicited hello, before opening
  // either tool. Ask the live guest to acknowledge this browser's fresh session.
  const entropy = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const probe = () => send({ type: "hello", entropy });
  handshake = setInterval(probe, 750);
  probe();
}

self.onmessage = ({ data }) => {
  if (data.type === "send") send(data.message);
  if (data.type === "boot") void boot(data.base).catch(error => {
    notify({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
};
