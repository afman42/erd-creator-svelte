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
	"net/http"
)

//go:embed frontend/dist
var dist embed.FS

func main() {
	dir := flag.String("dir", "schemas", "directory holding .sql schema files")
	flag.Parse()
	if err := ensureDir(*dir); err != nil {
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
	addr := "127.0.0.1:8731"
	log.Printf("erd-creator on http://%s (schemas: %s)", addr, *dir)
	log.Fatal(http.ListenAndServe(addr, nil))
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
