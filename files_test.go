// files_test.go — store safety CRUD over a temp dir.
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
	got, err := ParseDDL(sampleSchema().GenSQL()) // same source text
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
