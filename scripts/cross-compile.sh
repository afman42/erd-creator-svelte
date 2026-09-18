#!/usr/bin/env sh
# Cross-compile erd-creator for every platform in PLATFORMS.
#
# Usage: scripts/cross-compile.sh [platform ...]
#   No arguments  -> build every platform in PLATFORMS.
#   With args     -> build only those (e.g. scripts/cross-compile.sh linux/arm64).
#
# Output goes to dist-bin/ as erd-creator-<os>-<arch>[.exe].
#
# Requires frontend/dist to exist: the Svelte app is embedded with go:embed,
# which is resolved from the source tree at build time, so one frontend build
# serves every target. Run `make frontend` first (the Makefile does).
#
# This lives in a script rather than a Makefile recipe so it can be linted and
# run directly. Long single-line recipes defeat line-based shell linters, which
# parse each line in isolation and report every variable as unused.
set -eu

BIN="${BIN:-erd-creator}"
OUT_DIR="${DIST_BIN:-dist-bin}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64}"

# CGO off is what makes cross-compilation possible from a single host, and it
# leaves the binaries statically linked. Nothing in this project uses cgo.
CGO_ENABLED=0
export CGO_ENABLED

# Flags are inlined at the call site rather than held in a variable: a shell
# variable cannot preserve the internal space of `-ldflags=-s -w`, so it would
# split into `-ldflags=-s` and a stray `-w` ("flag provided but not defined").
# -trimpath keeps build paths out of the binary, so builds are reproducible
# across machines; -s -w strips the symbol table and DWARF.

if [ ! -d frontend/dist ]; then
	echo "error: frontend/dist is missing — run 'make frontend' first" >&2
	exit 1
fi

if [ "$#" -gt 0 ]; then
	PLATFORMS="$*"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for platform in $PLATFORMS; do
	os=${platform%/*}
	arch=${platform#*/}
	if [ "$os" = "$platform" ] || [ -z "$arch" ]; then
		echo "error: bad platform '$platform' (want os/arch, e.g. linux/amd64)" >&2
		exit 1
	fi

	ext=""
	if [ "$os" = windows ]; then
		ext=".exe"
	fi
	out="$OUT_DIR/$BIN-$os-$arch$ext"

	echo "  building $out"
	GOOS=$os GOARCH=$arch go build -trimpath -ldflags="-s -w" -o "$out" .
done

echo "--- $OUT_DIR ---"
ls -la "$OUT_DIR"
