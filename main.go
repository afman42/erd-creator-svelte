// erd-creator: serves the embedded Svelte ERD app + the schema grammar API.
// Go owns grammar (parse/generate/lint/dialects) and the .sql file store;
// the browser owns canvas interaction only.
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
)

//go:embed frontend/dist
var dist embed.FS

func main() {
	dir := flag.String("dir", "schemas", "directory holding .sql schema files")
	host := flag.String("host", "127.0.0.1", "interface to bind; empty string binds all interfaces")
	port := flag.Int("port", 8731, "TCP port to listen on; 0 picks a free one")
	flag.Parse()
	if err := ensureDir(*dir); err != nil {
		log.Fatal(err)
	}
	addr, err := listenAddr(*host, *port)
	if err != nil {
		log.Fatal(err)
	}
	sub, err := fs.Sub(dist, "frontend/dist")
	if err != nil {
		log.Fatal(err)
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
		// SPA fallback: unknown paths serve index.html.
		if _, err := fs.Stat(sub, r.URL.Path[1:]); err != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})

	// Order matters: the Host allowlist runs first so a rebinding request is
	// refused before it reaches any handler, then the same-origin check, then
	// the response headers (set on the way out, including on those refusals).
	var h http.Handler = mux
	h = securityHeaders(h)
	h = sameOriginGuard(h)
	h = hostGuard(*host)(h)

	// Listen explicitly rather than http.ListenAndServe so the log line can
	// report the port actually bound — with -port 0 that is the only way to
	// learn it — and so a bind failure is reported once, with the address.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("cannot listen on %s: %v", addr, err)
	}
	log.Printf("erd-creator on %s (schemas: %s)", displayURL(ln.Addr()), *dir)
	srv := newServer(h)
	// Serve rather than ListenAndServe: the listener is already bound, so the
	// resolved port is known and logged before the first request is accepted.
	log.Fatal(srv.Serve(ln))
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
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		writeText(w, s.GenInserts())
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
		http.Error(w, "invalid schema: "+err.Error(), http.StatusBadRequest)
		return
	}
	render, ok := schemaAPI[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	render(w, s)
}

// decodeBody enforces POST-only + 1 MiB cap and returns the raw body.
// Shared by every JSON-accepting endpoint.
func decodeBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad body: "+err.Error(), http.StatusBadRequest)
		return nil, false
	}
	return b, true
}

// writeJSON encodes v as the response body. The encode error is reported rather
// than dropped: by the time Encode runs the status line is already committed, so
// a failure cannot be turned into an error response — it would reach the client
// as a truncated body under a 200. The log line is the only record of that.
func writeJSON(w http.ResponseWriter, v any) {
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

// writeText writes a plain-text response body, logging a failed write for the
// same reason as writeJSON: the header is already sent, so a short write cannot
// be surfaced to the client and would otherwise pass silently.
func writeText(w http.ResponseWriter, body string) {
	if _, err := fmt.Fprint(w, body); err != nil {
		log.Printf("write text: %v", err)
	}
}

// schemaEnvelope is the accepted POST body shape for every schema endpoint:
// either {"schema":{"tables":[...]}} or the bare {"tables":[...]}.
type schemaEnvelope struct {
	Schema Schema  `json:"schema"`
	Tables []Table `json:"tables"`
}

// schema returns the payload from whichever envelope field was populated.
// Both are accepted so callers may post a bare table list.
func (e *schemaEnvelope) schema() *Schema {
	if len(e.Schema.Tables) == 0 {
		e.Schema.Tables = e.Tables
	}
	return &e.Schema
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
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return nil, false
	}
	return s, true
}
