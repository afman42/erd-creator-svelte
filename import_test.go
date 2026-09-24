// import_test.go — best-effort import: foreign DDL opens, losses are reported.
package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const dumpMysql = `-- MySQL dump
SET FOREIGN_KEY_CHECKS=0;
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE COMMENT 'login',
  status ENUM('active','banned') DEFAULT 'active'
) ENGINE=InnoDB;
CREATE TABLE posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_posts_user ON posts (user_id);
`

const dumpPg = `SET statement_timeout = 0;
CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  email character varying(190) NOT NULL UNIQUE
);
CREATE TABLE public.posts (
  id integer NOT NULL,
  user_id integer,
  CONSTRAINT posts_user_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE SET NULL
);
ALTER TABLE ONLY public.posts ADD CONSTRAINT posts_user_fkey2 FOREIGN KEY (id) REFERENCES users (id);
COMMENT ON COLUMN public.users.email IS 'login';
CREATE UNIQUE INDEX users_email ON public.users (email);
`

const dumpLite = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flag BOOLEAN NOT NULL DEFAULT 0,
  bio TEXT COLLATE NOCASE
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  CHECK (id > 0)
);
`

func mustImport(t *testing.T, sql string) (*Schema, []string) {
	t.Helper()
	s, warnings, err := ParseImport(sql)
	if err != nil {
		t.Fatalf("ParseImport: %v", err)
	}
	return s, warnings
}

func TestParseImportMysqlDump(t *testing.T) {
	s, _ := mustImport(t, dumpMysql)
	if len(s.Tables) != 2 || s.Tables[0].Name != "users" {
		t.Fatalf("tables: %+v", s.Tables)
	}
	id := s.Tables[0].Columns[0]
	if !id.Pk || !id.Ai {
		t.Errorf("inline PK+AI lost: %+v", id)
	}
	if got := s.Tables[1].Columns[1].Ref; got == nil {
		t.Error("FK lost")
	}
	if !s.Tables[1].Columns[1].Ix || len(s.Tables[1].Indexes) != 0 {
		t.Error("single-col CREATE INDEX should route to Col.Ix")
	}
}

func TestParseImportPgDump(t *testing.T) {
	s, warnings := mustImport(t, dumpPg)
	if s.Dialect != DialectPostgres {
		t.Errorf("dialect %q, want postgres", s.Dialect)
	}
	if got := s.Tables[0].Columns[0].Type; got != "SMALLINT" {
		t.Errorf("SERIAL mapped to %q, want SMALLINT", got)
	}
	if !s.Tables[0].Columns[0].Ai {
		t.Error("SERIAL should imply AI")
	}
	if got := s.Tables[0].Columns[1].Type; got != "VARCHAR(190)" {
		t.Errorf("character varying mapped to %q", got)
	}
	if n := len(s.Tables[1].Columns[1].Ref.TableID); n == 0 {
		t.Error("schema-prefixed FK lost")
	}
	if len(warnings) != 0 {
		t.Errorf("unexpected losses: %v", warnings)
	}
}

func TestParseImportSqlite(t *testing.T) {
	s, warnings := mustImport(t, dumpLite)
	if got := s.Tables[0].Columns[1].Type; got != "BOOLEAN" {
		t.Errorf("type %q, want BOOLEAN", got)
	}
	if got := s.Tables[1].Columns[1].Ref; got == nil || got.Action != "CASCADE" {
		t.Errorf("inline REFERENCES lost: %+v", got)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "CHECK") {
			found = true
		}
	}
	if !found {
		t.Errorf("CHECK should be reported, got %v", warnings)
	}
}

func TestParseImportStillRejects(t *testing.T) {
	for name, sql := range map[string]string{
		"garbage":  "NOT SQL AT ALL\n",
		"no table": "-- nothing\nSELECT 1;\n",
	} {
		if _, _, err := ParseImport(sql); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestParseImportLossCap(t *testing.T) {
	var b strings.Builder
	b.WriteString("CREATE TABLE a (\n  id INT\n);\n")
	for i := range 60 {
		b.WriteString(strings.Repeat("x", i) + " ???\n")
	}
	_, warnings, err := ParseImport(b.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != maxImportWarnings+1 {
		t.Fatalf("warnings %d, want %d+cap note", len(warnings), maxImportWarnings)
	}
	if !strings.HasPrefix(warnings[len(warnings)-1], "+") {
		t.Errorf("last warning should be the overflow count: %q", warnings[len(warnings)-1])
	}
	for _, w := range warnings {
		if strings.ContainsAny(w, "\x00\x01\x07\n") {
			t.Errorf("warning carries control chars: %q", w)
		}
	}
}

func TestOpenForeignFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "dump.sql"), []byte(dumpMysql), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h := handleFiles(dir)
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/dump.sql", nil))
	if rec.Code != 200 {
		t.Fatalf("open: %d %s", rec.Code, rec.Body)
	}
	var got struct {
		Tables   []Table  `json:"tables"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Tables) != 2 {
		t.Errorf("tables %d, want 2", len(got.Tables))
	}
}

func TestOpenOwnFileHasNoWarnings(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	body, _ := json.Marshal(sampleSchema())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/files/blog.sql", strings.NewReader(string(body)))
	h.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/blog.sql", nil))
	if strings.Contains(rec.Body.String(), `"warnings"`) {
		t.Errorf("strict path must omit warnings: %s", rec.Body)
	}
}
