// Package frontendtest is a marker so `go test ./...` skips this JS-only test
// dir with "no test files" instead of "setup failed".
// Real runner: cd frontend && pnpm test.
package frontendtest
