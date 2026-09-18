# erd-creator — dist must exist before go build (go:embed frontend/dist).
GO := go
BIN := erd-creator
DIST_BIN := dist-bin

# CGO off makes the binary self-contained: no glibc dependency, and it is what
# lets a single host cross-compile every target below. Nothing here uses cgo.
export CGO_ENABLED := 0

# -s -w strips the symbol table and DWARF; -trimpath keeps build paths out of
# the binary so builds are reproducible across machines.
LDFLAGS := -trimpath -ldflags "-s -w"

# linux/amd64 is the primary target; the rest are for handing someone one file.
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

# Every asset, not just index.html. index.html is rewritten by vite on each
# build, but it is the wrong thing to depend on: a change to a hashed asset
# alone (a locally-edited dist, a partial restore) would leave make thinking
# the binary was current and silently ship a stale UI. go.mod matters too —
# a toolchain bump changes the output.
GO_SRC := $(wildcard *.go) go.mod

.PHONY: all build frontend test lint fmt run clean dist clean-dist

all: build

# frontend is a real prerequisite of $(BIN), not just a sibling, so `make -j`
# cannot start the Go build while vite is still writing dist/.
build: frontend $(BIN)

frontend:
	cd frontend && pnpm install --frozen-lockfile && pnpm run build

$(BIN): $(GO_SRC) frontend
	$(GO) build $(LDFLAGS) -o $(BIN) .

test:
	cd frontend && pnpm install --frozen-lockfile && pnpm test && pnpm run build
	$(GO) test -count=1 ./...

lint:
	test -z "$$(gofmt -l .)" || { gofmt -l .; exit 1; }
	$(GO) vet ./...
	cd frontend && pnpm run lint

fmt:
	$(GO) fmt .
	cd frontend && pnpm run fmt

run: build
	./$(BIN)

# Cross-compile every platform into dist-bin/. Requires the frontend built
# first (go:embed), so it depends on the frontend target.
# The loop is one physical line on purpose: linters that shellcheck each recipe
# line in isolation cannot see variables assigned on a previous \ continuation,
# so the multi-line form reports spurious "appears unused" warnings.
dist: frontend
	rm -rf $(DIST_BIN)
	mkdir -p $(DIST_BIN)
	for p in $(PLATFORMS); do os=$${p%/*}; arch=$${p#*/}; ext=""; if [ "$$os" = windows ]; then ext=".exe"; fi; out=$(DIST_BIN)/$(BIN)-$$os-$$arch$$ext; echo "  building $$out"; GOOS=$$os GOARCH=$$arch $(GO) build $(LDFLAGS) -o $$out . || exit 1; done
	echo "--- $(DIST_BIN) ---"
	ls -la $(DIST_BIN)

clean-dist:
	rm -rf $(DIST_BIN)

clean:
	rm -f $(BIN)
	rm -rf frontend/dist $(DIST_BIN)
