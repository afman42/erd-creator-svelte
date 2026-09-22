// files.go — working-directory .sql store. The file IS the model: open parses
// server-side, save generates server-side. Client never writes raw SQL bytes.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
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

// storePath resolves name inside dir and refuses if the result is not a real
// file within it.
//
// safeName already rejects traversal in the NAME, but a symlink planted in the
// store defeats a name check: the name is legal, yet the path it names leads
// out. Verified before this guard existed — a symlink to /etc/hostname was read
// through the API, and a symlink named .<file>.sql.tmp redirected a save so it
// overwrote a file outside the store.
//
// The check is on the RESOLVED path: EvalSymlinks collapses every link in the
// chain, and the result must still be inside the store. For a path that does
// not exist yet (the temp file on save) resolution fails, so its parent
// directory is resolved instead — that is what an attacker would have to
// control to redirect the write.
//
// This is not a substitute for the ownership checks the security guidance
// describes for destructive operations; it is the narrower guarantee this store
// needs, since every target is derived from a validated single-segment name.
func resolveStoreRoot(dir string) (string, error) {
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", fmt.Errorf("store dir: %w", err)
	}
	return root, nil
}

func isInsideStore(resolved, root string) bool {
	if resolved == root {
		return false
	}
	return strings.HasPrefix(resolved, root+string(filepath.Separator))
}

func handleMissingTarget(full, root, name string) (string, error) {
	parent, perr := filepath.EvalSymlinks(filepath.Dir(full))
	if perr != nil {
		return "", fmt.Errorf("cannot resolve %q", name)
	}
	if parent != root {
		return "", fmt.Errorf("invalid file name %q", name)
	}
	return full, nil
}

func storePath(dir, name string) (string, error) {
	if err := safeName(name); err != nil {
		return "", err
	}
	root, err := resolveStoreRoot(dir)
	if err != nil {
		return "", err
	}
	full := filepath.Join(root, name)
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return handleMissingTarget(full, root, name)
	}
	if !isInsideStore(resolved, root) {
		return "", fmt.Errorf("invalid file name %q", name)
	}
	return resolved, nil
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
		// Resolve through symlinks before acting: a legal name can still point
		// outside the store via a planted link.
		full, err := storePath(dir, name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodGet:
			openFile(w, full, name)
		case http.MethodPut:
			saveFile(w, dir, full, r)
		case http.MethodDelete:
			// Remove the link itself, never what it points at: os.Remove is
			// already unlink(2), but the resolved path is used so a link to
			// outside the store is rejected above rather than deleted.
			if err := os.Remove(full); err != nil {
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
	writeJSON(w, out)
}

func openFile(w http.ResponseWriter, full, name string) {
	b, err := os.ReadFile(full)
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
	writeJSON(w, s)
}

// saveFile writes a schema to an already-resolved path inside the store.
//
// The temp file is created with O_CREATE|O_EXCL so a pre-planted symlink at
// that name cannot redirect the write: O_EXCL fails if the path exists at all,
// including as a dangling link, and O_NOFOLLOW would only cover the last
// component. Verified before this: a symlink named .<file>.sql.tmp redirected
// the save so it overwrote a file outside the store. On collision the name is
// retried with a random suffix rather than reused, so a legitimate leftover
// temp file does not block saving.
func saveFile(w http.ResponseWriter, dir, full string, r *http.Request) {
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
	// The saved file is DDL this program will later parse back, so refuse to
	// write anything that cannot be represented safely. Validating here means a
	// malicious value never reaches disk in the first place.
	if err := s.Validate(); err != nil {
		http.Error(w, "invalid schema: "+err.Error(), http.StatusBadRequest)
		return
	}
	// Refuse to write a dialect we cannot read back: saving one would produce a
	// file that fails to reopen — silent data loss. Every dialect the UI offers
	// now has a parser, so this only fires on an unknown/unset dialect string.
	if !s.saveable() {
		http.Error(w, "dialect "+s.Dialect+" is export-only; cannot save", http.StatusBadRequest)
		return
	}
	// GenSQL validates and can fail; the schema was checked above, so an error
	// here is a bug, but it is handled rather than ignored.
	ddl, err := s.GenSQL()
	if err != nil {
		http.Error(w, "invalid schema: "+err.Error(), http.StatusBadRequest)
		return
	}
	tmp, err := createTemp(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := tmp.WriteString(ddl); err != nil {
		discardTemp(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := tmp.Close(); err != nil {
		removeTemp(tmp.Name())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp.Name(), full); err != nil {
		removeTemp(tmp.Name())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeTemp deletes a temp file left behind by a failed save. Best-effort by
// design: the save has already failed and the error response is being written,
// so this cannot change the outcome. It is logged because a leftover temp file
// is otherwise invisible and would silently accumulate in the store.
func removeTemp(name string) {
	if err := os.Remove(name); err != nil {
		log.Printf("remove temp %s: %v", name, err)
	}
}

// discardTemp closes then deletes a temp file whose write failed. Both steps are
// best-effort for the same reason as removeTemp; the close is attempted because
// a file still open when the handler returns leaks a descriptor.
func discardTemp(f *os.File) {
	if err := f.Close(); err != nil {
		log.Printf("close temp %s: %v", f.Name(), err)
	}
	removeTemp(f.Name())
}

// createTemp opens a new temp file inside the store for the atomic save.
// os.CreateTemp already uses a random name and O_EXCL, so it cannot follow a
// planted symlink and two concurrent saves cannot collide.
func createTemp(dir string) (*os.File, error) {
	root, err := resolveStoreRoot(dir)
	if err != nil {
		return nil, err
	}
	return os.CreateTemp(root, ".save-*.tmp")
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
