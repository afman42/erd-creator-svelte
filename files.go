// files.go — working-directory .sql store. The file IS the model: open parses
// server-side, save generates server-side. Client never writes raw SQL bytes.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var validName = regexp.MustCompile(`^[\w.-]{1,64}\.sql$`)

// safeName rejects anything that could escape the store dir.
func safeName(name string) error {
	if !validName.MatchString(name) || strings.Contains(name, "..") {
		return fmt.Errorf("invalid file name %q", name)
	}
	return nil
}

func handleFiles(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/api/files")
		if name == "" || name == "/" {
			if r.Method != http.MethodGet {
				http.Error(w, "GET only", http.StatusMethodNotAllowed)
				return
			}
			listFiles(w, dir)
			return
		}
		name = strings.TrimPrefix(name, "/")
		if err := safeName(name); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodGet:
			openFile(w, dir, name)
		case http.MethodPut:
			saveFile(w, dir, name, r)
		case http.MethodDelete:
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

func listFiles(w http.ResponseWriter, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	type fileInfo struct {
		Name  string `json:"name"`
		Mtime int64  `json:"mtime"`
	}
	out := []fileInfo{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		if safeName(e.Name()) != nil {
			continue // listed but unaddressable → hide
		}
		info, err := e.Info()
		m := int64(0)
		if err == nil {
			m = info.ModTime().Unix()
		}
		out = append(out, fileInfo{e.Name(), m})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func openFile(w http.ResponseWriter, dir, name string) {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		http.Error(w, "file not found: "+name, http.StatusNotFound)
		return
	}
	s, err := ParseDDL(string(b))
	if err != nil {
		http.Error(w, "parse failed: "+err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s)
}

func saveFile(w http.ResponseWriter, dir, name string, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var s Schema
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(s.Tables) == 0 {
		http.Error(w, "schema has no tables", http.StatusBadRequest)
		return
	}
	// Refuse to write a dialect we cannot read back: saving one would produce a
	// file that fails to reopen — silent data loss. Every dialect the UI offers
	// now has a parser, so this only fires on an unknown/unset dialect string.
	if !s.saveable() {
		http.Error(w, "dialect "+s.Dialect+" is export-only; cannot save", http.StatusBadRequest)
		return
	}
	tmp := filepath.Join(dir, "."+name+".tmp")
	if err := os.WriteFile(tmp, []byte(s.GenSQL()), 0o644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ensureDir creates the schema store; refuses to run without it.
func ensureDir(dir string) error {
	if dir == "" {
		return errors.New("empty -dir")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, 0o755)
}
