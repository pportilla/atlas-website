"""Test the browser VM bridge through a raw serial PTY against a built Atlas checkout."""

import argparse
import base64
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time


PREFIX = b"ATLAS1 "


class SerialGuest:
    def __init__(self, atlas):
        self.master, slave = os.openpty()
        try:
            self.child = subprocess.Popen([sys.executable, Path(__file__).with_name("bridge.py")],
                                          stdin=slave, stdout=slave, env={**os.environ, "ATLAS_ROOT": str(atlas)})
        finally:
            os.close(slave)
        self.buffer = bytearray()
        self.ident = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.child.terminate()
        try:
            self.child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
        os.close(self.master)

    def send(self, **frame):
        data = memoryview(PREFIX + json.dumps(frame).encode("ascii") + b"\n")
        while data:
            data = data[os.write(self.master, data):]

    def receive(self, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            end = self.buffer.find(b"\n")
            if end >= 0:
                line = bytes(self.buffer[:end])
                del self.buffer[:end + 1]
                if not line:
                    continue
                if not line.startswith(PREFIX):
                    raise AssertionError(f"Unexpected serial data: {line[:80]!r}")
                return json.loads(line[len(PREFIX):])
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.master], [], [], remaining)[0]:
                raise TimeoutError("No complete serial response")
            self.buffer.extend(os.read(self.master, 65536))

    def init(self, role):
        assert self.receive() == {"type": "hello", "version": 1}
        self.send(type="init", role=role)
        assert self.receive() == {"type": "ready", "role": role}

    def http(self, method, path, payload=None):
        self.ident += 1
        body = json.dumps(payload).encode() if payload is not None else b""
        self.send(type="http", method=method, path=path, id=self.ident,
                  body=base64.b64encode(body).decode())
        reply = self.receive()
        assert reply["id"] == self.ident and reply["type"] == "response", reply
        assert reply["contentType"].startswith("application/json")
        return reply["status"], json.loads(base64.b64decode(reply["body"], validate=True))


def smoke(atlas):
    with SerialGuest(atlas) as guest:
        guest.init("terminal")
        guest.send(type="resize", cols=100, rows=30)
        commands = b'x, y = coordinates("x","y")\rprint("Cusp result",milnor_number(y^2-x^3).value)\rexit\r'
        guest.send(type="input", data=base64.b64encode(commands).decode())
        output = bytearray()
        while True:
            frame = guest.receive()
            if frame["type"] == "exit":
                assert frame["code"] == 0, frame
                break
            assert frame["type"] == "output", frame
            output.extend(base64.b64decode(frame["data"], validate=True))
        assert b"Cusp result 2" in output, output[-256:]
        print("Serial PTY: Atlas kept bindings, returned Milnor number 2, and exited.")

    with SerialGuest(atlas) as guest:
        guest.init("resolution")
        guest.send(type="http", id=0, method="GET", path="/index.html")
        error = guest.receive()
        assert error["type"] == "error" and error["id"] == 0, error
        assert guest.http("GET", "/api/health") == (200, {"status": "ok"})
        # The JSON frame exceeds the canonical TTY's 4096-byte line limit.
        status, job = guest.http("POST", "/api/searches", {
            "polynomial": "y^2-x^3", "variables": ["x", "y"], "mode": "embedded",
            "search": "quick", "zetas": ["monodromy"], "padding": " " * 8192,
        })
        assert status in (200, 202), job
        deadline = time.monotonic() + 45
        while job["state"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.15)
            status, job = guest.http("GET", "/api/searches/" + job["id"])
            assert status == 200
        assert job["state"] == "completed", job["state"]
        assert job["result"]["monodromy_zeta"]["expression"] == "(1-T^6)/((1-T^2)*(1-T^3))"
        status, result = guest.http("POST", "/api/zetas", {"record": {}, "zetas": []})
        assert status == 400 and "error" in result, result
        print("Serial HTTP: queued and resolved the cusp; native zeta and error responses survived transport.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("atlas", type=Path, help="Built Atlas checkout or runtime installation")
    smoke(parser.parse_args().atlas.resolve())
