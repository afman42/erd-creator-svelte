// helpers_test.go — test-only helpers shared by the suite. Anything here is
// compiled only into the test binary; a helper that panics (mustGenSQL) must
// never ship in erd-creator itself.
package main

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
