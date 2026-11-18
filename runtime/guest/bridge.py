"""Connect one browser VM's serial console to the native Atlas prompt or resolution API."""

import base64
import binascii
import errno
import fcntl
import http.client
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import tty
from concurrent.futures import ThreadPoolExecutor


PREFIX = b"ATLAS1 "
MAX_REQUEST = 8 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
MAX_FRAME = 4 * ((MAX_REQUEST + 2) // 3) + 1024
MAX_INPUT = 64 * 1024
ATLAS = str(Path(os.environ.get("ATLAS_ROOT", "/opt/atlas")) / "atlas")
OUTPUT_LOCK = threading.Lock()
JOB = r"/api/searches/[0-9a-f]{32}"
ROUTES = {
    "GET": re.compile(r"/api/(?:health|searches|searches/current)|" + JOB),
    "POST": re.compile(r"/api/(?:resolve|searches|zetas)|" + JOB + r"/zetas"),
    "DELETE": re.compile(JOB),
}


def send(kind, **values):
    line = PREFIX + json.dumps({"type": kind, **values}, separators=(",", ":")).encode("ascii") + b"\n"
    with OUTPUT_LOCK:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()


def encode(data):
    return base64.b64encode(data).decode("ascii")


def decode(data, limit):
    if not isinstance(data, str) or len(data) > 4 * ((limit + 2) // 3):
        raise ValueError("Invalid or oversized base64 payload.")
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Invalid base64 payload.") from None
    if len(raw) > limit:
        raise ValueError("Payload exceeds the size limit.")
    return raw


def resume_guest(frame):
    entropy = decode(frame.get("entropy"), 32)
    if len(entropy) != 32:
        raise ValueError("Resuming requires 32 bytes of fresh browser randomness.")
    # The initramfs launches this process as PID 1. Reseed its cloned kernel
    # before starting Atlas. Standalone bridge tests share the host's kernel.
    if os.getpid() == 1:
        with open("/dev/urandom", "wb", buffering=0) as rng:
            # linux/random.h: RNDADDENTROPY takes two ints and the random bytes.
            fcntl.ioctl(rng, 0x40085203, struct.pack("=ii32s", 256, 32, entropy))
            fcntl.ioctl(rng, 0x5207)  # RNDRESEEDCRNG
    send("hello", version=1, resumed=True)


def dimensions(frame):
    cols, rows = frame.get("cols", 80), frame.get("rows", 24)
    if not all(type(value) is int and 1 <= value <= 1000 for value in (cols, rows)):
        raise ValueError("Terminal dimensions must be integers from 1 to 1000.")
    return struct.pack("HHHH", rows, cols, 0, 0)


class Terminal:
    def __init__(self, init):
        size = dimensions(init)
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, size)
                os.environ["TERM"] = "xterm-256color"
                os.execv(ATLAS, [ATLAS])
            except OSError as exc:
                os.write(2, f"Cannot start Atlas: {exc}\n".encode())
            os._exit(127)
        self.reader = threading.Thread(target=self.output, daemon=True)

    def output(self):
        # The child owns a separate controlling terminal. Its echo, colours and
        # control bytes are all transported as data; none reach the serial framing.
        try:
            while data := os.read(self.master, 4096):
                send("output", data=encode(data))
        except OSError as exc:
            if exc.errno != errno.EIO:  # PTY hangup on Linux
                send("error", message=str(exc))
        _, status = os.waitpid(self.pid, 0)
        code = os.waitstatus_to_exitcode(status)
        send("exit", code=code if code >= 0 else 128 - code)

    def dispatch(self, frame):
        if frame["type"] == "resize":
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, dimensions(frame))
        elif frame["type"] == "input":
            data = memoryview(decode(frame.get("data"), MAX_INPUT))
            while data:
                data = data[os.write(self.master, data):]
        else:
            raise ValueError("Expected terminal input or resize.")

    def close(self):
        if self.reader.is_alive():
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            self.reader.join(timeout=2)
            if self.reader.is_alive():
                try:
                    os.killpg(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.reader.join(timeout=2)
        os.close(self.master)


class Resolution:
    def __init__(self):
        self.process = subprocess.Popen([ATLAS, "serve", "--port", "0"], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.recent_log = b""
        self.log_reader = threading.Thread(target=self.read_log, daemon=True)
        self.log_reader.start()
        try:
            if not select.select([self.process.stdout], [], [], 120)[0]:
                raise RuntimeError("Timed out starting the Atlas resolution service.")
            banner = self.process.stdout.readline(512)
            bound = re.fullmatch(rb"Resolution Atlas: http://127\.0\.0\.1:(\d+)\s*", banner)
            if not bound:
                raise RuntimeError("Atlas could not start its local resolution service.")
            self.port = int(bound[1])
        except BaseException as exc:
            self.stop_process()
            if self.recent_log and isinstance(exc, (RuntimeError, OSError)):
                diagnostic = self.recent_log.decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"{exc} {diagnostic}") from exc
            raise
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.slots = threading.BoundedSemaphore(6)

    def read_log(self):
        # Keep diagnostics available if startup fails. The server also writes an
        # access log during successful sessions, so drain it with bounded storage.
        while chunk := self.process.stderr.read1(2048):
            self.recent_log = (self.recent_log + chunk)[-2048:]

    def dispatch(self, frame):
        if frame["type"] != "http":
            raise ValueError("Expected a resolution HTTP request.")
        ident = frame.get("id")
        if type(ident) is not int or not 0 <= ident < 2**53:
            raise ValueError("HTTP requests require a nonnegative integer id.")
        method, path = frame.get("method"), frame.get("path")
        allowed = ROUTES.get(method) if isinstance(method, str) else None
        if allowed is None or not isinstance(path, str) or not allowed.fullmatch(path):
            raise ValueError("Unsupported resolution request method or path.")
        body = decode(frame.get("body", ""), MAX_REQUEST)
        if method != "POST" and body:
            raise ValueError("Only POST accepts a request body.")
        if not self.slots.acquire(blocking=False):
            raise RuntimeError("Too many pending resolution requests.")
        self.pool.submit(self.request, ident, method, path, body)

    def request(self, ident, method, path, body):
        # Atlas deliberately allows a zeta replay to keep computing until it
        # finishes. Leave its loopback request open for the lifetime of the VM.
        timeout = None if method == "POST" and path.endswith("/zetas") else 180
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=body if method == "POST" else None,
                         headers={"Content-Type": "application/json"} if method == "POST" else {})
            response = conn.getresponse()
            if response.length is not None and response.length > MAX_RESPONSE:
                raise ValueError("Atlas response exceeds the 16 MiB browser limit.")
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError("Atlas response exceeds the 16 MiB browser limit.")
            send("response", id=ident, status=response.status, body=encode(data),
                 contentType=response.getheader("Content-Type", "application/json"))
        except (OSError, http.client.HTTPException, ValueError) as exc:
            if self.process.poll() is not None:
                send("error", id=ident, fatal=True, message="The local Atlas resolution service stopped.")
            else:
                send("error", id=ident, message=str(exc), permanent=isinstance(exc, ValueError))
        finally:
            conn.close()
            self.slots.release()

    def stop_process(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        self.log_reader.join(timeout=2)
        if not self.log_reader.is_alive():
            self.process.stderr.close()

    def close(self):
        self.stop_process()
        self.pool.shutdown(cancel_futures=True)


def main():
    def stop(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    attrs = None
    if os.isatty(0):
        attrs = termios.tcgetattr(0)
        tty.setraw(0, termios.TCSANOW)
    service = None
    try:
        # Start on a new line even if the emulator printed a partial boot message.
        sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
        send("hello", version=1)
        stream = sys.stdin.buffer
        while line := stream.readline(MAX_FRAME + 1):
            ident = {}
            try:
                if len(line) > MAX_FRAME:
                    while line and not line.endswith(b"\n"):
                        line = stream.readline(65536)
                    raise ValueError("Serial frame exceeds the request size limit.")
                if not line.startswith(PREFIX):
                    raise ValueError("Missing ATLAS1 frame prefix.")
                frame = json.loads(line[len(PREFIX):])
                if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
                    raise ValueError("Expected a JSON frame with a type.")
                if type(frame.get("id")) is int and 0 <= frame["id"] < 2**53:
                    ident["id"] = frame["id"]
                if service is None:
                    if frame["type"] == "hello":
                        resume_guest(frame)
                        continue
                    if frame["type"] != "init" or frame.get("role") not in ("terminal", "resolution"):
                        raise ValueError("Initialize a terminal or resolution VM first.")
                    role = frame["role"]
                    service = Terminal(frame) if role == "terminal" else Resolution()
                    send("ready", role=role)
                    if isinstance(service, Terminal):
                        service.reader.start()
                else:
                    service.dispatch(frame)
            except (OSError, ValueError, RuntimeError, RecursionError) as exc:
                send("error", message=str(exc), permanent=isinstance(exc, ValueError), **ident)
    finally:
        if service is not None:
            service.close()
        if attrs is not None:
            try:
                termios.tcsetattr(0, termios.TCSANOW, attrs)
            except termios.error:
                pass  # The browser may have closed the outer terminal.


if __name__ == "__main__":
    main()
