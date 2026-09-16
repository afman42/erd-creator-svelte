// erd-creator: serves the embedded Svelte ERD app + the schema grammar API.
// Go owns grammar (parse/generate/lint/dialects) and the .sql file store;
// the browser owns canvas interaction only.
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
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
	http.HandleFunc("/api/lint", handleLint)
	http.HandleFunc("/api/inserts", handleInserts)
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

// handleLint / handleInserts: POST schema JSON → text answer.
func handleLint(w http.ResponseWriter, r *http.Request) {
	s, ok := decodeSchema(w, r)
	if !ok {
		return
	}
	l := s.Lint()
	if l == nil {
		l = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(l)
}

func handleInserts(w http.ResponseWriter, r *http.Request) {
	s, ok := decodeSchema(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, s.GenInserts())
}

// decodeSchema reads a {schema:{tables}} or bare {tables} POST body.
func decodeSchema(w http.ResponseWriter, r *http.Request) (*Schema, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req struct {
		Schema Schema  `json:"schema"`
		Tables []Table `json:"tables"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return nil, false
	}
	s := &req.Schema
	if len(s.Tables) == 0 {
		s.Tables = req.Tables
	}
	return s, true
}
