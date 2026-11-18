"""Exercise serial startup and error states without building a mathematical kernel."""

import base64
import os
from pathlib import Path
import sys
import tempfile
import unittest

from runtime.guest.smoke import SerialGuest


class GuestProtocolTests(unittest.TestCase):
    def test_warm_handshake_and_child_startup_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            atlas = Path(directory) / "atlas"
            atlas.write_text("#!/bin/sh\necho 'missing runtime library' >&2\nexit 1\n", encoding="utf-8")
            atlas.chmod(0o755)
            with SerialGuest(atlas.parent) as guest:
                self.assertEqual(guest.receive(), {"type": "hello", "version": 1})
                guest.send(type="hello", entropy=base64.b64encode(b"short").decode())
                error = guest.receive()
                self.assertEqual(error["type"], "error")
                self.assertIn("32 bytes", error["message"])
                for _ in range(2):
                    guest.send(type="hello", entropy=base64.b64encode(os.urandom(32)).decode())
                    self.assertEqual(guest.receive(), {"type": "hello", "version": 1, "resumed": True})
                guest.send(type="init", role="resolution")
                error = guest.receive()
                self.assertEqual(error["type"], "error")
                self.assertIn("missing runtime library", error["message"])

    def test_oversized_result_is_permanent_and_leaves_guest_available(self):
        # Announce an oversized body without having to allocate or transmit one.
        with tempfile.TemporaryDirectory() as directory:
            atlas = Path(directory) / "atlas"
            atlas.write_text(f"#!{sys.executable}\n" + """
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if self.path == "/api/health":
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
        else:
            self.send_header("Content-Length", str(16 * 1024 * 1024 + 1))
            self.end_headers()

server = HTTPServer(("127.0.0.1", 0), Handler)
print(f"Resolution Atlas: http://127.0.0.1:{server.server_port}", flush=True)
server.serve_forever()
""", encoding="utf-8")
            atlas.chmod(0o755)
            with SerialGuest(atlas.parent) as guest:
                guest.init("resolution")
                guest.send(type="http", id=1, method="GET", path="/api/searches/" + "a" * 32)
                error = guest.receive()
                self.assertEqual((error["type"], error["id"], error["permanent"]), ("error", 1, True))
                self.assertIn("16 MiB", error["message"])
                self.assertEqual(guest.http("GET", "/api/health"), (200, {}))


if __name__ == "__main__":
    unittest.main()
