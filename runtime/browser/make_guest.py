"""Assemble a self-contained Linux initramfs around an already-built native Atlas."""

import argparse
import compileall
import gzip
import os
import py_compile
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import sysconfig
import tempfile


def copy_guest(root, bridge, init):
    def copy(source, name):
        destination = root / name.lstrip("/")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    for directory in ("dev", "proc", "sys", "tmp", "etc"):
        (root / directory).mkdir()
    copy(init, "/init")
    copy("/usr/bin/busybox-static", "/bin/busybox")
    (root / "bin/sh").symlink_to("busybox")
    copy(sys.executable, "/usr/bin/python3")
    copy(bridge, "/opt/atlas-guest/bridge.py")
    shutil.copytree("/opt/atlas", root / "opt/atlas", symlinks=True,
                    ignore=shutil.ignore_patterns("__pycache__"))
    stdlib = Path(sysconfig.get_path("stdlib"))
    python_tree = root / stdlib.relative_to("/")
    shutil.copytree(stdlib, python_tree, symlinks=False, ignore=shutil.ignore_patterns(
        "__pycache__", "*.pyc", "test", "tests", "site-packages", "dist-packages",
        "ensurepip", "idlelib", "tkinter", "turtledemo", "config-*", "build-details*.json"))
    # CPU time on the browser emulator is scarce. Compile Python's matching
    # bytecode once on the builder, and keep paths in code objects guest-local.
    for tree in (python_tree, root / "opt/atlas/engine", root / "opt/atlas-guest"):
        if not compileall.compile_dir(tree, quiet=1, force=True, stripdir=root,
                                      prependdir="/", invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH):
            raise RuntimeError(f"Cannot compile guest modules in {tree}")
    (root / "etc/passwd").write_text("root:x:0:0:Atlas:/tmp:/bin/sh\n")
    (root / "etc/group").write_text("root:x:0:\n")
    (root / "etc/hosts").write_text("127.0.0.1 localhost\n")
    (root / "tmp").chmod(0o1777)

    # Follow each binary using its original location so $ORIGIN library lookups
    # match its installed layout. ldd includes the transitive dependencies.
    binaries = [Path(sys.executable), *stdlib.glob("lib-dynload/*.so")]
    binaries.extend(p for p in Path("/opt/atlas/native/build").iterdir()
                    if p.is_file() and not p.is_symlink())
    needed = set()
    for binary in binaries:
        output = subprocess.check_output(["ldd", str(binary)], text=True)
        if "=> not found" in output:
            raise RuntimeError(f"Missing dependency of {binary}: {output}")
        needed.update(re.findall(r"^\s*(?:[^\s]+ => )?(/\S+) \(0x", output, re.M))
    for library in sorted(needed):
        # /opt/atlas already contains the native libraries.
        if not library.startswith("/opt/atlas/"):
            copy(library, library)
    shutil.copytree("/usr/share/common-licenses", root / "usr/share/common-licenses",
                    symlinks=False)
    # Keep distribution notices with the software. Debian/Ubuntu package
    # copyright files list individual upstream copyright holders and licenses.
    for package in ("busybox-static", "python3.14", "libc6", "libgcc-s1", "libstdc++6",
                    "libflint24", "libgmp10", "libgmpxx4ldbl", "libmpfr6", "libjsoncpp26",
                    "libnormaliz3", "libeantic3", "libnauty-2.9.3", "libgomp1"):
        notice = Path("/usr/share/doc") / package / "copyright"
        if notice.exists():
            copy(notice, str(notice))


def pack(root, output):
    # Linux's "newc" wire format. Generate it directly so unprivileged builders
    # can include /dev/console and give every entry stable root ownership.
    sequence = 0
    with open(output, "wb") as raw, gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0) as stream:
        def member(name, mode, data=b"", device=(0, 0)):
            nonlocal sequence
            sequence += 1
            encoded = os.fsencode(name) + b"\0"
            fields = (sequence, mode, 0, 0, 1, 0, len(data), 0, 0, *device, len(encoded), 0)
            stream.write(b"070701" + "".join(f"{v:08x}" for v in fields).encode() + encoded)
            stream.write(b"\0" * (-(110 + len(encoded)) % 4))
            stream.write(data)
            stream.write(b"\0" * (-len(data) % 4))

        for path in sorted(root.rglob("*")):
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                data = os.fsencode(os.readlink(path))
            elif stat.S_ISREG(mode):
                data = path.read_bytes()
            else:
                data = b""
            member(str(path.relative_to(root)), mode, data)
        member("dev/console", stat.S_IFCHR | 0o600, device=(5, 1))
        member("dev/null", stat.S_IFCHR | 0o666, device=(1, 3))
        member("TRAILER!!!", 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", required=True, type=Path)
    parser.add_argument("--init", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as work:
        copy_guest(Path(work), args.bridge, args.init)
        pack(Path(work), args.output)
