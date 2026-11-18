"""Exercise both live tools in an already running single-user Atlas Jupyter server."""

import argparse
import json
import os
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

from websocket import create_connection


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        key = {"script": "src", "link": "href"}.get(tag)
        value = dict(attrs).get(key)
        if key and value:
            self.urls.append(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", help="Jupyter base URL including any /user/.../ prefix")
    args = parser.parse_args()
    base = args.base_url.rstrip("/") + "/"
    token = os.getenv("JUPYTER_TOKEN")
    headers = {"Authorization": "token " + token} if token else {}

    def fetch(url, payload=None):
        request = Request(url, headers=headers)
        if payload is not None:
            request.data = json.dumps(payload).encode()
            request.add_header("Content-Type", "application/json")
        with urlopen(request, timeout=40) as response:
            return response.read()

    suite = urljoin(base, "atlas-resolution/")
    assets = Assets()
    assets.feed(fetch(suite).decode())
    if not assets.urls:
        raise RuntimeError("Resolution workspace has no assets")
    for asset in assets.urls:
        url = urljoin(suite, asset)
        if not url.startswith(suite):
            raise RuntimeError(f"Resolution asset leaves its workspace: {asset}")
        fetch(url)
    job = json.loads(fetch(urljoin(suite, "api/searches"), {
        "polynomial": "y^2-x^3", "variables": ["x", "y"], "mode": "embedded",
        "search": "quick", "zetas": ["monodromy"],
    }))
    deadline = time.monotonic() + 60
    while job["state"] in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(0.25)
        job = json.loads(fetch(urljoin(suite, "api/searches/" + job["id"])))
    if job["state"] != "completed":
        raise RuntimeError(f"Cusp search ended in state {job['state']}")
    result = job["result"]
    if result["status"] != "resolved" or result["monodromy_zeta"]["expression"] != "(1-T^6)/((1-T^2)*(1-T^3))":
        raise RuntimeError("Unexpected cusp resolution")
    print("Resolution suite resolved the cusp and computed its monodromy zeta.")

    terminal = urljoin(base, "atlas-terminal/")
    fetch(terminal)
    auth = json.loads(fetch(urljoin(terminal, "token")))
    ws = urlsplit(urljoin(terminal, "ws"))
    ws = ws._replace(scheme={"http": "ws", "https": "wss"}[ws.scheme])
    # This handshake and the leading 0 input/output frame are ttyd's PTY protocol.
    connection = create_connection(ws.geturl(), subprotocols=["tty"], header=headers, timeout=30)
    try:
        connection.send_binary(json.dumps({"AuthToken": auth["token"], "columns": 80, "rows": 24}).encode())
        connection.send_binary(b'0x, y = coordinates("x", "y")\r')
        connection.send_binary(b'0print("Milnor result", milnor_number(y^2 - x^3).value)\r')
        output = bytearray()
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            frame = connection.recv()
            if isinstance(frame, bytes) and frame.startswith(b"0"):
                output.extend(frame[1:])
                if b"Milnor result 2" in output:
                    break
            if not frame:
                raise RuntimeError("Atlas terminal closed before printing the Milnor number")
        else:
            raise RuntimeError("Atlas terminal did not return the cusp Milnor number")
        connection.send_binary(b"0exit\r")
    finally:
        connection.close()
    print("Atlas terminal kept its coordinates and returned Milnor number 2.")


if __name__ == "__main__":
    main()
