# erd-creator — dist must exist before go build (go:embed frontend/dist).
GO := go
BIN := erd-creator

.PHONY: all build frontend test lint run fmt clean

all: build

build: frontend $(BIN)

frontend:
	cd frontend && pnpm install --frozen-lockfile && pnpm run build

$(BIN): main.go grammar.go files.go export.go frontend/dist/index.html
	$(GO) build -trimpath -ldflags "-s -w" -o $(BIN) .

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

clean:
	rm -f $(BIN)
	rm -rf frontend/dist

frontend/dist/index.html:
	$(MAKE) frontend
