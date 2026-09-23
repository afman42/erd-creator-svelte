#!/usr/bin/env sh
# Emit PLATFORMS as a GitHub Actions matrix payload (JSON array).
#
# CI derives its build matrix from this, so the platform list lives in one
# place — adding a platform to PLATFORMS is enough, and the workflow needs no
# edit. Each entry carries the per-platform output name, including the .exe
# suffix that only Windows needs.
#
# Usage: scripts/platforms-json.sh
#   -> [{"goos":"linux","goarch":"amd64","bin":"erd-creator-linux-amd64"}, ...]
set -eu

BIN="${BIN:-erd-creator}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64}"

printf '['
sep=""
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
	printf '%s{"goos":"%s","goarch":"%s","bin":"%s-%s-%s%s"}' \
		"$sep" "$os" "$arch" "$BIN" "$os" "$arch" "$ext"
	sep=","
done
printf ']'
