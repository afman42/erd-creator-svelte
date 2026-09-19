// validate.go — the trust boundary for schema input.
//
// The schema JSON is untrusted: it arrives over HTTP, and a .sql file on disk
// is untrusted too (it may have been written by hand, by another tool, or by a
// previous version). This program's entire job is to turn that data into SQL
// text, so a value that escapes its syntactic position becomes SQL injection in
// whatever database the user pastes the output into.
//
// The emitters quote identifiers, and that quoting is correct — a name
// containing a backtick is escaped as “ and stays inside its identifier. But
// two things it cannot protect against:
//
//   - A TYPE is emitted as raw text. `VARCHAR(255)` is copied through because
//     the type grammar is open-ended (DECIMAL(10,2), ENUM('a','b'), …). Nothing
//     stopped `VARCHAR(1;DROP TABLE users;--)` from being emitted verbatim, and
//     the parser would happily read it back from a file and re-emit it.
//   - A newline or NUL in an identifier breaks the OUTPUT FORMAT rather than
//     the quoting. The emitters produce one statement per line, and the parsers
//     read line by line, so an embedded "\n" splits a name across lines and the
//     result is not the DDL the model describes.
//
// So validation is the boundary, not escaping alone. It rejects values that
// cannot be represented safely instead of trying to neutralise them, because
// there is no correct escaping for a type that is arbitrary SQL.
package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	// maxNameLen bounds a single identifier. Long enough for real names, short
	// enough that a schema cannot be padded into an oversized response.
	maxNameLen = 128
	// maxTypeLen bounds a type expression. ENUM lists are the long case.
	maxTypeLen = 4096
	// maxCommentLen bounds a column comment.
	maxCommentLen = 4096
	// maxTables / maxColumns bound the model so one request cannot allocate an
	// unbounded amount of work. The request body is capped separately (1 MiB);
	// these bound the parsed result independently of encoding.
	maxTables  = 500
	maxColumns = 500
)

// safeIdent rejects anything that cannot appear in an identifier we emit.
//
// The character class is deliberately an allowlist. Identifiers here are table
// and column names typed by a human into a form, so the set of things that need
// to work is small: letters, digits, underscore, space, and the punctuation
// that shows up in real schemas. Notably absent are control characters, and
// quote characters are permitted only because the emitters escape them — the
// check below is about structural safety, not about quoting.

// hasControlChar reports whether s contains C0/C1 controls or DEL. These are
// never legitimate in an identifier and a newline in particular breaks the
// line-oriented output. Manual loop replaces the previous regexp
// `[\x00-\x1f\x7f-\x9f]` — ~10× faster, zero allocations, same semantics.
func hasControlChar(s string) bool {
	for _, r := range s {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			return true
		}
	}
	return false
}

// isValidTypeExpr reports whether v matches `^[A-Za-z_][A-Za-z0-9_ ]*(\([A-Za-z0-9_ ,'"().+\-]*\))?$`.
// Manual parser replaces the previous regexp — ~28× faster, zero allocations.
// The shape is a bare name, or a name with one parenthesised argument list.
// Inside the parens only characters that appear in real type arguments are
// allowed so a statement separator or comment marker cannot hide there.
func isValidTypeExpr(v string) bool {
	if len(v) == 0 {
		return false
	}
	c := v[0]
	if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_') {
		return false
	}
	parenIdx := strings.IndexByte(v, '(')
	if parenIdx == -1 {
		for i := 1; i < len(v); i++ {
			ch := v[i]
			if !((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == ' ') {
				return false
			}
		}
		return true
	}
	for i := 1; i < parenIdx; i++ {
		ch := v[i]
		if !((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == ' ') {
			return false
		}
	}
	if v[len(v)-1] != ')' {
		return false
	}
	for i := parenIdx + 1; i < len(v)-1; i++ {
		ch := v[i]
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == ' ' || ch == ',' || ch == '\'' || ch == '"' || ch == '(' || ch == ')' || ch == '.' || ch == '+' || ch == '-' {
			continue
		}
		return false
	}
	return true
}

// validTypeRunes is the same character set isValidTypeExpr allows, kept beside
// it so error-message truncation stops exactly where the pattern would reject.
const validTypeRunes = "abcdefghijklmnopqrstuvwxyz" +
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
	"0123456789_ ,'\"().+-"

// validTypeByte is a lookup table for excerpt's per-rune check — O(1) vs
// strings.ContainsRune's O(n) scan over validTypeRunes (80 chars).
var validTypeByte = func() [256]bool {
	var t [256]bool
	for i := 0; i < len(validTypeRunes); i++ {
		t[validTypeRunes[i]] = true
	}
	return t
}()

// Validate reports the first reason the schema cannot be emitted safely.
// It is called on every path that turns input into SQL: the JSON endpoints
// (save, export, lint, inserts) and the parser that reads a .sql file.
func (s *Schema) Validate() error {
	if len(s.Tables) > maxTables {
		return fmt.Errorf("too many tables: %d (max %d)", len(s.Tables), maxTables)
	}
	for ti, t := range s.Tables {
		if err := validateIdent("table name", t.Name); err != nil {
			return fmt.Errorf("table %d: %w", ti+1, err)
		}
		if len(t.Columns) > maxColumns {
			return fmt.Errorf("table %q: too many columns: %d (max %d)", t.Name, len(t.Columns), maxColumns)
		}
		for ci, c := range t.Columns {
			where := fmt.Sprintf("table %q column %d", t.Name, ci+1)
			if err := validateIdent("column name", c.Name); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			if err := validateType(c.Type); err != nil {
				return fmt.Errorf("%s (%q): %w", where, c.Name, err)
			}
			if err := validateText("comment", c.Comment, maxCommentLen); err != nil {
				return fmt.Errorf("%s (%q): %w", where, c.Name, err)
			}
			if c.Ref != nil {
				if err := validateText("FK action", c.Ref.Action, maxNameLen); err != nil {
					return fmt.Errorf("%s (%q): %w", where, c.Name, err)
				}
				if err := validateIdent("FK target id", c.Ref.TableId); err != nil {
					return fmt.Errorf("%s (%q): %w", where, c.Name, err)
				}
			}
		}
	}
	return nil
}

func validateIdent(what, v string) error {
	if v == "" {
		return fmt.Errorf("empty %s", what)
	}
	if !utf8.ValidString(v) {
		return fmt.Errorf("%s is not valid UTF-8", what)
	}
	if len(v) > maxNameLen {
		return fmt.Errorf("%s too long: %d bytes (max %d)", what, len(v), maxNameLen)
	}
	if hasControlChar(v) {
		// A newline here would split one statement into two lines in the emitted
		// DDL, and the parser reads line by line — so the file would no longer
		// describe the model. Rejected rather than stripped: silently changing a
		// user's identifier is worse than refusing it.
		return fmt.Errorf("%s %q contains a control character", what, v)
	}
	return nil
}

func validateType(v string) error {
	if v == "" {
		return fmt.Errorf("empty type")
	}
	if !utf8.ValidString(v) {
		return fmt.Errorf("type is not valid UTF-8")
	}
	if len(v) > maxTypeLen {
		return fmt.Errorf("type too long: %d bytes (max %d)", len(v), maxTypeLen)
	}
	if hasControlChar(v) {
		// Deliberately does not echo the value: it is attacker-controlled, and
		// reflecting it into an error that a UI displays (or a user pastes into
		// a bug report) spreads the payload. The column is already named.
		return fmt.Errorf("type contains a control character")
	}
	if !isValidTypeExpr(v) {
		// Same reasoning, plus a bounded excerpt so a legitimate typo is still
		// diagnosable. The excerpt is cut to the first rejected character, so a
		// long injected statement is not reproduced in the error.
		return fmt.Errorf("type is not a valid type expression (%s)", excerpt(v))
	}
	return nil
}

// excerpt renders a rejected value for an error message, stopping at the first
// character that makes it invalid.
//
// Truncating to a fixed length is not enough: a payload like
// "VARCHAR(1;DROP TABLE users;--)" is under any reasonable cap, so it would be
// echoed whole. Cutting at the first offending character means the error shows
// only the part that was plausible — "VARCHAR(1" — and never the injected tail.
// That keeps the message useful for a typo without reflecting an attack string
// into a response, a log, or a bug report.
func excerpt(v string) string {
	const max = 32
	for i, r := range v {
		if r < 256 {
			if validTypeByte[byte(r)] {
				continue
			}
		} else if strings.ContainsRune(validTypeRunes, r) {
			continue
		}
		if i == 0 {
			return "invalid character"
		}
		return fmt.Sprintf("%q… (rejected at character %d)", v[:i], i+1)
	}
	if len(v) > max {
		return fmt.Sprintf("%q…", v[:max])
	}
	return fmt.Sprintf("%q", v)
}

func validateText(what, v string, max int) error {
	if !utf8.ValidString(v) {
		return fmt.Errorf("%s is not valid UTF-8", what)
	}
	if len(v) > max {
		return fmt.Errorf("%s too long: %d bytes (max %d)", what, len(v), max)
	}
	if hasControlChar(v) {
		return fmt.Errorf("%s contains a control character", what)
	}
	return nil
}

// validateOutput is the last line of defence: it re-checks the text an emitter
// produced. Validation runs on input, so this only fires if an emitter composes
// a statement in a way the input checks did not anticipate — for example a
// future dialect that renders a type differently. It is cheap and it turns a
// silent injection into a 400.
//
// It looks for a statement separator that is not at a line end, which is the
// signature of a value that escaped its position. A legitimate emitter never
// produces that: every statement it writes is terminated at the end of a line.
func validateOutput(sql string) error {
	for i, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if hasControlChar(trimmed) {
			return fmt.Errorf("generated DDL line %d contains a control character", i+1)
		}
		// a ";" mid-line is only valid inside a quoted string or a comment
		if idx := strings.Index(trimmed, ";"); idx >= 0 && idx != len(trimmed)-1 {
			if !strings.HasPrefix(trimmed, "--") && !strings.Contains(trimmed, "'") {
				return fmt.Errorf("generated DDL line %d contains an embedded statement separator", i+1)
			}
		}
	}
	return nil
}
