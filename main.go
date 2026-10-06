// erd-creator: serves the embedded Svelte ERD app + the schema grammar API.
// Go owns grammar (parse/generate/lint/dialects) and the .sql file store;
// the browser owns canvas interaction only.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed frontend/dist
var dist embed.FS

// shutdownTimeout bounds the drain window on SIGINT/SIGTERM. Requests here are
// small JSON/DDL replies that finish in milliseconds; 10s covers a stalled
// client without letting a stuck connection hold the process open forever.
const shutdownTimeout = 10 * time.Second

func main() {
	dir := flag.String("dir", "schemas", "directory holding .sql schema files")
	host := flag.String("host", "127.0.0.1", "interface to bind; empty string binds all interfaces")
	port := flag.Int("port", 8731, "TCP port to listen on; 0 picks a free one")
	flag.Parse()
	if err := ensureDir(*dir); err != nil {
		slog.Error("store init failed", "error", err)
		os.Exit(1)
	}
	addr, err := listenAddr(*host, *port)
	if err != nil {
		slog.Error("invalid listen address", "error", err)
		os.Exit(1)
	}
	sub, err := fs.Sub(dist, "frontend/dist")
	if err != nil {
		slog.Error("embedded dist missing", "error", err)
		os.Exit(1)
	}

	// A dedicated mux rather than http.DefaultServeMux so the hardening wraps
	// every route including the embedded file server, and so tests can build
	// the same handler without touching global state.
	mux := http.NewServeMux()
	mux.HandleFunc("/export", handleExport)
	mux.HandleFunc("/api/lint", handleSchemaAPI)
	mux.HandleFunc("/api/inserts", handleSchemaAPI)
	fileAPI := handleFiles(*dir)
	mux.Handle("/api/files", fileAPI)
	mux.Handle("/api/files/", fileAPI)
	fileServer := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// SPA fallback: unknown paths serve index.html. Guard the empty path
		// before slicing (r.URL.Path[1:] panics on ""), and mutate a copy so
		// middleware logging below still sees the original request path.
		p := r.URL.Path
		if p == "" {
			p = "/"
		}
		if _, err := fs.Stat(sub, strings.TrimPrefix(p, "/")); err != nil {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	})

	// Order matters: securityHeaders is outermost so every reply — including
	// hostGuard/sameOriginGuard refusals — carries CSP/nosniff/DENY. The guards
	// run before any handler, so a rebinding request is still refused before
	// it reaches the mux.
	var h http.Handler = mux
	h = hostGuard(*host)(h)
	h = sameOriginGuard(h)
	h = recoverPanic(h)
	h = requestLog(h)
	h = securityHeaders(h)

	// Listen explicitly rather than http.ListenAndServe so the log line can
	// report the port actually bound — with -port 0 that is the only way to
	// learn it — and so a bind failure is reported once, with the address.
	//nolint:noctx // startup listener, no request context exists yet
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("listen failed", "addr", addr, "error", err)
		os.Exit(1)
	}
	slog.Info("erd-creator started", "url", displayURL(ln.Addr()), "dir", *dir)
	if *host == "" || *host == "0.0.0.0" || *host == "::" {
		slog.Warn("listening on all interfaces with no authentication; restrict -host to loopback on untrusted networks", "host", *host)
	}
	srv := newServer(h)

	// Graceful shutdown on SIGINT/SIGTERM. A hard kill would not corrupt a
	// file — saves are atomic temp+rename — but it would truncate a reply the
	// browser is mid-read. Shutdown closes the listener (Serve then returns
	// ErrServerClosed) and drains in-flight requests for up to shutdownTimeout;
	// done closes only when the drain has finished, so main exits after it.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-quit
		slog.Info("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			slog.Error("shutdown failed", "error", err)
		}
	}()

	// Serve rather than ListenAndServe: the listener is already bound, so the
	// resolved port is known and logged before the first request is accepted.
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
	<-done
}

// listenAddr joins the -host and -port flags into an address net.Listen
// accepts. JoinHostPort is used rather than string concatenation because it
// brackets IPv6 literals: "::1" + ":" + "8731" would be the ambiguous
// "::1:8731", whereas JoinHostPort yields "[::1]:8731".
//
// An empty host is deliberately allowed: it binds every interface, which is
// what "expose this on my LAN" needs. The default stays loopback-only.
func listenAddr(host string, port int) (string, error) {
	if port < 0 || port > 65535 {
		return "", fmt.Errorf("invalid port %d: want 0-65535", port)
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// displayURL renders a bound address for the startup log. A wildcard bind is
// reachable but is not itself a usable URL, so it is labelled instead —
// printing "http://0.0.0.0:8731" invites a click that cannot work.
func displayURL(addr net.Addr) string {
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	switch host {
	case "0.0.0.0", "::":
		return fmt.Sprintf("http://localhost:%s (all interfaces)", port)
	}
	return "http://" + net.JoinHostPort(host, port)
}

// schemaAPI: POST schema JSON → answer. Path→renderer table:
// /api/lint → JSON diagnostics, /api/inserts → seed-row SQL text.
var schemaAPI = map[string]func(http.ResponseWriter, *Schema){
	"/api/lint": func(w http.ResponseWriter, s *Schema) {
		l := s.Lint()
		if l == nil {
			l = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		writeJSON(w, l)
	},
	"/api/inserts": func(w http.ResponseWriter, s *Schema) {
		out, err := s.GenInserts()
		if err != nil {
			failValidation(w, err)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		writeText(w, out)
	},
}

func handleSchemaAPI(w http.ResponseWriter, r *http.Request) {
	s, ok := decodeSchema(w, r)
	if !ok {
		return
	}
	// /api/inserts emits SQL text from this schema, so it is a generation
	// boundary just like /export. /api/lint only reads, but validating both
	// keeps one rule for every schema-accepting endpoint.
	if err := s.Validate(); err != nil {
		failValidation(w, err)
		return
	}
	render, ok := schemaAPI[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	render(w, s)
}

const MaxBody = 1 << 20 // 1 MiB request cap, shared by readCappedBody callers

// readCappedBody enforces the 1 MiB cap and returns the raw body. It checks no
// method: decodeBody (POST endpoints) wraps it with a POST-only guard, while
// saveFile serves PUT (routed by handleFiles) and must NOT inherit that guard.
func readCappedBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad body: "+err.Error(), http.StatusBadRequest)
		return nil, false
	}
	return b, true
}

// decodeBody enforces POST-only + 1 MiB cap and returns the raw body.
// Shared by every JSON-accepting POST endpoint.
func decodeBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return nil, false
	}
	return readCappedBody(w, r)
}

// writeJSON encodes v as the response body. The encode error is reported rather
// than dropped: by the time Encode runs the status line is already committed, so
// a failure cannot be turned into an error response — it would reach the client
// as a truncated body under a 200. The log line is the only record of that.
//
// The parameter stays `any` because json.NewEncoder.Encode takes `any`: callers
// legitimately pass []string, []fileInfo and *Schema, and a narrower type here
// would gain no checking the encoder itself does not perform.
func writeJSON(w http.ResponseWriter, v any) {
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("response encode failed", "error", err)
	}
}

// writeText writes a plain-text response body, logging a failed write for the
// same reason as writeJSON: the header is already sent, so a short write cannot
// be surfaced to the client and would otherwise pass silently.
func writeText(w http.ResponseWriter, body string) {
	if _, err := fmt.Fprint(w, body); err != nil {
		slog.Error("response write failed", "error", err)
	}
}

// schemaEnvelope is the accepted POST body shape for every schema endpoint:
// either {"schema":{"tables":[...]}} or the bare {"tables":[...]}.
//
// Dialect and SqliteTypes may ride alongside the bare tables — that is the
// wire shape PUT (saveFile) sends, which stores the full Schema JSON. POST
// endpoints ignore them (lint/inserts) or take the dialect as their own field
// (export), but decodeSchemaJSON must preserve them or a bare {"tables",...,
// "dialect":"sqlite"} body would come back as a mysql schema.
type schemaEnvelope struct {
	Schema      Schema  `json:"schema"`
	Tables      []Table `json:"tables"`
	Dialect     string  `json:"dialect"`
	SqliteTypes string  `json:"sqliteTypes"`
}

// schema returns the payload from whichever envelope field was populated.
// Both are accepted so callers may post a bare table list. The bare form is
// synthesized, never written into the envelope: mutating e.Schema in place
// meant decodeSchemaJSON and handleExport saw call-order-dependent state.
func (e *schemaEnvelope) schema() *Schema {
	if len(e.Schema.Tables) != 0 {
		return &e.Schema
	}
	return &Schema{Tables: e.Tables, Dialect: e.Dialect, SqliteTypes: e.SqliteTypes}
}

// decodeSchemaJSON parses an envelope body. Shared by decodeSchema and
// handleExport so the accepted shapes stay identical.
func decodeSchemaJSON(b []byte) (*Schema, error) {
	var req schemaEnvelope
	if err := json.Unmarshal(b, &req); err != nil {
		return nil, err
	}
	return req.schema(), nil
}

// decodeSchema reads a {schema:{tables}} or bare {tables} POST body.
func decodeSchema(w http.ResponseWriter, r *http.Request) (*Schema, bool) {
	b, ok := decodeBody(w, r)
	if !ok {
		return nil, false
	}
	s, err := decodeSchemaJSON(b)
	if err != nil {
		failBadJSON(w, err)
		return nil, false
	}
	return s, true
}

// failValidation rejects a schema that cannot be represented safely.
// The error is user-safe by construction (validated type/action/comment
// excerpts), so it is echoed; internal filesystem faults use internalFail.
func failValidation(w http.ResponseWriter, err error) {
	http.Error(w, "invalid schema: "+err.Error(), http.StatusBadRequest)
}

// failBadJSON rejects a body that is not JSON. The message is the decoder's,
// which names syntax, never paths.
func failBadJSON(w http.ResponseWriter, err error) {
	http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
}
