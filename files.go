// files.go — working-directory .sql store. The file IS the model: open parses
// server-side, save generates server-side. Client never writes raw SQL bytes.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
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
		// Rename/copy are POST operations addressed by virtual names that cannot
		// collide with real files (validName requires a .sql suffix).
		if name == "rename" || name == "copy" {
			if r.Method != http.MethodPost {
				http.Error(w, "POST only", http.StatusMethodNotAllowed)
				return
			}
			handleFileOp(w, r, dir, name == "copy")
			return
		}
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
			// Move to .trash rather than unlink: a deleted schema is the whole
			// model, and a mis-click or a racy overwrite currently destroys it
			// with no recourse. The rename is same-filesystem (the trash lives
			// inside the store), so it is atomic and cannot fail halfway. A
			// missing file stays a 404; everything else is a server fault.
			if err := trashFile(dir, full, name); err != nil {
				if os.IsNotExist(err) {
					http.Error(w, "file not found: "+name, http.StatusNotFound)
				} else {
					http.Error(w, err.Error(), http.StatusInternalServerError)
				}
				return
			}
			sweepTrash(dir)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// handleFileOp implements POST /api/files/rename and /api/files/copy with a
// {"from":"a.sql","to":"b.sql"} body. Rename moves the file (atomic
// same-filesystem rename, NOT a delete → no trash); copy duplicates it. Both
// refuse a missing source (404), an existing target (409), and any name that
// fails safeName — the same boundary every other store op uses.
func handleFileOp(w http.ResponseWriter, r *http.Request, dir string, copy bool) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(b, &req); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := safeName(req.From); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := safeName(req.To); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.From == req.To {
		http.Error(w, "from and to are the same file", http.StatusBadRequest)
		return
	}
	fromFull, err := storePath(dir, req.From)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(fromFull); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found: "+req.From, http.StatusNotFound)
		} else {
			log.Printf("stat %s: %v", fromFull, err)
			http.Error(w, "rename failed", http.StatusInternalServerError)
		}
		return
	}
	// Resolving the target refuses a symlink escaping the store either way
	// (existing link → isInsideStore fails; missing path → parent must be the
	// store root).
	toFull, err := storePath(dir, req.To)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := os.Lstat(toFull); err == nil {
		http.Error(w, "file already exists: "+req.To, http.StatusConflict)
		return
	}
	if copy {
		// Read the source and write the copy through the same atomic
		// temp+rename path saves use, so a planted symlink cannot redirect
		// the write (O_EXCL on a fresh random name).
		b, err := os.ReadFile(fromFull)
		if err != nil {
			log.Printf("copy read %s: %v", fromFull, err)
			http.Error(w, "copy failed", http.StatusInternalServerError)
			return
		}
		tmp, err := createTemp(dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if _, err := tmp.Write(b); err != nil {
			discardTemp(tmp)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := tmp.Close(); err != nil {
			removeTemp(tmp.Name())
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(tmp.Name(), toFull); err != nil {
			removeTemp(tmp.Name())
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		// os.Rename is atomic and same-filesystem by construction (both paths
		// are inside the store). Unlike DELETE this is a move, not a recycle:
		// the file keeps its name, so nothing lands in the trash.
		if err := os.Rename(fromFull, toFull); err != nil {
			log.Printf("rename %s → %s: %v", fromFull, toFull, err)
			http.Error(w, "rename failed", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
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

// openFile serves GET /api/files/:name: schema fields at the root (legacy
// clients read .tables directly), import warnings alongside when the fallback
// had to skip anything. The schema itself never carries the loss list, so a
// later save cannot persist warnings into the file.
func openFile(w http.ResponseWriter, full, name string) {
	b, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found: "+name, http.StatusNotFound)
		} else {
			log.Printf("open %s: %v", full, err)
			http.Error(w, "open failed", http.StatusInternalServerError)
		}
		return
	}
	// Strict first (own files: zero-loss path), then the best-effort import
	// fallback for foreign DDL. Either way the result is validated before it
	// reaches the browser.
	s, warnings, err := ParseImport(string(b))
	if err != nil {
		http.Error(w, "parse failed: "+err.Error(), http.StatusBadRequest)
		return
	}
	// Schema fields stay at the root (legacy clients read .tables directly);
	// warnings ride alongside, omitted when the strict path had nothing to say.
	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, struct {
		*Schema
		Warnings []string `json:"warnings,omitempty"`
	}{Schema: s, Warnings: warnings})
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
	r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad body: "+err.Error(), http.StatusBadRequest)
		return
	}
	// Same envelope decode as every POST endpoint: a full Schema JSON (what the
	// browser PUTs) or the wrapped {"schema":{...}} shape, with dialect and
	// sqliteTypes carried at the top level either way.
	s, err := decodeSchemaJSON(b)
	if err != nil {
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

// trashName is the prefix given to a recycled schema. The trash is a plain
// sibling directory, not a soft-delete flag: a schema the listing no longer
// shows must also not half-exist in the DB, so moved files leave the store
// entirely.
const trashDirName = ".trash"

// trashRetention is how long a deleted schema stays recyclable before
// sweepTrash removes it. Long enough to notice a mis-click, short enough that
// the trash cannot grow unbounded in a long-lived store.
const trashRetention = 7 * 24 * time.Hour

// trashPath resolves dir/.trash, creating it if absent, and refuses a trash
// that resolves outside the store — a symlink planted at .trash must not
// redirect a delete to an arbitrary directory, exactly as storePath refuses a
// symlinked file. The resolved real path is returned so callers act on the
// real directory, not the link.
func trashPath(dir string) (string, error) {
	root, err := resolveStoreRoot(dir)
	if err != nil {
		return "", err
	}
	td := filepath.Join(root, trashDirName)
	real, err := filepath.EvalSymlinks(td)
	if err != nil {
		// Doesn't exist yet: create it under the already-resolved root, so the
		// new directory cannot be a link.
		if err := os.MkdirAll(td, 0o755); err != nil {
			return "", fmt.Errorf("trash: %w", err)
		}
		return td, nil
	}
	if !isInsideStore(real, root) {
		return "", fmt.Errorf("trash %q escapes the store", trashDirName)
	}
	return real, nil
}

// trashFile moves a resolved store file into the trash. The destination keeps
// the original name so a recovery is a plain `mv`, and a collision with a
// previous recycle of the same name is disambiguated with a millisecond
// suffix rather than overwriting it.
func trashFile(dir, full, name string) error {
	td, err := trashPath(dir)
	if err != nil {
		return err
	}
	dst := filepath.Join(td, name)
	if _, err := os.Stat(dst); err == nil {
		dst = filepath.Join(td, fmt.Sprintf("%s.%d", name, time.Now().UnixMilli()))
	}
	if err := os.Rename(full, dst); err != nil {
		// Returned unwrapped: the caller classifies it (os.IsNotExist for a
		// missing source → 404). Wrapping in fmt.Errorf would hide the errno.
		return err
	}
	return nil
}

// sweepTrash removes trash entries older than trashRetention. Called after
// every delete: the common case is an empty or young trash, so this is a
// bounded directory listing, cheap enough to run per request. A failure is
// logged, not fatal — a stale trash costs disk, not correctness.
func sweepTrash(dir string) {
	td, err := trashPath(dir)
	if err != nil {
		// Path resolution failing (e.g. the store was removed) means there is
		// nothing to sweep; ignore it.
		log.Printf("sweep trash %s: %v", dir, err)
		return
	}
	entries, err := os.ReadDir(td)
	if err != nil {
		log.Printf("sweep trash %s: %v", td, err)
		return
	}
	cutoff := time.Now().Add(-trashRetention)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			log.Printf("sweep trash %s: %v", e.Name(), err)
			continue
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(td, e.Name())); err != nil {
				log.Printf("sweep trash %s: %v", e.Name(), err)
			}
		}
	}
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
