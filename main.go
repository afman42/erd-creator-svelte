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

	http.HandleFunc("/export", handleExport)
	http.HandleFunc("/api/lint", handleSchemaAPI)
	http.HandleFunc("/api/inserts", handleSchemaAPI)
	fileAPI := handleFiles(*dir)
	http.Handle("/api/files", fileAPI)
	http.Handle("/api/files/", fileAPI)
	fileServer := http.FileServer(http.FS(sub))
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// SPA fallback: unknown paths serve index.html.
		if _, err := fs.Stat(sub, r.URL.Path[1:]); err != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
	// Listen explicitly rather than http.ListenAndServe so the log line can
	// report the port actually bound — with -port 0 that is the only way to
	// learn it — and so a bind failure is reported once, with the address.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("cannot listen on %s: %v", addr, err)
	}
	log.Printf("erd-creator on %s (schemas: %s)", displayURL(ln.Addr()), *dir)
	log.Fatal(http.Serve(ln, nil))
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
		json.NewEncoder(w).Encode(l)
	},
	"/api/inserts": func(w http.ResponseWriter, s *Schema) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, s.GenInserts())
	},
}

func handleSchemaAPI(w http.ResponseWriter, r *http.Request) {
	s, ok := decodeSchema(w, r)
	if !ok {
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
