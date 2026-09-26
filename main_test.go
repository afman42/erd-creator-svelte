// main_test.go — the HTTP surface: route dispatch, body decoding, and the
// request-shape guards every JSON endpoint shares.
//
// These handlers were untested (0% coverage) because the e2e suite exercises
// them only through the happy path: a wrong status code on a rejected request,
// or a route that silently 404s, would not have been caught. The store CRUD
// tests in files_test.go cover the file paths; this file covers the request
// boundary in front of them.
package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecodeBody(t *testing.T) {
	t.Run("rejects non-POST", func(t *testing.T) {
		for _, method := range []string{"GET", "PUT", "DELETE", "PATCH"} {
			rec := httptest.NewRecorder()
			if _, ok := decodeBody(rec, httptest.NewRequest(method, "/x", nil)); ok {
				t.Errorf("%s accepted, want rejected", method)
			}
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s: code %d, want 405", method, rec.Code)
			}
		}
	})

	t.Run("accepts POST and returns the bytes", func(t *testing.T) {
		rec := httptest.NewRecorder()
		b, ok := decodeBody(rec, httptest.NewRequest("POST", "/x", strings.NewReader(`{"a":1}`)))
		if !ok {
			t.Fatalf("POST rejected: %s", rec.Body)
		}
		if string(b) != `{"a":1}` {
			t.Errorf("body = %q", b)
		}
	})

	t.Run("enforces the 1 MiB cap", func(t *testing.T) {
		// one byte over the limit must be refused rather than read into memory
		big := strings.NewReader(strings.Repeat("x", (1<<20)+1))
		rec := httptest.NewRecorder()
		if _, ok := decodeBody(rec, httptest.NewRequest("POST", "/x", big)); ok {
			t.Error("oversized body accepted")
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code %d, want 400", rec.Code)
		}
	})

	t.Run("accepts exactly the limit", func(t *testing.T) {
		at := strings.NewReader(strings.Repeat("x", 1<<20))
		rec := httptest.NewRecorder()
		if _, ok := decodeBody(rec, httptest.NewRequest("POST", "/x", at)); !ok {
			t.Errorf("body of exactly 1 MiB rejected: %s", rec.Body)
		}
	})
}

func TestDecodeSchema(t *testing.T) {
	t.Run("accepts both envelope shapes", func(t *testing.T) {
		for name, body := range map[string]string{
			"wrapped": `{"schema":{"tables":[{"id":"t1","name":"w","columns":[]}]}}`,
			"bare":    `{"tables":[{"id":"t1","name":"b","columns":[]}]}`,
		} {
			rec := httptest.NewRecorder()
			s, ok := decodeSchema(rec, httptest.NewRequest("POST", "/x", strings.NewReader(body)))
			if !ok {
				t.Errorf("%s: rejected: %s", name, rec.Body)
				continue
			}
			if len(s.Tables) != 1 {
				t.Errorf("%s: %d tables, want 1", name, len(s.Tables))
			}
		}
	})

	t.Run("rejects bad json with 400", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, ok := decodeSchema(rec, httptest.NewRequest("POST", "/x", strings.NewReader(`{oops`))); ok {
			t.Error("bad json accepted")
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code %d, want 400", rec.Code)
		}
	})

	t.Run("rejects non-POST before parsing", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, ok := decodeSchema(rec, httptest.NewRequest("GET", "/x", strings.NewReader(`{}`))); ok {
			t.Error("GET accepted")
		}
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("code %d, want 405", rec.Code)
		}
	})
}

func TestHandleSchemaAPI(t *testing.T) {
	body := `{"tables":[{"id":"t1","name":"users","columns":[{"name":"id","type":"INT","pk":true}]}]}`

	t.Run("lint returns JSON diagnostics", func(t *testing.T) {
		rec := do(t, http.HandlerFunc(handleSchemaAPI), "POST", "/api/lint", strings.NewReader(body))
		if rec.Code != 200 {
			t.Fatalf("code %d: %s", rec.Code, rec.Body)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "json") {
			t.Errorf("content-type %q, want json", ct)
		}
		// a clean schema must serialize as [] rather than null, so the client can
		// treat "no diagnostics" and "not an array" differently
		var got []string
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("not a JSON array: %v (%s)", err, rec.Body)
		}
		if got == nil {
			t.Error("lint returned null, want []")
		}
	})

	t.Run("inserts returns plain text", func(t *testing.T) {
		rec := do(t, http.HandlerFunc(handleSchemaAPI), "POST", "/api/inserts", strings.NewReader(body))
		if rec.Code != 200 {
			t.Fatalf("code %d: %s", rec.Code, rec.Body)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
			t.Errorf("content-type %q, want text/plain", ct)
		}
		if !strings.Contains(rec.Body.String(), "INSERT INTO") {
			t.Errorf("missing INSERT: %s", rec.Body)
		}
	})

	t.Run("unknown path is 404", func(t *testing.T) {
		rec := do(t, http.HandlerFunc(handleSchemaAPI), "POST", "/api/nope", strings.NewReader(body))
		if rec.Code != http.StatusNotFound {
			t.Errorf("code %d, want 404", rec.Code)
		}
	})

	t.Run("bad json is 400 and nothing is rendered", func(t *testing.T) {
		rec := do(t, http.HandlerFunc(handleSchemaAPI), "POST", "/api/lint", strings.NewReader(`{oops`))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code %d, want 400", rec.Code)
		}
		if strings.Contains(rec.Body.String(), "INSERT INTO") {
			t.Error("rendered output for a rejected body")
		}
	})
}

func TestHandleExport(t *testing.T) {
	post := func(body string) *httptest.ResponseRecorder {
		rec := do(t, http.HandlerFunc(handleExport), "POST", "/export", strings.NewReader(body))
		return rec
	}

	t.Run("returns DDL for each dialect", func(t *testing.T) {
		cases := map[string]string{
			"mysql":    "(MySQL)",
			"mariadb":  "(MariaDB)",
			"postgres": "(PostgreSQL)",
			"sqlite":   "(SQLite)",
		}
		for dialect, want := range cases {
			body := `{"dialect":"` + dialect + `","schema":{"tables":[{"id":"t1","name":"t","columns":[{"name":"id","type":"INT","pk":true}]}]}}`
			rec := post(body)
			if rec.Code != 200 {
				t.Errorf("%s: code %d: %s", dialect, rec.Code, rec.Body)
				continue
			}
			if !strings.Contains(rec.Body.String(), want) {
				t.Errorf("%s: missing %q:\n%s", dialect, want, rec.Body)
			}
			if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
				t.Errorf("%s: content-type %q, want text/plain", dialect, ct)
			}
		}
	})

	t.Run("honours the schema's sqlite types mode", func(t *testing.T) {
		// the handler must read the mode off the schema, or the panel, Copy SQL
		// and Export would disagree with what Save writes
		body := `{"dialect":"sqlite","schema":{"sqliteTypes":"portable","tables":[{"id":"t1","name":"t","columns":[{"name":"f","type":"BOOLEAN"}]}]}}`
		rec := post(body)
		if rec.Code != 200 {
			t.Fatalf("code %d: %s", rec.Code, rec.Body)
		}
		if !strings.Contains(rec.Body.String(), "`f` INTEGER") {
			t.Errorf("portable mode ignored:\n%s", rec.Body)
		}
	})

	t.Run("unknown dialect is 400", func(t *testing.T) {
		body := `{"dialect":"oracle","schema":{"tables":[{"id":"t1","name":"t","columns":[{"name":"id","type":"INT"}]}]}}`
		rec := post(body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code %d, want 400", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "oracle") {
			t.Errorf("error should name the dialect: %s", rec.Body)
		}
	})

	t.Run("empty schema is 400", func(t *testing.T) {
		rec := post(`{"dialect":"mysql","schema":{"tables":[]}}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code %d, want 400", rec.Code)
		}
	})

	t.Run("bad json is 400", func(t *testing.T) {
		if rec := post(`{oops`); rec.Code != http.StatusBadRequest {
			t.Errorf("code %d, want 400", rec.Code)
		}
	})

	t.Run("GET is 405", func(t *testing.T) {
		rec := do(t, http.HandlerFunc(handleExport), "GET", "/export", nil)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("code %d, want 405", rec.Code)
		}
	})
}

func TestEnsureDir(t *testing.T) {
	if err := ensureDir(""); err == nil {
		t.Error("empty dir accepted")
	}
	// nested path that does not exist yet must be created
	dir := filepath.Join(t.TempDir(), "a", "b", "c")
	if err := ensureDir(dir); err != nil {
		t.Fatalf("ensureDir: %v", err)
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		t.Errorf("dir not created: %v", err)
	}
	// idempotent: a second call must not fail
	if err := ensureDir(dir); err != nil {
		t.Errorf("second ensureDir: %v", err)
	}
}

// TestListenAddr: the address string handed to net.Listen. JoinHostPort is used
// rather than concatenation so an IPv6 literal is bracketed — "::1:8731" is
// ambiguous and net.Listen rejects it, while "[::1]:8731" works.
func TestListenAddr(t *testing.T) {
	cases := []struct {
		host string
		port int
		want string
	}{
		{"127.0.0.1", 8731, "127.0.0.1:8731"},
		{"0.0.0.0", 80, "0.0.0.0:80"},
		{"localhost", 3000, "localhost:3000"},
		// empty host binds every interface; the port alone is still addressable
		{"", 8731, ":8731"},
		// port 0 asks the OS for a free port
		{"127.0.0.1", 0, "127.0.0.1:0"},
		// IPv6 must be bracketed or the address is unparseable
		{"::1", 8731, "[::1]:8731"},
		{"fe80::1", 9000, "[fe80::1]:9000"},
		// boundary ports
		{"127.0.0.1", 1, "127.0.0.1:1"},
		{"127.0.0.1", 65535, "127.0.0.1:65535"},
	}
	for _, c := range cases {
		got, err := listenAddr(c.host, c.port)
		if err != nil {
			t.Errorf("listenAddr(%q, %d): %v", c.host, c.port, err)
			continue
		}
		if got != c.want {
			t.Errorf("listenAddr(%q, %d) = %q, want %q", c.host, c.port, got, c.want)
		}
		// the result must be something net can actually split, which is what
		// proves the IPv6 bracketing is right
		if _, _, err := net.SplitHostPort(got); err != nil {
			t.Errorf("listenAddr(%q, %d) = %q is not splittable: %v", c.host, c.port, got, err)
		}
	}

	// out-of-range ports are rejected rather than passed to net.Listen, which
	// would fail later with a less direct message
	for _, p := range []int{-1, -100, 65536, 100000} {
		if _, err := listenAddr("127.0.0.1", p); err == nil {
			t.Errorf("port %d accepted, want rejected", p)
		}
	}
}

// TestDisplayURL: the startup line. A wildcard bind is reachable but is not
// itself a URL, so it is labelled rather than printed as http://0.0.0.0:port —
// which looks clickable and is not.
func TestDisplayURL(t *testing.T) {
	cases := []struct {
		addr string
		want string
	}{
		{"127.0.0.1:8731", "http://127.0.0.1:8731"},
		{"192.168.1.5:8080", "http://192.168.1.5:8080"},
		// wildcards are labelled, not rendered as a bogus URL
		{"0.0.0.0:8731", "http://localhost:8731 (all interfaces)"},
		{"[::]:8731", "http://localhost:8731 (all interfaces)"},
		// a real IPv6 address stays bracketed in the URL
		{"[::1]:8731", "http://[::1]:8731"},
	}
	for _, c := range cases {
		ta, err := net.ResolveTCPAddr("tcp", c.addr)
		if err != nil {
			t.Fatalf("bad test address %q: %v", c.addr, err)
		}
		if got := displayURL(ta); got != c.want {
			t.Errorf("displayURL(%q) = %q, want %q", c.addr, got, c.want)
		}
	}
}
