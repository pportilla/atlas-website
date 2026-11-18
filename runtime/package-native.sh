#!/bin/sh
# Build in an empty directory so a developer's native/build cannot enter the image.
set -eu
upstream=$1
dest=$2
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
pkg-config --atleast-version=3.6.0 flint
tar -C "$upstream" --exclude='native/build' --exclude='__pycache__' -cf "$build_dir/source.tar" Makefile native
tar -C "$build_dir" -xf "$build_dir/source.tar"
make -C "$build_dir" -j"${BUILD_JOBS:-2}"
mkdir -p "$dest/native/build"
# Native libraries and executables sit directly under native/build. Preserve
# symlinks such as native/build/ideal_sum -> local_algebra.
find "$build_dir/native/build" -maxdepth 1 \( -type f -o -type l \) -exec cp -a -t "$dest/native/build/" {} +
find "$dest/native/build" -type f -exec strip --strip-unneeded {} +
tar -C "$upstream" --exclude='__pycache__' -cf "$build_dir/runtime.tar" atlas engine web
tar -C "$dest" -xf "$build_dir/runtime.tar"
