package main

import (
	"os/exec"
	"strings"
	"testing"
)

// TestSqliteEmitsExecutableDDL executes the emitted SQLite DDL with the real
// sqlite3 CLI, proving the grammar produces statements a SQLite actually
// accepts — backticks, ENUM as TEXT + CHECK, the INTEGER PRIMARY KEY rowid
// alias, DEFAULT expressions, FKs, and CREATE INDEX. Regex round-trips only
// prove the parser agrees with the emitter; this proves a real engine agrees
// with both. Skipped when sqlite3 is not on PATH (CI installs it).
func TestSqliteEmitsExecutableDDL(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 CLI not installed")
	}
	// Both type-rendering modes must execute: native keeps BOOLEAN/DATETIME
	// names verbatim, portable rewrites them to INTEGER/TEXT.
	for _, mode := range []string{SqliteTypesNative, SqliteTypesPortable} {
		s := defaultsSample()
		s.Dialect = DialectSqlite
		s.SqliteTypes = mode
		sql, err := s.GenSQL()
		if err != nil {
			t.Fatalf("mode %s: GenSQL: %v", mode, err)
		}
		runSqlite(t, mode, sql)
	}
	// The FK/index/ENUM shapes from the export fixture must execute too.
	runSqlite(t, "export fixture", func() string {
		s := &Schema{Dialect: DialectSqlite, Tables: sample()}
		sql, err := s.GenSQL()
		if err != nil {
			t.Fatalf("export fixture: GenSQL: %v", err)
		}
		return sql
	}())
}

// runSqlite pipes the DDL (plus a query that forces the schema to be read)
// into sqlite3 :memory: and fails unless the engine accepts every statement
// and reports the expected table count.
func runSqlite(t *testing.T, label, ddl string) {
	t.Helper()
	probe := ddl + "\nSELECT count(*) FROM sqlite_master WHERE type='table';\n"
	cmd := exec.Command("sqlite3", ":memory:")
	cmd.Stdin = strings.NewReader(probe)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s: sqlite3 rejected the emitted DDL: %v\n%s", label, err, out)
	}
	got := strings.TrimSpace(string(out))
	// defaultsSample -> users + logs; sample() -> users + posts
	if !strings.Contains(got, "2") {
		t.Errorf("%s: expected 2 tables to be created, sqlite3 reported %q", label, got)
	}
}
