"""Fetch the precompiled AMD64 emulator, BIOS and kernel from the QEMU Wasm demo."""

import argparse
import hashlib
import shutil
from pathlib import Path
import urllib.request

SOURCE = ("https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/"
          "b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/")
FILES = {
    "out.js": "dab94140dc2ea847181ba47ae4cbd759728e551d8fd9ba9de409711ed25eddcc",
    "qemu-system-x86_64.wasm": "f53107a35029d676aa551cd00d042f4f65af39a89bf72464494321fafdf54191",
    "qemu-system-x86_64.worker.js": "8efab02a9cb5ee63ced22e9853bce74cbb895d15a5fb3d5139fef855c50f62ea",
    "load-kernel.data": "dd239e40daf62dfb34e1bedb281ee66a98ae9664935d0471c026726629a52c25",
    "load-rom.data": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9",
}
# Offsets from the upstream load-rom.js Emscripten file packager manifest.
ROM_OFFSETS = (
    ("bios-256k.bin", 0, 262144),
    ("efi-virtio.rom", 262144, 422912),
    ("kvmvapic.bin", 422912, 432128),
    ("linuxboot_dma.bin", 432128, 433664),
    ("vgabios-stdvga.bin", 433664, 473088),
)


def fetch(out):
    (out / "rom").mkdir(exist_ok=True, parents=True)
    for notice in ("NOTICE.txt", "GPL-2.txt"):
        shutil.copyfile(Path(__file__).with_name(notice), out / notice)
    for name, digest in FILES.items():
        with urllib.request.urlopen(SOURCE + name, timeout=90) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"Unexpected contents for {name}")
        if name == "load-rom.data":
            for filename, start, end in ROM_OFFSETS:
                (out / "rom" / filename).write_bytes(data[start:end])
        else:
            (out / ("vmlinuz" if name == "load-kernel.data" else name)).write_bytes(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    fetch(parser.parse_args().output)
