// files_test.go — store safety, CRUD, and the error paths.
//
// The happy path is covered below; the error paths matter more, because they
// are what protects the store: a rejected traversal, an unwritable file, a
// corrupt .sql. Each must fail closed (4xx/5xx and nothing written) rather than
// half-succeed.
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func jsonBody(v any) *bytes.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

func TestSafeName(t *testing.T) {
	ok := []string{"a.sql", "my_schema-1.sql", "a.b.sql"}
	bad := []string{"", "..", "../x.sql", "a/../../b.sql", "x.txt", ".sql", strings.Repeat("a", 70) + ".sql", "a b.sql"}
	for _, n := range ok {
		if err := safeName(n); err != nil {
			t.Errorf("%q rejected: %v", n, err)
		}
	}
	for _, n := range bad {
		if err := safeName(n); err == nil {
			t.Errorf("%q accepted", n)
		}
	}
}

func TestFilesCRUD(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)

	// save
	s := sampleSchema()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/files/blog.sql", jsonBody(s))
	h.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}

	// list
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files", nil))
	if !strings.Contains(rec.Body.String(), "blog.sql") {
		t.Errorf("list missing file: %s", rec.Body)
	}

	// open round-trips schema
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/blog.sql", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"users"`) {
		t.Fatalf("read: %d %s", rec.Code, rec.Body)
	}

	// traversal rejected
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/..%2Fescape.sql", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("traversal: %d", rec.Code)
	}

	// delete
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/files/blog.sql", nil))
	if rec.Code != 204 {
		t.Errorf("delete: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(dir, "blog.sql")); err == nil {
		t.Error("file still in store after delete")
	}
	// recycled into .trash, not destroyed: the schema is the whole model, so a
	// delete must be reversible by hand (mv .trash/blog.sql ./) — the API only
	// stops addressing it
	trashF, err := os.Stat(filepath.Join(dir, trashDirName, "blog.sql"))
	if err != nil {
		t.Fatalf("file not in trash after delete: %v", err)
	}
	if trashF.ModTime().Unix() <= 0 {
		t.Error("trash entry has no mtime")
	}
	// gone from the listing: a deleted file must not still be offered
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files", nil))
	if strings.Contains(rec.Body.String(), "blog.sql") {
		t.Errorf("deleted file still listed: %s", rec.Body)
	}
}

// TestTrashSweep: the trash keeps recycled schemas for trashRetention, then
// sweepTrash removes them. A file inside the retention window survives; one
// past it is gone.
func TestTrashSweep(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	seed := func(name string) {
		s := sampleSchema()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/"+name, jsonBody(s)))
		if rec.Code != 204 {
			t.Fatalf("seed %s: %d", name, rec.Code)
		}
	}
	del := func(name string) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/files/"+name, nil))
		if rec.Code != 204 {
			t.Fatalf("delete %s: %d", name, rec.Code)
		}
	}
	// old.sql and new.sql both go to the trash
	seed("old.sql")
	seed("new.sql")
	del("old.sql")
	del("new.sql")
	// backdate old.sql's trash entry past the retention window
	back := time.Now().Add(-trashRetention - time.Hour)
	old := filepath.Join(dir, trashDirName, "old.sql")
	if err := os.Chtimes(old, back, back); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	// deleting a third file triggers the sweep; old.sql must be gone, new.sql kept
	seed("third.sql")
	del("third.sql")
	if _, err := os.Stat(old); err == nil {
		t.Error("expired trash entry not swept")
	}
	if _, err := os.Stat(filepath.Join(dir, trashDirName, "new.sql")); err != nil {
		t.Error("fresh trash entry swept prematurely")
	}
}

// TestTrashSymlinkEscapes: a .trash symlink planted outside the store must not
// redirect a delete. storePath already refuses a link at the FILE, but the
// trash dir itself is a new target: if .trash is a link to elsewhere, the
// rename would move the schema out of the store. trashPath resolves it and
// refuses.
func TestTrashSymlinkEscapes(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, trashDirName)); err != nil {
		t.Fatal(err)
	}
	h := handleFiles(dir)
	s := sampleSchema()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/x.sql", jsonBody(s)))
	if rec.Code != 204 {
		t.Fatalf("save: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/files/x.sql", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("delete with escaping trash: %d, want 500", rec.Code)
	}
	// the schema must not have moved into the planted trash
	if b, err := os.ReadFile(filepath.Join(outside, "x.sql")); err == nil {
		t.Errorf("file moved into escaping trash: %q", b)
	}
	// and the original must still be there — deletion failed, so no data lost
	if _, err := os.Stat(filepath.Join(dir, "x.sql")); err != nil {
		t.Error("original gone after refused delete")
	}
}

// TestTrashNameCollision: deleting a file whose name is already in the trash
// must not overwrite the earlier recycle — a mis-click recovery must be able
// to fetch EITHER copy by name.
func TestTrashNameCollision(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	put := func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/x.sql", jsonBody(sampleSchema())))
		if rec.Code != 204 {
			t.Fatalf("save: %d", rec.Code)
		}
	}
	del := func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/files/x.sql", nil))
		if rec.Code != 204 {
			t.Fatalf("delete: %d", rec.Code)
		}
	}
	put()
	del()
	put()
	del()
	entries, err := os.ReadDir(filepath.Join(dir, trashDirName))
	if err != nil {
		t.Fatal(err)
	}
	trashFiles := 0
	for _, e := range entries {
		if !e.IsDir() {
			trashFiles++
		}
	}
	if trashFiles != 2 {
		t.Errorf("trash has %d entries, want 2 (both recycles kept)", trashFiles)
	}
}

// TestFilesListFilters: the list must show only addressable .sql files, so a
// file the UI cannot open (or delete) is never offered.
func TestFilesListFilters(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	for _, name := range []string{"keep.sql", "notes.txt", "no-ext", "bad name.sql"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir.sql"), 0o755); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files", nil))
	var got []struct {
		Name  string `json:"name"`
		Mtime int64  `json:"mtime"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, rec.Body)
	}
	if len(got) != 1 || got[0].Name != "keep.sql" {
		t.Errorf("list = %+v, want just keep.sql", got)
	}
	// a directory named *.sql must not be listed (it is not openable)
	for _, f := range got {
		if f.Name == "subdir.sql" {
			t.Error("directory listed as a file")
		}
	}
}

// TestFilesListEmptyIsArray: an empty store must serialize as [] not null, so
// the client can iterate it without a guard.
func TestFilesListEmptyIsArray(t *testing.T) {
	h := handleFiles(t.TempDir())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files", nil))
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Errorf("empty list = %q, want []", got)
	}
}

// TestFilesListSorted: order must be stable so the dropdown does not reshuffle.
func TestFilesListSorted(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	for _, name := range []string{"c.sql", "a.sql", "b.sql"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files", nil))
	var got []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range got {
		names = append(names, f.Name)
	}
	if strings.Join(names, ",") != "a.sql,b.sql,c.sql" {
		t.Errorf("order = %v, want sorted", names)
	}
}

// TestSaveFileRejects covers every reason a save is refused. Each must leave the
// store untouched — a partial write is worse than a rejection.
func TestSaveFileRejects(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)

	cases := map[string]struct {
		method, path, body string
		wantCode           int
	}{
		"bad json": {
			"PUT", "/api/files/a.sql", `{oops`, http.StatusBadRequest,
		},
		"no tables": {
			"PUT", "/api/files/a.sql", `{"tables":[]}`, http.StatusBadRequest,
		},
		"unknown sqliteTypes normalizes": {
			"PUT", "/api/files/a.sql",
			`{"dialect":"sqlite","sqliteTypes":"bogus","tables":[{"id":"t1","name":"t","columns":[{"name":"id","type":"INT"}]}]}`,
			// an unrecognized sqliteTypes is normalized, not rejected; this one
			// must SAVE (proving the mode is not a validation surface)
			204,
		},
		"POST to a file path": {
			"POST", "/api/files/a.sql", `{"tables":[{"id":"t1","name":"t","columns":[{"name":"id","type":"INT"}]}]}`,
			http.StatusMethodNotAllowed,
		},
	}
	for name, tc := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
		if rec.Code != tc.wantCode {
			t.Errorf("%s: code %d, want %d (%s)", name, rec.Code, tc.wantCode, rec.Body)
		}
	}

	// the only successful case above must have written valid, reopenable DDL
	if _, err := os.Stat(filepath.Join(dir, "a.sql")); err != nil {
		t.Fatalf("expected a.sql to exist: %v", err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/a.sql", nil))
	if rec.Code != 200 {
		t.Errorf("saved file does not reopen: %d %s", rec.Code, rec.Body)
	}
}

// TestSaveFileNoTempLeftBehind: the write goes through a .tmp then a rename, so
// a failure must not leave the temp file for the list to trip over.
func TestSaveFileNoTempLeftBehind(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	s := sampleSchema()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/ok.sql", jsonBody(s)))
	if rec.Code != 204 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

// TestOpenFileErrors: a missing file is 404 and a corrupt one is 400 — not 500,
// because both are the caller's input, not a server fault.
func TestOpenFileErrors(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/gone.sql", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing file: %d, want 404", rec.Code)
	}

	// write DDL this tool did not emit: the parse boundary must reject it
	if err := os.WriteFile(filepath.Join(dir, "junk.sql"), []byte("NOT SQL AT ALL\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/junk.sql", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unparseable file: %d, want 400 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "parse failed") {
		t.Errorf("error should explain: %s", rec.Body)
	}
}

// TestDeleteFileErrors: deleting something that is not there is a 404, and the
// store must not be disturbed.
func TestDeleteFileErrors(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/files/gone.sql", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("code %d, want 404", rec.Code)
	}
}

// TestFilesRootMethod: the collection path is GET-only.
func TestFilesRootMethod(t *testing.T) {
	h := handleFiles(t.TempDir())
	for _, method := range []string{"PUT", "DELETE", "POST"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/api/files", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /api/files: %d, want 405", method, rec.Code)
		}
	}
	// and the trailing-slash form behaves the same way
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT /api/files/: %d, want 405", rec.Code)
	}
}

// TestFilesTraversal: every escaping form must be rejected at the router, so
// nothing outside the store dir is ever read, written or deleted.
func TestFilesTraversal(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	// a file outside the store that a successful traversal would expose
	outside := filepath.Join(filepath.Dir(dir), "secret.sql")
	if err := os.WriteFile(outside, []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Remove(outside); err != nil {
			t.Errorf("cleanup %s: %v", outside, err)
		}
	}()

	bad := []string{
		"/api/files/..%2Fsecret.sql",
		"/api/files/../secret.sql",
		"/api/files/a%2F..%2F..%2Fsecret.sql",
	}
	for _, p := range bad {
		for _, method := range []string{"GET", "DELETE"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(method, p, nil))
			if rec.Code == 200 || rec.Code == 204 {
				t.Errorf("%s %s: succeeded (%d), must be rejected", method, p, rec.Code)
			}
		}
	}
	// the outside file must still exist, untouched
	if b, err := os.ReadFile(outside); err != nil || string(b) != "SECRET" {
		t.Errorf("file outside the store was affected: %v %q", err, b)
	}
}

// TestSaveIsAtomic: a save replaces the file wholesale, so a failed save cannot
// truncate the previous contents.
func TestSaveIsAtomic(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/x.sql", jsonBody(sampleSchema())))
	if rec.Code != 204 {
		t.Fatalf("initial save: %d %s", rec.Code, rec.Body)
	}
	before, err := os.ReadFile(filepath.Join(dir, "x.sql"))
	if err != nil {
		t.Fatal(err)
	}

	// a rejected save (no tables) must leave the file exactly as it was
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/x.sql", strings.NewReader(`{"tables":[]}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected rejection, got %d", rec.Code)
	}
	after, err := os.ReadFile(filepath.Join(dir, "x.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("a rejected save modified the file")
	}
}

// TestSaveReopenEveryDialect: what the store writes must be what it can read,
// for every dialect the UI can select. This is the invariant the save guard
// exists to protect.
func TestSaveReopenEveryDialect(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	// every dialect the UI offers; each must round-trip through the store
	for _, dialect := range []string{DialectMysql, DialectMariaDB, DialectPostgres, DialectSqlite} {
		name := dialect + ".sql"
		body, _ := json.Marshal(&Schema{Dialect: dialect, Tables: []Table{
			{ID: "t1", Name: "t", Columns: []Col{
				{Name: "id", Type: "INT", Pk: true, Ai: true},
				{Name: "flag", Type: "BOOLEAN"},
			}},
		}})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/"+name, bytes.NewReader(body)))
		if rec.Code != 204 {
			t.Errorf("%s: save %d %s", dialect, rec.Code, rec.Body)
			continue
		}
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/"+name, nil))
		if rec.Code != 200 {
			t.Errorf("%s: reopen %d %s", dialect, rec.Code, rec.Body)
			continue
		}
		var got Schema
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Errorf("%s: %v", dialect, err)
			continue
		}
		// the dialect identity must survive, or a file silently changes grammar
		if normalizeDialect(got.Dialect) != dialect {
			t.Errorf("%s: reopened as %q", dialect, got.Dialect)
		}
	}
}

// ---- rename / copy (POST /api/files/rename|copy) ----

func TestFileRename(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/a.sql", jsonBody(sampleSchema())))
	if rec.Code != 204 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files/rename", jsonBody(map[string]string{"from": "a.sql", "to": "b.sql"})))
	if rec.Code != 204 {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "a.sql")); err == nil {
		t.Error("source still present after rename")
	}
	if _, err := os.Stat(filepath.Join(dir, "b.sql")); err != nil {
		t.Errorf("target missing after rename: %v", err)
	}
	// the schema survived the move byte-for-byte
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/b.sql", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"users"`) {
		t.Errorf("renamed file unreadable: %d %s", rec.Code, rec.Body)
	}
}

func TestFileRenameErrors(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/a.sql", jsonBody(sampleSchema())))
	if rec.Code != 204 {
		t.Fatalf("save: %d", rec.Code)
	}
	// a real second file, so the 409 case has an actual existing target
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/taken.sql", jsonBody(sampleSchema())))
	if rec.Code != 204 {
		t.Fatalf("save taken: %d", rec.Code)
	}
	cases := []struct {
		name string
		body map[string]string
		want int
	}{
		{"missing source 404s", map[string]string{"from": "nope.sql", "to": "b.sql"}, http.StatusNotFound},
		{"existing target 409s", map[string]string{"from": "a.sql", "to": "taken.sql"}, http.StatusConflict},
		{"same file 400s", map[string]string{"from": "a.sql", "to": "a.sql"}, http.StatusBadRequest},
		{"bad name 400s", map[string]string{"from": "a.sql", "to": "../x.sql"}, http.StatusBadRequest},
		{"bad name 400s (no ext)", map[string]string{"from": "a.sql", "to": "x.txt"}, http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files/rename", jsonBody(c.body)))
		if rec.Code != c.want {
			t.Errorf("%s: got %d want %d (%s)", c.name, rec.Code, c.want, rec.Body.String())
		}
	}
	// the virtual op paths accept POST only
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/rename", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET rename: %d", rec.Code)
	}
}

func TestFileCopy(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/a.sql", jsonBody(sampleSchema())))
	if rec.Code != 204 {
		t.Fatalf("save: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files/copy", jsonBody(map[string]string{"from": "a.sql", "to": "c.sql"})))
	if rec.Code != 204 {
		t.Fatalf("copy: %d %s", rec.Code, rec.Body.String())
	}
	// source AND target exist with identical bytes
	if _, err := os.Stat(filepath.Join(dir, "a.sql")); err != nil {
		t.Errorf("source missing after copy: %v", err)
	}
	a, _ := os.ReadFile(filepath.Join(dir, "a.sql"))
	c, _ := os.ReadFile(filepath.Join(dir, "c.sql"))
	if string(a) != string(c) {
		t.Error("copy bytes differ from source")
	}
	// copying onto an existing name is refused
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files/copy", jsonBody(map[string]string{"from": "a.sql", "to": "c.sql"})))
	if rec.Code != http.StatusConflict {
		t.Errorf("copy onto existing: %d", rec.Code)
	}
	// missing source 404s
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files/copy", jsonBody(map[string]string{"from": "gone.sql", "to": "d.sql"})))
	if rec.Code != http.StatusNotFound {
		t.Errorf("copy missing source: %d", rec.Code)
	}
}

// A symlink planted at the target must not redirect a rename/copy outside the
// store: storePath resolves the target and refuses an escaping link, exactly
// as it does for the read/write/delete paths.
func TestFileOpSymlinkTargetRefused(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/a.sql", jsonBody(sampleSchema())))
	if rec.Code != 204 {
		t.Fatalf("save: %d", rec.Code)
	}
	if err := os.Symlink("/etc", filepath.Join(dir, "link.sql")); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"rename", "copy"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files/"+op, jsonBody(map[string]string{"from": "a.sql", "to": "link.sql"})))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s to symlink: %d %s", op, rec.Code, rec.Body.String())
		}
	}
}
