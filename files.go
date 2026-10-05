// files.go — working-directory .sql store. The file IS the model: open parses
// server-side, save generates server-side. Client never writes raw SQL bytes.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// maxOpenFile caps a .sql file open/copy: the store holds small DDL texts, so
// a huge file is either corruption or abuse. Checked via stat before reading,
// refused with 413 rather than loaded into memory.
const maxOpenFile = 8 << 20 // 8 MiB

// statCapped stats full and reports whether it exceeds maxOpenFile. A stat
// error is returned for the caller to map (missing → 404, other → 500);
// oversize is a plain bool so every site answers 413 identically.
func statCapped(full string) (tooLarge bool, err error) {
	//nolint:gosec // full is storePath-resolved inside the store root, never raw user input
	fi, err := os.Stat(full)
	if err != nil {
		return false, err
	}
	return fi.Size() > maxOpenFile, nil
}

// handleStatErr maps statCapped's outcome onto the store's response idiom: a
// missing file is 404 ("file not found: <name>"), an oversize one is 413, and
// any other stat error is a logged server fault. op names both the user-facing
// message and the log detail ("rename" → "rename failed" / "rename stat
// failed"). Returns true when the response is written, so callers return
// straight after.
func handleStatErr(w http.ResponseWriter, full, name, op string, tooLarge bool, err error) bool {
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found: "+name, http.StatusNotFound)
		} else {
			internalFail(w, op+" failed", op+" stat failed", "path", full, "error", err)
		}
		return true
	}
	if tooLarge {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return true
	}
	return false
}

// handleOpenErr maps an open/rename/delete error onto the same idiom as
// handleStatErr: missing is 404, anything else a logged server fault.
func handleOpenErr(w http.ResponseWriter, full, name, op string, err error) bool {
	if err == nil {
		return false
	}
	if os.IsNotExist(err) {
		http.Error(w, "file not found: "+name, http.StatusNotFound)
	} else {
		internalFail(w, op+" failed", op+" failed", "path", full, "error", err)
	}
	return true
}

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
		return "", fmt.Errorf("cannot resolve %q: %w", name, perr)
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
			if err := trashFile(dir, full, name); handleOpenErr(w, full, name, "delete", err) {
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
	b, ok := decodeBody(w, r)
	if !ok {
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(b, &req); err != nil {
		failBadJSON(w, err)
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
	tooLarge, err := statCapped(fromFull)
	if handleStatErr(w, fromFull, req.From, "rename", tooLarge, err) {
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
	} else if !os.IsNotExist(err) {
		// Lstat failed for a reason other than absence (permissions, I/O):
		// fail closed rather than racing into a rename against an unknown
		// target state. os.Rename below still reports a concurrent create
		// as a plain error (last-writer-wins inside the store, no escape).
		internalFail(w, "rename failed", "rename target stat failed", "path", toFull, "error", err)
		return
	}
	if copy {
		copyFile(w, dir, fromFull, toFull)
		return
	}
	// os.Rename is atomic and same-filesystem by construction (both paths
	// are inside the store). Unlike DELETE this is a move, not a recycle:
	// the file keeps its name, so nothing lands in the trash.
	if err := os.Rename(fromFull, toFull); err != nil {
		internalFail(w, "rename failed", "rename failed", "from", fromFull, "to", toFull, "error", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// copyFile streams the source into the copy through the same atomic temp+rename
// path saves use, so a planted symlink cannot redirect the write (O_EXCL on a
// fresh random name). Size is stat-checked by the caller and re-capped here
// (LimitReader) so a concurrent grow cannot OOM the read.
func copyFile(w http.ResponseWriter, dir, fromFull, toFull string) {
	//nolint:gosec // fromFull is storePath-resolved inside the store root, never raw user input
	src, err := os.Open(fromFull)
	if err != nil {
		internalFail(w, "copy failed", "copy open failed", "path", fromFull, "error", err)
		return
	}
	defer func() {
		if err := src.Close(); err != nil {
			slog.Error("close failed", "path", fromFull, "error", err)
		}
	}()
	tmp, err := createTemp(dir)
	if err != nil {
		internalFail(w, "copy failed", "copy temp failed", "dir", dir, "error", err)
		return
	}
	if _, err := io.Copy(tmp, io.LimitReader(src, maxOpenFile+1)); err != nil {
		discardTemp(tmp)
		internalFail(w, "copy failed", "copy write failed", "path", tmp.Name(), "error", err)
		return
	}
	if err := tmp.Close(); err != nil {
		removeTemp(tmp.Name())
		internalFail(w, "copy failed", "copy close failed", "path", tmp.Name(), "error", err)
		return
	}
	if tooLarge, err := statCapped(tmp.Name()); err != nil || tooLarge {
		removeTemp(tmp.Name())
		if err != nil {
			slog.Error("copy stat failed", "path", tmp.Name(), "error", err)
		}
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := os.Rename(tmp.Name(), toFull); err != nil {
		removeTemp(tmp.Name())
		internalFail(w, "copy failed", "copy rename failed", "from", tmp.Name(), "to", toFull, "error", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// internalFail logs an internal filesystem error and replies with a generic
// 500, so paths and OS details never reach the client. msg is the user-safe
// client body ("open failed", "save failed", ...); logMsg is a stable
// low-cardinality template and args are structured slog attributes (paths,
// errors) so log aggregation groups by message, not by value.
// It generalizes the old copy-only copyFail to every store op.
func internalFail(w http.ResponseWriter, msg, logMsg string, args ...any) {
	slog.Error(logMsg, args...)
	http.Error(w, msg, http.StatusInternalServerError)
}

func listFiles(w http.ResponseWriter, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		internalFail(w, "list failed", "list failed", "dir", dir, "error", err)
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

func openReadResult(f *os.File, full string, w http.ResponseWriter) ([]byte, bool) {
	b, err := io.ReadAll(io.LimitReader(f, maxOpenFile+1))
	if err != nil {
		internalFail(w, "open failed", "open read failed", "path", full, "error", err)
		return nil, false
	}
	if len(b) > maxOpenFile {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return nil, false
	}
	return b, true
}

// openFile serves GET /api/files/:name: schema fields at the root (legacy
// clients read .tables directly), import warnings alongside when the fallback
// had to skip anything. The schema itself never carries the loss list, so a
// later save cannot persist warnings into the file.
func openFile(w http.ResponseWriter, full, name string) {
	// Stat first: the store holds small DDL texts, so an oversized file is
	// refused with 413 before it is read into memory.
	tooLarge, err := statCapped(full)
	if handleStatErr(w, full, name, "open", tooLarge, err) {
		return
	}
	//nolint:gosec // full is storePath-resolved inside the store root, never raw user input
	f, err := os.Open(full)
	if handleOpenErr(w, full, name, "open", err) {
		return
	}
	defer func() {
		if err := f.Close(); err != nil {
			slog.Error("close failed", "path", full, "error", err)
		}
	}()
	b, ok := openReadResult(f, full, w)
	if !ok {
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
	// PUT body: same 1 MiB cap as the POST endpoints, without their POST-only
	// guard (this handler is routed on PUT by handleFiles). readCappedBody is
	// the shared cap so the two cannot drift.
	b, ok := readCappedBody(w, r)
	if !ok {
		return
	}
	// Same envelope decode as every POST endpoint: a full Schema JSON (what the
	// browser PUTs) or the wrapped {"schema":{...}} shape, with dialect and
	// sqliteTypes carried at the top level either way.
	s, err := decodeSchemaJSON(b)
	if err != nil {
		failBadJSON(w, err)
		return
	}
	if len(s.Tables) == 0 {
		http.Error(w, "schema has no tables", http.StatusBadRequest)
		return
	}
	// Reject an unknown dialect label before it is stored: normalizeDialect
	// would otherwise silently treat it as mysql while the UI shows the
	// unknown name. Empty (unset) is accepted as mysql.
	if err := validateDialectForSave(s.Dialect); err != nil {
		failValidation(w, err)
		return
	}
	// The saved file is DDL this program will later parse back, so refuse to
	// write anything that cannot be represented safely. Validating here means a
	// malicious value never reaches disk in the first place.
	if err := s.Validate(); err != nil {
		failValidation(w, err)
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
		failValidation(w, err)
		return
	}
	tmp, err := createTemp(dir)
	if err != nil {
		internalFail(w, "save failed", "save temp failed", "dir", dir, "error", err)
		return
	}
	if _, err := tmp.WriteString(ddl); err != nil {
		discardTemp(tmp)
		internalFail(w, "save failed", "save write failed", "path", tmp.Name(), "error", err)
		return
	}
	if err := tmp.Close(); err != nil {
		removeTemp(tmp.Name())
		internalFail(w, "save failed", "save close failed", "path", tmp.Name(), "error", err)
		return
	}
	//nolint:gosec // full is storePath-resolved inside the store root, never raw user input
	if err := os.Rename(tmp.Name(), full); err != nil {
		removeTemp(tmp.Name())
		internalFail(w, "save failed", "save rename failed", "from", tmp.Name(), "to", full, "error", err)
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
		slog.Error("temp remove failed", "path", name, "error", err)
	}
}

// discardTemp closes then deletes a temp file whose write failed. Both steps are
// best-effort for the same reason as removeTemp; the close is attempted because
// a file still open when the handler returns leaks a descriptor.
func discardTemp(f *os.File) {
	if err := f.Close(); err != nil {
		slog.Error("temp close failed", "path", f.Name(), "error", err)
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
//
// The create path is race-aware: MkdirAll is attempted only after EvalSymlinks
// fails (absent), and the result is re-resolved rather than trusting the
// unresolved join — a link planted between the check and the mkdir cannot
// redirect the returned path outside the store.
func trashPath(dir string) (string, error) {
	root, err := resolveStoreRoot(dir)
	if err != nil {
		return "", err
	}
	td := filepath.Join(root, trashDirName)
	real, err := filepath.EvalSymlinks(td)
	if err != nil {
		// Doesn't exist yet: create it under the already-resolved root, so the
		// new directory cannot be a link — then re-resolve to confirm what was
		// actually created (a concurrently planted link fails closed here).
		//nolint:gosec // td joins the resolved store root; MkdirAll under it cannot escape
		if err := os.MkdirAll(td, 0o755); err != nil {
			return "", fmt.Errorf("trash: %w", err)
		}
		real, err = filepath.EvalSymlinks(td)
		if err != nil {
			return "", fmt.Errorf("trash: %w", err)
		}
	}
	if !isInsideStore(real, root) {
		return "", fmt.Errorf("trash %q escapes the store", trashDirName)
	}
	return real, nil
}

// trashFile moves a resolved store file into the trash. The destination keeps
// the original name so a recovery is a plain `mv`. On collision the recycle
// claims a crypto-rand suffixed path with O_EXCL (up to 100 attempts) instead
// of the old UnixMilli suffix: millisecond names collided under fast deletes
// and were guessable, so a pre-planted .trash/<name>.<millis> could eat the
// recycled file or block the recycle. O_EXCL fails on an existing path
// (including a dangling symlink), and the claim is removed on any failure
// below so it cannot accumulate.

// trashSuffix appends a crypto-rand suffix to a trash file name, so a
// colliding recycle retries with an unpredictable fresh name.
func trashSuffix(name string) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return name + "." + hex.EncodeToString(suffix[:]), nil
}

// trashAttempts drives the collision-retry protocol both recycle paths share:
// try up to 100 fresh suffixed names, handing each to claim. claim reports
// whether it took the name (done=true — the recycle is settled) and any
// error; a nil error with done=false means the name collided, try the next.
// The O_EXCL/EEXIST mechanism belongs to the caller; the attempt count and
// the collision error belong here, so the two loops cannot drift.
func trashAttempts(name, td string, claim func(dst string) (done bool, err error)) error {
	for i := 0; i < 100; i++ {
		suffixed, err := trashSuffix(name)
		if err != nil {
			return err
		}
		done, err := claim(filepath.Join(td, suffixed))
		if err != nil {
			return err
		}
		if done {
			return nil
		}
	}
	return fmt.Errorf("trash collision for %q", name)
}

// touchTrash stamps a recycled file with the delete time. os.Link preserves
// the source mtime, so without this an 8-day-old file recycled today would
// look 8 days old to sweepTrash and be removed immediately, defeating the
// 7-day retention. Best-effort: a failed stamp only shortens retention for
// that entry, it never blocks the recycle.
func touchTrash(dst string) {
	now := time.Now()
	if err := os.Chtimes(dst, now, now); err != nil {
		slog.Error("trash touch failed", "path", dst, "error", err)
	}
}

func trashFile(dir, full, name string) error {
	td, err := trashPath(dir)
	if err != nil {
		return err
	}
	// os.Link is atomic and fails with EEXIST when the target exists (unlike
	// Rename, which silently replaces it): no stat-then-rename TOCTOU where a
	// link planted between the check and the rename eats the recycled file.
	if err := os.Link(full, filepath.Join(td, name)); err == nil {
		touchTrash(filepath.Join(td, name))
		//nolint:gosec // full is storePath-resolved; td is trashPath-resolved inside the store
		return os.Remove(full)
	} else if !os.IsExist(err) {
		// Cross-device/permission failures fall through to the plain-rename
		// path, which handles them; err stays unwrapped so the caller can
		// classify with os.IsNotExist.
		return plainRenameFallback(full, name, td)
	}
	return trashAttempts(name, td, func(dst string) (bool, error) {
		if err := os.Link(full, dst); err != nil {
			if os.IsExist(err) {
				return false, nil // collision: next suffix
			}
			// Cross-device/permission failures fall through to the plain-rename
			// path (same as the unsuffixed attempt above).
			return false, plainRenameFallback(full, name, td)
		}
		touchTrash(dst)
		//nolint:gosec // full is storePath-resolved; dst is trashPath-resolved inside the store
		return true, os.Remove(full)
	})
}

// plainRenameFallback handles filesystems where os.Link cannot work
// (cross-device, permissions): plain Rename onto the free name. Kept on the
// link-failure path only, so the common case stays TOCTOU-free.
func plainRenameFallback(full, name, td string) error {
	//nolint:gosec // full is storePath-resolved; td is trashPath-resolved inside the store
	if err := os.Rename(full, filepath.Join(td, name)); err == nil {
		touchTrash(filepath.Join(td, name))
		return nil
	} else if !os.IsExist(err) {
		return err
	}
	return renameWithSuffix(full, name, td)
}

func renameWithSuffix(full, name, td string) error {
	return trashAttempts(name, td, func(dst string) (bool, error) {
		//nolint:gosec // dst is trashPath-resolved with a crypto-rand suffix, O_EXCL-claimed
		claim, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if os.IsExist(err) {
				return false, nil // collision: next suffix
			}
			return false, err
		}
		if err := claim.Close(); err != nil {
			_ = os.Remove(dst) //nolint:gosec // dst is the O_EXCL-claimed trash path above
			return false, err
		}
		//nolint:gosec // full is storePath-resolved; dst is the O_EXCL-claimed trash path
		if err := os.Rename(full, dst); err != nil {
			_ = os.Remove(dst) //nolint:gosec // dst is the just-claimed trash path above
			if os.IsNotExist(err) {
				return false, err
			}
			return false, nil // claim was lost (raced a sweep): next suffix
		}
		touchTrash(dst)
		return true, nil
	})
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
		slog.Debug("trash sweep skipped", "dir", dir, "error", err)
		return
	}
	entries, err := os.ReadDir(td)
	if err != nil {
		slog.Error("trash sweep failed", "path", td, "error", err)
		return
	}
	cutoff := time.Now().Add(-trashRetention)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			slog.Error("trash sweep failed", "name", e.Name(), "error", err)
			continue
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(td, e.Name())); err != nil {
				slog.Error("trash sweep failed", "name", e.Name(), "error", err)
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
		return fmt.Errorf("store dir: %w", err)
	}
	//nolint:gosec // abs is the operator-supplied -dir flag; the store must be creatable
	return os.MkdirAll(abs, 0o755)
}
