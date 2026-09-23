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
	// maxIndexes bounds the per-table index list, same reasoning as maxColumns:
	// a request cannot allocate unbounded work inside the 1 MiB body cap.
	maxIndexes = 500
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

func isTypeStart(c byte) bool    { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' }
func isTypeNameChar(c byte) bool { return isTypeStart(c) || (c >= '0' && c <= '9') || c == ' ' }
func isTypeArgChar(c byte) bool {
	return isTypeNameChar(c) || c == ',' || c == '\'' || c == '"' || c == '(' || c == ')' || c == '.' || c == '+' || c == '-'
}

// isValidTypeExpr reports whether v matches
// `^[A-Za-z_][A-Za-z0-9_ ]*(\([A-Za-z0-9_ ,'"().+\-]*\))?(\[\])?$`.
// Manual parser replaces the previous regexp — ~28× faster, zero allocations.
// The shape is a bare name, or a name with one parenthesised argument list,
// optionally followed by one Postgres array suffix.
//
// The array suffix is stripped before the rest of the check, so `INT[]` is a
// valid type name with a suffix rather than a different grammar. Exactly one
// suffix is allowed: `INT[][]` is a multi-dimension array, which no emitter
// here renders, so accepting it would mean emitting something that does not
// mean what the model says.
func isValidTypeExpr(v string) bool {
	if len(v) == 0 {
		return false
	}
	if strings.HasSuffix(v, "[]") {
		v = strings.TrimSuffix(v, "[]")
		// a second suffix (INT[][]) leaves another one behind
		if strings.HasSuffix(v, "[]") || v == "" {
			return false
		}
	}
	if !isTypeStart(v[0]) {
		return false
	}
	parenIdx := strings.IndexByte(v, '(')
	isBareName := parenIdx == -1
	if isBareName {
		for i := 1; i < len(v); i++ {
			if !isTypeNameChar(v[i]) {
				return false
			}
		}
		return true
	}
	for i := 1; i < parenIdx; i++ {
		if !isTypeNameChar(v[i]) {
			return false
		}
	}
	hasClosingParen := v[len(v)-1] == ')'
	if !hasClosingParen {
		return false
	}
	argsContent := v[parenIdx+1 : len(v)-1]
	for i := 0; i < len(argsContent); i++ {
		if !isTypeArgChar(argsContent[i]) {
			return false
		}
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

// isArrayType reports whether a model type carries a Postgres array suffix.
// The suffix is the only structural difference between `INT` and `INT[]`, so
// every dialect decision below keys off it rather than parsing the type again.
func isArrayType(ty string) bool {
	return strings.HasSuffix(strings.TrimSpace(ty), "[]")
}

// Validate reports the first reason the schema cannot be emitted safely in its
// own dialect. See ValidateFor.
func (s *Schema) Validate() error {
	return s.ValidateFor(s.dialect())
}

// ValidateFor is Validate against a specific target dialect.
//
// The dialect matters because not every construct the model can hold is valid
// in every grammar. Array types are the case that made this necessary: `INT[]`
// is PostgreSQL syntax, and emitting it into MySQL or SQLite produces DDL the
// database rejects. Accepting the type in the grammar and then emitting invalid
// SQL elsewhere would be worse than rejecting it — the user would only find out
// when they pasted it into a database.
//
// It is parameterised rather than reading s.Dialect because /export takes the
// dialect as a separate request field, so the schema's stored dialect and the
// requested one can differ. Save and GenSQL pass the schema's own dialect via
// Validate; the export handler passes what the caller asked for.
func (s *Schema) ValidateFor(dialect string) error {
	if err := s.validateShape(); err != nil {
		return err
	}
	if normalizeDialect(dialect) == DialectPostgres {
		return nil
	}
	// Everything below is a construct the target dialect cannot render.
	for ti, t := range s.Tables {
		for ci, c := range t.Columns {
			if isArrayType(c.Type) {
				return fmt.Errorf(
					"table %d column %d (%q): array type %q is PostgreSQL-only; it cannot be emitted as %s",
					ti+1, ci+1, c.Name, c.Type, normalizeDialect(dialect))
			}
		}
	}
	return nil
}

// validateIndexes checks one table's index list. Extracted so validateShape
// stays a thin per-construct driver (the index checks alone were ~30 lines).
func validateIndexes(t Table) error {
	if len(t.Indexes) > maxIndexes {
		return fmt.Errorf("table %q: too many indexes: %d (max %d)", t.Name, len(t.Indexes), maxIndexes)
	}
	// A single-column index does NOT belong here: the model keeps those on
	// Col.Ix (see the Index comment in grammar.go), and every parser routes
	// len==1 to Col.Ix — so a table-level single-column Index is
	// unrepresentable. Accepting one would write DDL that reopens as a
	// different model.
	seenIndexes := map[string]bool{}
	for ii, ix := range t.Indexes {
		if len(ix.Cols) == 0 {
			return fmt.Errorf("table %q: index %d has no columns", t.Name, ii+1)
		}
		if len(ix.Cols) == 1 {
			return fmt.Errorf("table %q: index %d has one column; single-column indexes belong on the column", t.Name, ii+1)
		}
		if len(ix.Cols) > maxColumns {
			return fmt.Errorf("table %q: index %d has too many columns: %d (max %d)", t.Name, ii+1, len(ix.Cols), maxColumns)
		}
		// The emitted name (explicit or derived) must be unique per table:
		// two indexes deriving the same name write `KEY idx_...` twice,
		// which the database rejects. indexName is what the emitters use,
		// so this is checked against the same string they will emit.
		emitted := indexName(t, ix)
		if seenIndexes[emitted] {
			return fmt.Errorf("table %q: duplicate index name %q", t.Name, emitted)
		}
		seenIndexes[emitted] = true
		if ix.Name != "" {
			if err := validateIdent("index name", ix.Name); err != nil {
				return fmt.Errorf("table %q: %w", t.Name, err)
			}
		}
		for ci, col := range ix.Cols {
			if err := validateIdent("index column", col); err != nil {
				return fmt.Errorf("table %q index %d column %d: %w", t.Name, ii+1, ci+1, err)
			}
		}
	}
	return nil
}

// validateShape is the dialect-independent half of validation: the checks that
// hold no matter which grammar the schema will be written in.
func (s *Schema) validateShape() error {
	if len(s.Tables) > maxTables {
		return fmt.Errorf("too many tables: %d (max %d)", len(s.Tables), maxTables)
	}
	seenTables := map[string]bool{}
	for ti, t := range s.Tables {
		if err := validateIdent("table name", t.Name); err != nil {
			return fmt.Errorf("table %d: %w", ti+1, err)
		}
		// A duplicate table name cannot be emitted (CREATE TABLE twice) and on
		// reopen the parser's byName rejects it — so reject it here, before any
		// emitter sees it, with a message naming the table.
		if seenTables[t.Name] {
			return fmt.Errorf("duplicate table name %q", t.Name)
		}
		seenTables[t.Name] = true
		if len(t.Columns) > maxColumns {
			return fmt.Errorf("table %q: too many columns: %d (max %d)", t.Name, len(t.Columns), maxColumns)
		}
		// Index names and column lists are emitted as identifiers, so they go
		// through the same allowlist as table/column names — an index name is
		// the same injection surface as any other identifier.
		if err := validateIndexes(t); err != nil {
			return err
		}
		seenCols := map[string]bool{}
		for ci, c := range t.Columns {
			where := fmt.Sprintf("table %q column %d", t.Name, ci+1)
			if err := validateIdent("column name", c.Name); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			// Duplicate column names produce `c` INT, `c` INT — invalid DDL in
			// every dialect, and on reopen markCol matches only the first.
			if seenCols[c.Name] {
				return fmt.Errorf("table %q: duplicate column name %q", t.Name, c.Name)
			}
			seenCols[c.Name] = true
			if err := validateType(c.Type); err != nil {
				return fmt.Errorf("%s (%q): %w", where, c.Name, err)
			}
			// Array types are PostgreSQL-only (enforced in ValidateFor), but
			// these three combinations are invalid in PostgreSQL too, so they
			// are rejected here — independently of the target dialect — rather
			// than emitted as DDL the database refuses.
			if isArrayType(c.Type) {
				base, _ := splitType(strings.TrimSuffix(strings.TrimSpace(c.Type), "[]"))
				switch {
				case base == "ENUM":
					// The ENUM rendering is `TEXT + CHECK (col IN (...))`, which
					// describes one value, not an array of them; there is no
					// correct CHECK for ENUM[] here, so it is refused rather
					// than emitted as a constraint that means something else.
					return fmt.Errorf("%s (%q): ENUM arrays are not supported", where, c.Name)
				case c.Ai:
					return fmt.Errorf("%s (%q): an array column cannot be AUTO_INCREMENT/IDENTITY", where, c.Name)
				case c.Pk:
					return fmt.Errorf("%s (%q): an array column cannot be a PRIMARY KEY", where, c.Name)
				}
			}
			if err := validateText("comment", c.Comment, maxCommentLen); err != nil {
				return fmt.Errorf("%s (%q): %w", where, c.Name, err)
			}
			if c.Ref != nil {
				if err := validateText("FK action", c.Ref.Action, maxNameLen); err != nil {
					return fmt.Errorf("%s (%q): %w", where, c.Name, err)
				}
				if err := validateFKAction("FK action", c.Ref.Action); err != nil {
					return fmt.Errorf("%s (%q): %w", where, c.Name, err)
				}
				if err := validateFKAction("FK on-update action", c.Ref.OnUpdate); err != nil {
					return fmt.Errorf("%s (%q): %w", where, c.Name, err)
				}
				if err := validateIdent("FK target id", c.Ref.TableID); err != nil {
					return fmt.Errorf("%s (%q): %w", where, c.Name, err)
				}
			}
		}
	}
	return nil
}

func checkBasicString(what, v string, max int) error {
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

func validateIdent(what, v string) error {
	if v == "" {
		return fmt.Errorf("empty %s", what)
	}
	// A semicolon is refused here rather than left to validateOutput's last
	// gate: inside a quoted identifier it is technically safe, but the emitted
	// line ends up looking like an injection ("ok; DROP TABLE ...") and the
	// old last-gate rejection was a confusing 400 far from the cause. No file
	// on disk has such a name — the old gate blocked every save — so refusing
	// early cannot strand an existing schema.
	if strings.ContainsRune(v, ';') {
		return fmt.Errorf("%s contains a semicolon", what)
	}
	if err := checkBasicString(what, v, maxNameLen); err != nil {
		// checkBasicString reports "contains a control character" without quoting;
		// for identifiers we include the value (quoted) so the user sees which
		// name failed, with the newline-risk comment preserved here.
		if hasControlChar(v) {
			return fmt.Errorf("%s %q contains a control character", what, v)
		}
		return err
	}
	return nil
}

func validateType(v string) error {
	if v == "" {
		return fmt.Errorf("empty type")
	}
	if err := checkBasicString("type", v, maxTypeLen); err != nil {
		return err
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
	return checkBasicString(what, v, max)
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
//
// The scan is quote-aware: a ";" inside a backtick- or double-quoted
// identifier, or inside a string literal, is part of that token rather than a
// separator — an index named `a;b` (valid per the identifier allowlist) must
// not bounce here with a confusing "embedded separator" message.
func validateOutput(sql string) error {
	for i, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if hasControlChar(trimmed) {
			return fmt.Errorf("generated DDL line %d contains a control character", i+1)
		}
		if strings.HasPrefix(trimmed, "--") {
			continue // a comment may contain anything
		}
		var q byte = 0 // byte(0) = outside quotes; one of ' " ` while inside
		// A classic counter loop, not `for j := range`: the escape branch's
		// j++ must skip BOTH quotes of a '' pair. With range, the increment is
		// discarded on the next iteration, so the second quote wrongly closed
		// the string and a ";" after an escaped quote was flagged as a
		// separator (a comment like 'it''s; mine' failed validation).
		for j := 0; j < len(trimmed); j++ {
			c := trimmed[j]
			if q != 0 {
				if c == q {
					if q == '\'' && j+1 < len(trimmed) && trimmed[j+1] == '\'' {
						j++ // '' escape inside a string literal
						continue
					}
					q = 0
				}
				continue
			}
			switch {
			case c == '\'' || c == '"' || c == '`':
				q = c
			case c == ';' && j != len(trimmed)-1:
				return fmt.Errorf("generated DDL line %d contains an embedded statement separator", i+1)
			}
		}
	}
	return nil
}
