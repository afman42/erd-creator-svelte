// spec.go — the single capability model for column types and referential actions.
//
// Validate, the emitters, the parsers, and the import path all query this
// file. Nothing here validates a whole schema (that is validate.go) or emits
// DDL (that is export.go): it answers small questions — "what is this type's
// base?", "is this action allowed?", "what is the ON DELETE default?" — so
// the four callers cannot drift apart.
//
// A new attribute (a type shape, an action, a mapping) lands here once, and
// every caller inherits it. The func names and signatures are unchanged from
// where they lived before, so existing tests keep calling the same API.
package main

import (
	"fmt"
	"strings"
)

// ---- type model ----

// splitType splits "VARCHAR(190)" into ("VARCHAR", "190"). The base is
// uppercased; args are preserved verbatim (ENUM values are case-sensitive).
func splitType(ty string) (string, string) {
	if i := strings.Index(ty, "("); i >= 0 && strings.HasSuffix(ty, ")") {
		return strings.ToUpper(ty[:i]), ty[i+1 : len(ty)-1]
	}
	return strings.ToUpper(ty), ""
}

// baseOf returns the uppercased base of a type expression ("INT" for
// "INT(11)" and "INT[]" — the array suffix is NOT stripped; callers that
// compare across the array boundary strip "[]" themselves).
func baseOf(ty string) string {
	base, _ := splitType(ty)
	return base
}

// isInt reports whether base is an integer family base. Takes the base (see
// baseOf), not the full expression.
func isInt(base string) bool {
	switch base {
	case "INT", "BIGINT", "SMALLINT", "TINYINT":
		return true
	}
	return false
}

// isArrayType reports whether a model type carries a Postgres array suffix.
// The suffix is the only structural difference between `INT` and `INT[]`, so
// every dialect decision keys off it rather than parsing the type again.
func isArrayType(ty string) bool {
	return strings.HasSuffix(strings.TrimSpace(ty), "[]")
}

// arrayBase strips one "[]" suffix and returns the base of what remains
// ("INT" for "INT[]"). Used by validateArrayRules.
func arrayBase(ty string) string {
	return baseOf(strings.TrimSuffix(strings.TrimSpace(ty), "[]"))
}

// ---- referential-action policy ----

// fkActions is the set of referential actions this tool emits and accepts.
//
// This is an allowlist rather than a free-text field for the same reason the
// type field is pattern-matched (validate.go): the action is emitted as raw
// SQL text inside a constraint clause, so "SET NULL; DROP TABLE users;--" would
// be injection if it were copied through. Validating it here means the value
// that reaches the emitter is one of five known-good tokens.
//
// The file parser applies the same check, so a hand-written .sql cannot persist
// an action that re-emits on every save — the same reasoning as the type check.
var fkActions = map[string]bool{
	"CASCADE":     true,
	"RESTRICT":    true,
	"SET NULL":    true,
	"SET DEFAULT": true,
	"NO ACTION":   true,
}

// isFKAction reports whether v is a known referential action. Empty is NOT
// allowed here — validateFKAction handles the ON UPDATE empty-means-omit rule.
func isFKAction(v string) bool {
	return fkActions[v]
}

// validateFKAction checks one referential action. Empty is allowed for ON
// UPDATE (it means "omit the clause"); the ON DELETE default is applied at
// emit time (fkAction), so an empty value passes validation here — this is the
// only place the raw wire value is seen, so it must not reject what the
// defaulting accepts.
func validateFKAction(what, v string) error {
	if v == "" {
		return nil
	}
	if !isFKAction(v) {
		return fmt.Errorf("%s is not a known referential action", what)
	}
	return nil
}

// normalizeFKAction canonicalizes an action read from a file. The parser
// uppercases type names the same way (reTypeNorm), so a hand-written
// "on delete cascade" loads as the canonical "CASCADE" the emitters write
// rather than failing the allowlist on save.
func normalizeFKAction(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// defaultFKAction normalizes a raw ON DELETE action, applying the model's
// historical CASCADE default when absent.
func defaultFKAction(raw string) string {
	if action := normalizeFKAction(raw); action != "" {
		return action
	}
	return "CASCADE"
}

// fkAction returns the effective ON DELETE action for a column: the stored
// action, or the historical CASCADE default when unset.
func fkAction(c Col) string {
	if c.Ref.Action == "" {
		return "CASCADE"
	}
	return c.Ref.Action
}

// fkUpdateClause renders the ON UPDATE clause, or "" when no action is set.
//
// Empty means omit — see the Ref comment for why ON UPDATE and ON DELETE use
// opposite conventions. Returning "" rather than a default is what keeps a
// schema without an ON UPDATE action byte-identical to the files this tool
// wrote before the field existed.
func fkUpdateClause(c Col) string {
	if c.Ref.OnUpdate == "" {
		return ""
	}
	return " ON UPDATE " + c.Ref.OnUpdate
}

// resolveActions normalizes a raw (delete, update) pair read from a file:
// DELETE gets the historical CASCADE default, UPDATE stays empty-means-omit.
func resolveActions(rawDel, rawUpd string) (string, string) {
	return defaultFKAction(rawDel), normalizeFKAction(rawUpd)
}
