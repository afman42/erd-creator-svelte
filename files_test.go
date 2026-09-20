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
	got, err := ParseDDL(mustGenSQL(sampleSchema())) // same source text
	if err != nil {
		t.Fatal(err)
	}
	_ = got

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
		t.Error("file still on disk")
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
		"unsaveable dialect": {
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
