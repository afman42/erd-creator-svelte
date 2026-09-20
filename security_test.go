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
	rec := httptest.NewRecorder()
	handleExport(rec, httptest.NewRequest("POST", "/export", strings.NewReader(body)))
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
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/evil.sql", strings.NewReader(body)))
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
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/files/link.sql", nil))
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
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/files/evil.sql", strings.NewReader(body)))
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
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))

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
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
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

	do := func(method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
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

	if rec := do("PUT", "/api/files/ok.sql", schema, jsonHdr); rec.Code != 204 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/api/files/ok.sql", "", nil); rec.Code != 200 {
		t.Errorf("reopen: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/api/files", "", nil); rec.Code != 200 {
		t.Errorf("list: %d", rec.Code)
	}
	exportBody := `{"dialect":"postgres","schema":` + schema + `}`
	if rec := do("POST", "/export", exportBody, jsonHdr); rec.Code != 200 {
		t.Errorf("export: %d %s", rec.Code, rec.Body)
	}
	lintBody := `{"tables":[{"id":"t1","name":"t","columns":[{"name":"a","type":"INT"}]}]}`
	if rec := do("POST", "/api/lint", lintBody, jsonHdr); rec.Code != 200 {
		t.Errorf("lint: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/inserts", lintBody, jsonHdr); rec.Code != 200 {
		t.Errorf("inserts: %d %s", rec.Code, rec.Body)
	}
	if rec := do("DELETE", "/api/files/ok.sql", "", nil); rec.Code != 204 {
		t.Errorf("delete: %d %s", rec.Code, rec.Body)
	}

	// every response carried the headers
	rec := do("GET", "/api/files", "", nil)
	var files []struct{ Name string }
	if err := json.Unmarshal(rec.Body.Bytes(), &files); err != nil {
		t.Errorf("list is not JSON: %v", err)
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Error("headers missing on the composed handler")
	}
}
