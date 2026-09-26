// helpers_test.go — test-only helpers shared by the suite. Anything here is
// compiled only into the test binary; a helper that panics (mustGenSQL) must
// never ship in erd-creator itself.
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// baseSchema is the common 2-table schema shared by the suite (canonical
// mysql shape). sampleSchema() wraps it; pg/mariadb tag a dialect onto it.
func baseSchema() *Schema {
	return &Schema{Tables: []Table{
		{ID: "t1", Name: "users", Columns: []Col{
			{Name: "id", Type: "INT", Pk: true, Nn: true, Ai: true, Comment: "pk"},
			{Name: "email", Type: "VARCHAR(190)", Nn: true, Ux: true},
			{Name: "status", Type: "ENUM('active','banned')"},
		}},
		{ID: "t2", Name: "posts", Columns: []Col{
			{Name: "id", Type: "BIGINT", Pk: true, Nn: true, Ai: true},
			{Name: "user_id", Type: "INT", Ref: &Ref{TableID: "t1", Action: "SET NULL"}},
			{Name: "tag", Type: "VARCHAR(40)", Ix: true},
		}},
	}}
}

// sqliteExtraSchema is baseSchema tagged as sqlite plus the columns SQLite
// renders specially: BOOLEAN and DATETIME (no native type), TIMESTAMP.
func sqliteExtraSchema() *Schema {
	s := baseSchema()
	s.Dialect = DialectSqlite
	s.Tables[0].Columns = append(s.Tables[0].Columns,
		Col{Name: "active", Type: "BOOLEAN"},
		Col{Name: "seen_at", Type: "DATETIME", Comment: "last login"},
		Col{Name: "stamp", Type: "TIMESTAMP"},
	)
	return s
}

// do issues one test HTTP request against h and returns the recorder.
func do(t *testing.T, h http.Handler, method, path string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, body))
	return rec
}

// mustGenSQL is GenSQL for callers holding an already-validated schema, where
// an error means a bug in the validator or an emitter rather than bad input.
// It panics rather than returning a partial string, because a truncated file is
// worse than a loud failure — but it is only used from tests and from paths
// that validated immediately before, never on unvalidated input.
func mustGenSQL(s *Schema) string {
	out, err := s.GenSQL()
	if err != nil {
		panic("validated schema failed to emit: " + err.Error())
	}
	return out
}
