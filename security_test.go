// security_test.go — regression tests for the hardening layer.
//
// Every test here corresponds to an attack that was demonstrated to work
// against this server before the fix. They are written as abuse cases: the
// assertion is that the attack FAILS, and each names what the exploit was.
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---- SQL injection via the type field ----

// TestRejectsTypeInjection: a column type is emitted as raw text, because the
// type grammar is open-ended (DECIMAL(10,2), ENUM('a','b'), …). Before
// validation, this exact payload was emitted verbatim:
//
//	CREATE TABLE `t` (
//	  `a` VARCHAR(1;DROP TABLE users;--)
//	) ENGINE=InnoDB;
//
// which is a statement that drops a table when pasted into a database.
//
// The assertion is on the emitted TEXT, not only on the validator: what matters
// is that the payload never reaches a database, whether the caller remembered
// to call Validate or not.
func TestRejectsTypeInjection(t *testing.T) {
	payloads := []string{
		"VARCHAR(1;DROP TABLE users;--)",
		"INT); DROP TABLE users; --",
		"INT; DROP TABLE users",
		"INT -- comment",
		"INT/*x*/",
		"INT'",
		`INT"`,
		"VARCHAR(1) DROP",
		"ENUM('a'); DROP TABLE x; --')",
	}
	for _, p := range payloads {
		s := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: "a", Type: p},
		}}}}
		if err := s.Validate(); err == nil {
			t.Errorf("type %q accepted — it would be emitted as raw SQL", p)
		}
		// An unvalidated schema must not be emittable either. GenSQL is the
		// save path, so this is the last gate before a file is written — and it
		// returns an error rather than a partial string.
		if sql, err := s.GenSQL(); err == nil {
			t.Errorf("GenSQL emitted an unvalidated schema (type %q):\n%s", p, sql)
		}
	}
}

// TestAcceptsRealTypes: the validator must not reject the types the UI offers,
// including the awkward ones (parameterised, enum with spaces and quotes).
func TestAcceptsRealTypes(t *testing.T) {
	ok := []string{
		"INT", "BIGINT", "SMALLINT", "TINYINT", "TEXT", "BOOLEAN",
		"DATE", "DATETIME", "TIMESTAMP", "JSON",
		"DECIMAL(10,2)", "VARCHAR(255)", "VARCHAR(190)",
		"ENUM('active','banned')", "ENUM('a','b')",
		"ENUM('a b','c')", // space inside a value
		"ENUM('it''s')",   // escaped quote
		"CHAR(1)", "NUMERIC(8, 2)",
	}
	for _, ty := range ok {
		s := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: "a", Type: ty},
		}}}}
		if err := s.Validate(); err != nil {
			t.Errorf("legitimate type %q rejected: %v", ty, err)
		}
	}
}

// ---- array types (PostgreSQL-only) ----

// TestAcceptsArrayTypes: the array suffix is a PostgreSQL type modifier, so it
// is accepted for a postgres schema — including the parameterised and JSON
// forms, where the suffix has to survive the dialect's own type mapping.
func TestAcceptsArrayTypes(t *testing.T) {
	ok := []string{
		"INT[]", "BIGINT[]", "TEXT[]", "VARCHAR(255)[]", "DECIMAL(10,2)[]",
		"JSON[]", "BOOLEAN[]", "TIMESTAMP[]", "NUMERIC(8, 2)[]",
	}
	for _, ty := range ok {
		s := &Schema{Dialect: DialectPostgres, Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: "a", Type: ty},
		}}}}
		if err := s.Validate(); err != nil {
			t.Errorf("legitimate postgres array type %q rejected: %v", ty, err)
		}
	}
}

// TestArrayDialectEnforcement is the point of the array feature being
// dialect-aware: `INT[]` is PostgreSQL syntax, and emitting it into MySQL or
// SQLite produces DDL the database rejects. Refusing it is better than
// accepting the type and emitting invalid SQL, because the failure would
// otherwise surface only when the user pastes the output into a database.
//
// It also pins the check to the *target* dialect, since /export takes the
// dialect as a separate field: a postgres schema exported as mysql must be
// refused for mysql, not allowed because the schema itself is postgres.
func TestArrayDialectEnforcement(t *testing.T) {
	mk := func(dialect string) *Schema {
		return &Schema{Dialect: dialect, Tables: []Table{
			{ID: "t1", Name: "p", Columns: []Col{{Name: "id", Type: "INT", Pk: true}}},
			{ID: "t2", Name: "c", Columns: []Col{
				{Name: "id", Type: "INT", Pk: true},
				{Name: "tags", Type: "TEXT[]"},
			}},
		}}
	}

	// postgres is the one dialect that accepts it
	s := mk(DialectPostgres)
	if err := s.Validate(); err != nil {
		t.Fatalf("postgres rejected an array type: %v", err)
	}
	sql, err := s.GenSQL()
	if err != nil {
		t.Fatalf("postgres failed to emit an array type: %v", err)
	}
	if !strings.Contains(sql, `"tags" TEXT[]`) {
		t.Errorf("array type not emitted:\n%s", sql)
	}

	// every other dialect refuses it, naming the target
	for _, d := range []string{DialectMysql, DialectMariaDB, DialectSqlite} {
		s := mk(d)
		err := s.Validate()
		if err == nil {
			t.Errorf("%s accepted an array type", d)
			continue
		}
		if !strings.Contains(err.Error(), "PostgreSQL-only") {
			t.Errorf("%s: error does not say why: %v", d, err)
		}
		if !strings.Contains(err.Error(), d) {
			t.Errorf("%s: error does not name the target dialect: %v", d, err)
		}
		if sql, err := s.GenSQL(); err == nil {
			t.Errorf("%s emitted an array type anyway:\n%s", d, sql)
		}
	}

	// the export path validates against the REQUESTED dialect, not the stored
	// one: a postgres schema exported as mysql must fail
	pg := mk(DialectPostgres)
	if err := pg.ValidateFor(DialectMysql); err == nil {
		t.Error("a postgres schema with arrays was allowed to export as mysql")
	}
	if err := pg.ValidateFor(DialectPostgres); err != nil {
		t.Errorf("postgres array rejected when targeting postgres: %v", err)
	}
	// and a schema without arrays is unaffected by the dialect switch
	plain := &Schema{Dialect: DialectPostgres, Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
		{Name: "a", Type: "INT"},
	}}}}
	if err := plain.ValidateFor(DialectMysql); err != nil {
		t.Errorf("a scalar schema was refused for mysql: %v", err)
	}
}

// TestRejectsInvalidArrayForms: combinations that are invalid in PostgreSQL
// too, so they are refused regardless of dialect rather than emitted as DDL the
// database would reject.
func TestRejectsInvalidArrayForms(t *testing.T) {
	cases := map[string]string{
		// multi-dimension: no emitter here renders it, so accepting it would
		// emit something that does not mean what the model says
		"multi-dimension": "INT[][]",
		"triple brackets": "INT[][][]",
		// the ENUM rendering is TEXT + CHECK (col IN (...)), which describes one
		// value; there is no correct CHECK for an array of them
		"enum array":        "ENUM('a','b')[]",
		"empty brackets":    "[]",
		"brackets in front": "[]INT",
	}
	for name, ty := range cases {
		s := &Schema{Dialect: DialectPostgres, Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: "a", Type: ty},
		}}}}
		if err := s.Validate(); err == nil {
			t.Errorf("%s: %q accepted", name, ty)
		}
		if sql, err := s.GenSQL(); err == nil {
			t.Errorf("%s: %q emitted:\n%s", name, ty, sql)
		}
	}
}

// TestRejectsArrayAsKeyOrIdentity: an array column cannot be a primary key or
// an identity column in PostgreSQL, so those combinations are refused rather
// than emitted.
func TestRejectsArrayAsKeyOrIdentity(t *testing.T) {
	cases := map[string]Col{
		"primary key": {Name: "a", Type: "INT[]", Pk: true},
		"identity":    {Name: "a", Type: "INT[]", Ai: true},
	}
	for name, col := range cases {
		s := &Schema{Dialect: DialectPostgres, Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{col}}}}
		if err := s.Validate(); err == nil {
			t.Errorf("array column accepted as %s", name)
		}
	}
}

// ---- control characters in identifiers ----

// TestRejectsControlChars: the emitters produce one statement per line and the
// parsers read line by line, so a newline inside a name splits a statement and
// the file no longer describes the model. Before this, a table name containing
// "\n) ENGINE=InnoDB;\nCREATE TABLE evil (" was emitted as two statements.
func TestRejectsControlChars(t *testing.T) {
	bad := map[string]string{
		"newline":      "a\nb",
		"carriage":     "a\rb",
		"tab":          "a\tb",
		"nul":          "a\x00b",
		"escape":       "a\x1bb",
		"del":          "a\x7fb",
		"form feed":    "a\x0cb",
		"vertical tab": "a\x0bb",
	}
	for what, name := range bad {
		s := &Schema{Tables: []Table{{ID: "t1", Name: name, Columns: []Col{
			{Name: "c", Type: "INT"},
		}}}}
		if err := s.Validate(); err == nil {
			t.Errorf("%s in a table name accepted", what)
		}
		// same for a column name and a comment
		s2 := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: name, Type: "INT"},
		}}}}
		if err := s2.Validate(); err == nil {
			t.Errorf("%s in a column name accepted", what)
		}
		s3 := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: "c", Type: "INT", Comment: name},
		}}}}
		if err := s3.Validate(); err == nil {
			t.Errorf("%s in a comment accepted", what)
		}
	}
}

// TestStructuralIdentifierRejected: a newline in a table name is rejected.
//
// The quoting is actually sound here — verified against sqlite3, which created
// exactly ONE table from `CREATE TABLE `a\n) …` (`x` INT)`, because a newline
// inside backticks stays inside the identifier. So this was never injection.
// It is rejected because the emitters produce one statement per line and the
// parsers read line by line, so the FILE no longer round-trips: the name would
// come back truncated at the newline. A value that cannot survive the format is
// refused rather than silently mangled.
func TestStructuralIdentifierRejected(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1",
		Name:    "a\n) ENGINE=InnoDB;\nCREATE TABLE evil (\n  `id` INT",
		Columns: []Col{{Name: "x", Type: "INT"}},
	}}}
	if err := s.Validate(); err == nil {
		t.Error("statement-splitting table name accepted")
	}
	// and the emitter refuses, so the file is never written
	if sql, err := s.GenSQL(); err == nil {
		t.Errorf("GenSQL emitted an unsafe name:\n%s", sql)
	}
}

// ---- size and count bounds ----

func TestRejectsOversizedInput(t *testing.T) {
	long := strings.Repeat("a", maxNameLen+1)
	s := &Schema{Tables: []Table{{ID: "t1", Name: long, Columns: []Col{{Name: "c", Type: "INT"}}}}}
	if err := s.Validate(); err == nil {
		t.Error("over-long table name accepted")
	}

	s2 := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
		{Name: "c", Type: strings.Repeat("V", maxTypeLen+1)},
	}}}}
	if err := s2.Validate(); err == nil {
		t.Error("over-long type accepted")
	}

	// too many tables
	var tables []Table
	for i := 0; i <= maxTables; i++ {
		tables = append(tables, Table{ID: "t", Name: "t", Columns: []Col{{Name: "c", Type: "INT"}}})
	}
	if err := (&Schema{Tables: tables}).Validate(); err == nil {
		t.Error("table-count bound not enforced")
	}

	// too many columns in one table
	var cols []Col
	for i := 0; i <= maxColumns; i++ {
		cols = append(cols, Col{Name: "c", Type: "INT"})
	}
	if err := (&Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: cols}}}).Validate(); err == nil {
		t.Error("column-count bound not enforced")
	}
}

// ---- the validation is wired into every boundary ----

// TestExportRejectsInjection: the HTTP path, not just the validator.
//
// The error must not echo the payload back. It is served as text/plain so it
// cannot execute, but reflecting attacker-controlled text into a response is
// how a payload ends up in a log, a bug report, or a UI that renders it — and
// the caller already knows what they sent.
func TestExportRejectsInjection(t *testing.T) {
	body := `{"dialect":"mysql","schema":{"tables":[{"id":"t1","name":"t","columns":[{"name":"a","type":"VARCHAR(1;DROP TABLE users;--)"}]}]}}`
	rec := do(t, http.HandlerFunc(handleExport), "POST", "/export", strings.NewReader(body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("code %d, want 400", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "DROP TABLE") {
		t.Errorf("injected SQL echoed in the error: %s", rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
		t.Errorf("error content-type %q, want text/plain so it cannot be rendered as HTML", ct)
	}
}

// TestSaveRejectsInjection: a malicious value must never reach disk.
func TestSaveRejectsInjection(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	body := `{"dialect":"mysql","tables":[{"id":"t1","name":"t","columns":[{"name":"a","type":"INT);DROP TABLE x;--"}]}]}`
	rec := do(t, h, "PUT", "/api/files/evil.sql", strings.NewReader(body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("code %d, want 400", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(dir, "evil.sql")); err == nil {
		t.Error("rejected schema was written to disk anyway")
	}
}

// TestParseRejectsInjection: a .sql file is untrusted input too. The parser
// captures a type verbatim from the file, so without this check, planting one
// file is a PERSISTENT injection: it re-emits on every save and export.
func TestParseRejectsInjection(t *testing.T) {
	files := map[string]string{
		"paren capture": "-- Generated by erd-creator\nCREATE TABLE `t` (\n  `a` VARCHAR(1;DROP TABLE users;--)\n) ENGINE=InnoDB;\n",
		"postgres":      "-- Generated by erd-creator (PostgreSQL)\nCREATE TABLE \"t\" (\n  \"a\" VARCHAR(1;DROP TABLE users;--)\n);\n",
		"sqlite":        "-- Generated by erd-creator (SQLite)\nCREATE TABLE `t` (\n  `a` VARCHAR(1;DROP TABLE users;--)\n);\n",
	}
	for name, sql := range files {
		s, err := ParseDDL(sql)
		if err == nil {
			t.Errorf("%s: injection survived the parser (schema: %+v)", name, s)
		}
	}
}

// ---- symlink containment ----

// TestSymlinkReadBlocked: a legal name pointing outside the store via a symlink
// was read through the API before this guard.
func TestSymlinkReadBlocked(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.sql")
	content := "-- Generated by erd-creator\nCREATE TABLE `secret` (\n  `id` INT\n) ENGINE=InnoDB;\n"
	if err := os.WriteFile(outside, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.sql")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	h := handleFiles(dir)
	rec := do(t, h, "GET", "/api/files/link.sql", nil)
	if rec.Code == http.StatusOK {
		t.Errorf("read through a symlink outside the store succeeded: %s", rec.Body)
	}
}

// TestSymlinkWriteBlocked: a planted temp-file symlink redirected the save so
// it overwrote a file outside the store. os.CreateTemp uses a random name and
// O_EXCL, so it cannot follow a link and cannot be predicted.
func TestSymlinkWriteBlocked(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "protected.txt")
	if err := os.WriteFile(target, []byte("PROTECTED"), 0o644); err != nil {
		t.Fatal(err)
	}
	// the old predictable name, plus a guess at the new prefix
	for _, n := range []string{".evil.sql.tmp", ".save-evil.sql.tmp"} {
		if err := os.Symlink(target, filepath.Join(dir, n)); err != nil {
			t.Fatal(err)
		}
	}

	h := handleFiles(dir)
	body := `{"dialect":"mysql","tables":[{"id":"t1","name":"x","columns":[{"name":"a","type":"INT"}]}]}`
	rec := do(t, h, "PUT", "/api/files/evil.sql", strings.NewReader(body))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("save failed: %d %s", rec.Code, rec.Body)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "PROTECTED" {
		t.Errorf("write escaped the store: target now %q", got)
	}
	// and the real file must exist inside the store
	if _, err := os.Stat(filepath.Join(dir, "evil.sql")); err != nil {
		t.Errorf("save did not write the file: %v", err)
	}
}

// TestSymlinkDirEscapeBlocked: the store directory itself is resolved, so a
// symlinked store still contains its own files rather than the link's target.
func TestSymlinkDirEscapeBlocked(t *testing.T) {
	real := t.TempDir()
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "store")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// a symlinked store dir is fine — it resolves to itself
	if _, err := storePath(link, "a.sql"); err != nil {
		t.Errorf("symlinked store dir rejected: %v", err)
	}
	// but a link INSIDE it that points out is still refused
	outside := filepath.Join(t.TempDir(), "x.sql")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(real, "escape.sql")); err != nil {
		t.Fatal(err)
	}
	if _, err := storePath(link, "escape.sql"); err == nil {
		t.Error("link escaping the store accepted")
	}
}

// ---- Host allowlist (DNS rebinding) ----

// TestHostGuard: a page on evil.example that rebinds to 127.0.0.1 sends
// Host: evil.example. Before this check every such request returned 200, so the
// victim's browser treated the attacker's origin as same-origin and could read
// and write the store with no CORS in the way.
//
// DNS NAMES are what get blocked, because rebinding works by name resolution.
// An IP literal is allowed on purpose: the browser dialled that address, so the
// only page that can exist at that origin is one this server served itself —
// there is no name to rebind. Encoded forms (2130706433, 0x7f000001) are not
// valid IP literals, so they fall through to the name check and are refused.
func TestHostGuard(t *testing.T) {
	guard := hostGuard()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })

	// names an attacker controls — the rebinding vector
	blocked := []string{
		"evil.example", "attacker.com", "evil.example:8731",
		"", "sub.evil.example",
		"2130706433", "0x7f000001", "017700000001", // encoded loopback, not IP literals
		"localhost.evil.example",
	}
	for _, h := range blocked {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/files", nil)
		req.Host = h
		guard(next).ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("Host %q allowed (%d) — DNS rebinding would succeed", h, rec.Code)
		}
	}

	// names and addresses this server is legitimately reached by
	allowed := []string{
		"127.0.0.1", "127.0.0.1:8731", "localhost", "localhost:8731",
		"[::1]:8731", "192.168.1.5:8731", "0.0.0.0:8731",
	}
	for _, h := range allowed {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/files", nil)
		req.Host = h
		guard(next).ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Errorf("Host %q rejected (%d)", h, rec.Code)
		}
	}
}

// TestHostGuardAllowsConfiguredHost: -host example.local must be reachable by
// that name, or the flag is unusable.
func TestHostGuardAllowsConfiguredHost(t *testing.T) {
	guard := hostGuard("example.local")
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "example.local:8731"
	guard(next).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("configured -host rejected: %d", rec.Code)
	}
	// but not some other name
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/", nil)
	req.Host = "other.local"
	guard(next).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("unrelated Host allowed: %d", rec.Code)
	}
}

// ---- Origin guard (cross-site writes) ----

// TestSameOriginGuard: a cross-origin PUT was accepted before this check, so
// any page the user visited could overwrite their schemas.
func TestSameOriginGuard(t *testing.T) {
	guard := sameOriginGuard
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })

	mutating := []string{"PUT", "POST", "DELETE", "PATCH"}
	for _, m := range mutating {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(m, "/api/files/a.sql", nil)
		req.Host = "127.0.0.1:8731"
		req.Header.Set("Origin", "https://evil.example")
		guard(next).ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s with a foreign Origin allowed (%d)", m, rec.Code)
		}
	}

	// same-origin mutations pass
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/files/a.sql", nil)
	req.Host = "127.0.0.1:8731"
	req.Header.Set("Origin", "http://127.0.0.1:8731")
	guard(next).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("same-origin PUT rejected: %d", rec.Code)
	}

	// no Origin (curl, tests, same-origin navigations) passes
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("PUT", "/api/files/a.sql", nil)
	req.Host = "127.0.0.1:8731"
	guard(next).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("Origin-less PUT rejected: %d", rec.Code)
	}

	// safe methods are never blocked, even cross-origin
	for _, m := range []string{"GET", "HEAD", "OPTIONS"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(m, "/api/files", nil)
		req.Host = "127.0.0.1:8731"
		req.Header.Set("Origin", "https://evil.example")
		guard(next).ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Errorf("%s blocked (%d) — safe methods must pass", m, rec.Code)
		}
	}
}

// TestOriginPortMustMatch: a page on another localhost port is a different
// origin and must not be able to drive this one.
func TestOriginPortMustMatch(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/files/a.sql", nil)
	req.Host = "127.0.0.1:8731"
	req.Header.Set("Origin", "http://127.0.0.1:9999")
	sameOriginGuard(next).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("cross-port Origin allowed: %d", rec.Code)
	}
}

// ---- security headers ----

// TestSecurityHeaders: set on every response, including refusals, so a browser
// never renders a reply without them.
func TestSecurityHeaders(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	rec := do(t, h, "GET", "/", nil)

	want := map[string]string{
		"Content-Security-Policy": "default-src 'self'",
		"X-Frame-Options":         "DENY",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
	}
	for k, v := range want {
		got := rec.Header().Get(k)
		if !strings.Contains(got, v) {
			t.Errorf("%s = %q, want it to contain %q", k, got, v)
		}
	}
	// the CSP must forbid inline script, or it is not doing much
	csp := rec.Header().Get("Content-Security-Policy")
	for _, directive := range []string{"script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, directive) {
			t.Errorf("CSP missing %q: %s", directive, csp)
		}
	}
	if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Errorf("CSP contains an unsafe allowance: %s", csp)
	}
}

// TestSecurityHeadersOnError: a refused request must carry them too.
func TestSecurityHeadersOnError(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	rec := do(t, h, "GET", "/", nil)
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("error response missing security headers")
	}
}

// ---- timeouts ----

// TestServerTimeouts: a bare listener has no read deadline, so a client can
// hold a connection open indefinitely with a partial request (Slowloris).
func TestServerTimeouts(t *testing.T) {
	s := newServer(http.NewServeMux())
	if s.ReadHeaderTimeout <= 0 {
		t.Error("ReadHeaderTimeout unset — Slowloris is possible")
	}
	if s.ReadTimeout <= 0 || s.WriteTimeout <= 0 || s.IdleTimeout <= 0 {
		t.Error("timeouts unset")
	}
	if s.MaxHeaderBytes <= 0 {
		t.Error("MaxHeaderBytes unset — unbounded header memory")
	}
}

// ---- the output check ----

// TestValidateOutput catches a statement separator that is not at a line end,
// which is the signature of a value escaping its position.
func TestValidateOutput(t *testing.T) {
	ok := []string{
		"-- Generated by erd-creator\nCREATE TABLE `t` (\n  `a` INT\n) ENGINE=InnoDB;\n",
		"-- header\nCREATE TABLE `t` (\n  `a` ENUM('x;y')\n) ENGINE=InnoDB;\n", // ; inside a literal
		"CREATE INDEX IF NOT EXISTS `i` ON `t` (`c`);\n",
		// regression: the '' escape skip used `for j := range trimmed`, whose
		// inner j++ is discarded at the next iteration — the second quote of
		// the pair wrongly closed the string, so a ";" after an escaped quote
		// ('it''s; mine') was flagged as an embedded separator and legitimate
		// output was rejected.
		"CREATE TABLE `t` (\n  `a` VARCHAR(20) COMMENT 'it''s; mine'\n);\n",
		"CREATE TABLE `t` (\n  `a` ENUM('a;b', 'c''d;e')\n) ENGINE=InnoDB;\n",
	}
	for _, sql := range ok {
		if err := validateOutput(sql); err != nil {
			t.Errorf("legitimate output rejected: %v\n%s", err, sql)
		}
	}
	bad := []string{
		"CREATE TABLE `t` (\n  `a` INT); DROP TABLE x; --\n) ENGINE=InnoDB;\n",
		"CREATE TABLE `t` (\n  `a` INT\x00\n) ENGINE=InnoDB;\n",
	}
	for _, sql := range bad {
		if err := validateOutput(sql); err == nil {
			t.Errorf("unsafe output accepted:\n%s", sql)
		}
	}
}

// ---- end-to-end: the app must still work ----

// TestHardenedServerStillServes: the hardening must not break normal use. A
// schema that is entirely legitimate goes through every endpoint.
func TestHardenedServerStillServes(t *testing.T) {
	dir := t.TempDir()
	mux := http.NewServeMux()
	mux.HandleFunc("/export", handleExport)
	mux.HandleFunc("/api/lint", handleSchemaAPI)
	mux.HandleFunc("/api/inserts", handleSchemaAPI)
	fileAPI := handleFiles(dir)
	mux.Handle("/api/files", fileAPI)
	mux.Handle("/api/files/", fileAPI)
	var h http.Handler = mux
	h = securityHeaders(h)
	h = sameOriginGuard(h)
	h = hostGuard()(h)

	doReq := func(method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Host = "127.0.0.1:8731"
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		h.ServeHTTP(rec, req)
		return rec
	}

	schema := `{"dialect":"mysql","tables":[{"id":"t1","name":"users","columns":[{"name":"id","type":"INT","pk":true,"ai":true},{"name":"status","type":"ENUM('active','banned')"}]}]}`
	jsonHdr := map[string]string{"Content-Type": "application/json"}

	if rec := doReq("PUT", "/api/files/ok.sql", schema, jsonHdr); rec.Code != 204 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq("GET", "/api/files/ok.sql", "", nil); rec.Code != 200 {
		t.Errorf("reopen: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq("GET", "/api/files", "", nil); rec.Code != 200 {
		t.Errorf("list: %d", rec.Code)
	}
	exportBody := `{"dialect":"postgres","schema":` + schema + `}`
	if rec := doReq("POST", "/export", exportBody, jsonHdr); rec.Code != 200 {
		t.Errorf("export: %d %s", rec.Code, rec.Body)
	}
	lintBody := `{"tables":[{"id":"t1","name":"t","columns":[{"name":"a","type":"INT"}]}]}`
	if rec := doReq("POST", "/api/lint", lintBody, jsonHdr); rec.Code != 200 {
		t.Errorf("lint: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq("POST", "/api/inserts", lintBody, jsonHdr); rec.Code != 200 {
		t.Errorf("inserts: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq("DELETE", "/api/files/ok.sql", "", nil); rec.Code != 204 {
		t.Errorf("delete: %d %s", rec.Code, rec.Body)
	}

	// every response carried the headers
	rec := doReq("GET", "/api/files", "", nil)
	var files []struct{ Name string }
	if err := json.Unmarshal(rec.Body.Bytes(), &files); err != nil {
		t.Errorf("list is not JSON: %v", err)
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Error("headers missing on the composed handler")
	}
}

func TestValidateOutputRejectsCommentMarkers(t *testing.T) {
	ok := []string{
		"-- Generated by erd-creator (SQLite)\nCREATE TABLE `t` (\n  `a` INT\n);\n",
		"-- name: the users table\n",
		"  `a` VARCHAR(20) COMMENT 'a--b'\n",    // marker inside literal is fine
		"  `a` VARCHAR(20) COMMENT 'a/*b*/c'\n", // dito
	}
	for _, sql := range ok {
		if err := validateOutput(sql); err != nil {
			t.Errorf("legitimate output rejected: %v\n%s", err, sql)
		}
	}
	bad := []string{
		"CREATE TABLE `t` (\n  `a` INT -- sneaky\n) ENGINE=InnoDB;\n",
		"CREATE TABLE `t` (\n  `a` INT /* x */\n) ENGINE=InnoDB;\n",
		"CREATE TABLE `t` (\n  `a` INT, FOREIGN KEY (`a`) REFERENCES `u` (`id`) ON DELETE CASCADE -- x\n);\n",
	}
	for _, sql := range bad {
		if err := validateOutput(sql); err == nil {
			t.Errorf("comment-marker output accepted:\n%s", sql)
		}
	}
}

func TestDefaultErrorSkipsRawValue(t *testing.T) {
	for _, v := range []string{"0)); DROP TABLE users; --", "a; DROP", "x''; DROP"} {
		err := validateDefault(v)
		if err == nil {
			t.Fatalf("%q: expected error", v)
		}
		if strings.Contains(err.Error(), v) {
			t.Errorf("%q: error echoes raw value: %v", v, err)
		}
	}
}

func TestParseErrorSkipsRawLine(t *testing.T) {
	sql := "CREATE TABLE `a` (\n  `id` INT\x00EVIL-DATA-EXFIL\n) ENGINE=InnoDB;\n"
	_, err := ParseDDL(sql)
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "EVIL-DATA-EXFIL") {
		t.Errorf("parse error echoes raw line: %v", err)
	}
}

func TestSaveRejectsUnknownDialect(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := do(t, h, "PUT", "/api/files/x.sql", jsonBody(baseSchema()))
	_ = rec
	s := baseSchema()
	s.Dialect = "oracle"
	rec = do(t, h, "PUT", "/api/files/x.sql", jsonBody(s))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "unknown dialect") {
		t.Errorf("unknown dialect accepted: %d %s", rec.Code, rec.Body.String())
	}
	// empty (unset) still saves as mysql
	s.Dialect = ""
	rec = do(t, h, "PUT", "/api/files/x.sql", jsonBody(s))
	if rec.Code != http.StatusNoContent {
		t.Errorf("empty dialect rejected: %d %s", rec.Code, rec.Body.String())
	}
}

func TestTrashCollisionRetries(t *testing.T) {
	dir := t.TempDir()
	h := handleFiles(dir)
	rec := do(t, h, "PUT", "/api/files/v.sql", jsonBody(baseSchema()))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	// pre-plant a colliding recycle with the current millisecond name
	td, err := trashPath(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(td, "v.sql"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = do(t, h, "DELETE", "/api/files/v.sql", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	// original recycle intact, deleted file landed on a suffixed name
	entries, _ := os.ReadDir(td)
	if len(entries) < 2 {
		t.Errorf("expected 2 trash entries, got %d", len(entries))
	}
}
