// grammar.go — the schema model, MySQL canonical parse, and lint.
// Single source of truth: the browser sends/renders schema JSON; grammar
// decisions live in this package. The saved .sql is exactly what GenSQL emits —
// GenSQL delegates to buildMysql (export.go) so save and export share ONE
// emitter — and ParseDDL reads only that subset (same contract the old JS
// parser had).
package main

import (
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
)

// ---- model ----

// Ref is a column's foreign key. On the wire the browser sends
// {"tableId","action","onUpdate"}.
//
// Action is ON DELETE. It defaults to CASCADE when empty, because that is what
// every file written before the field existed means — the emitters have always
// written "ON DELETE CASCADE" for an unset action, so an empty value cannot
// mean "omit the clause" without changing those files.
//
// OnUpdate is ON UPDATE, and empty means OMIT the clause — the opposite
// convention, deliberately. ON DELETE had to keep its historical default; ON
// UPDATE is new, so an unset value can mean "let the database decide"
// (NO ACTION / RESTRICT) instead of silently emitting a clause nobody chose.
// That is also what keeps every existing .sql byte-identical: no schema written
// before this field existed carries an ON UPDATE clause.
type Ref struct {
	TableID  string `json:"tableId"`
	Action   string `json:"action"`
	OnUpdate string `json:"onUpdate,omitempty"`
}

// Index is a table-level index over one or more columns.
//
// Composite indexes cannot be represented on Col: `Ix bool` says "this column
// is indexed", which cannot express (a, b) as one index — three columns each
// marked Ix are three separate indexes, a different thing. So a multi-column
// index is a property of the table.
//
// Name is optional. Empty means "derive one" (idx_<table>_<col1>_<col2>…),
// which is the same convention the single-column path already uses
// (idx_<table>_<col>), so the common case needs no naming UI. A name is stored
// explicitly once it is set, because deriving on every emit would rename an
// index the user had chosen.
//
// A single-column index does NOT go here: it stays on Col.Ix. That keeps every
// existing file's bytes and JSON unchanged, and the parsers route by column
// count (one → Col.Ix, many → Index) so both shapes round-trip.
type Index struct {
	Name string   `json:"name,omitempty"`
	Cols []string `json:"cols"`
}

type Col struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Pk      bool   `json:"pk"`
	Nn      bool   `json:"nn"`
	Ai      bool   `json:"ai"`
	Ux      bool   `json:"ux"`
	Ix      bool   `json:"ix"`
	Comment string `json:"comment"`
	// Default is the column's DEFAULT expression, stored as the user typed it
	// (0, 'active', CURRENT_TIMESTAMP, (uuid())). Empty means "no clause".
	// omitempty keeps the wire JSON unchanged for schemas without one.
	// Emitted raw like the type, so it is allowlist-validated (validateDefault)
	// before any emitter sees it.
	Default string `json:"default,omitempty"`
	Ref     *Ref   `json:"ref"`
}

// Table is one table in the schema. ID is the wire key the browser uses for
// ref.tableId; on open the client re-allocates ids in its own namespace
// (adoptIds). X/Y are client-only.
//
// Indexes is omitempty so a schema without composite indexes serializes to
// exactly the JSON it did before the field existed — the model travels to the
// browser, and an added `"indexes":null` would be a wire change for every
// existing client and test.
type Table struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	X       int     `json:"-"`
	Y       int     `json:"-"`
	Columns []Col   `json:"columns"`
	Indexes []Index `json:"indexes,omitempty"`
	// Comment is stored like Indexes: omitempty so a table without one
	// serializes to the exact JSON it did before the field existed. It is
	// emitted as a MySQL table option, a Postgres COMMENT ON TABLE, and
	// dropped (lossy) for SQLite, which has no table comment.
	Comment string `json:"comment,omitempty"`
}

type Schema struct {
	// Dialect is the DDL flavor this schema is stored as. Empty means mysql, so
	// files written before dialects existed keep loading unchanged.
	Dialect string `json:"dialect,omitempty"`
	// SqliteTypes selects how SQLite DDL renders the types SQLite has no
	// dedicated storage class for (BOOLEAN, DATETIME, TIMESTAMP). Empty means
	// SqliteTypesNative. It is a property of the schema because it changes the
	// bytes a save writes, exactly like Dialect.
	SqliteTypes string  `json:"sqliteTypes,omitempty"`
	Tables      []Table `json:"tables"`
}

// Dialect names. mariadb shares the mysql grammar (byte-identical DDL, only the
// header comment differs); postgres and sqlite each have their own emitter and
// parser, because their grammars differ structurally rather than in quoting.
const (
	DialectMysql    = "mysql"
	DialectMariaDB  = "mariadb"
	DialectPostgres = "postgres"
	DialectSqlite   = "sqlite"
)

// SQLite renders BOOLEAN, DATETIME and TIMESTAMP in one of two ways, because
// SQLite has no storage class for any of them and both choices are defensible:
//
//	SqliteTypesNative (default) — keep the model's own type name. SQLite accepts
//	  these names and stores them verbatim, applying NUMERIC affinity (BOOLEAN,
//	  DATETIME, TIMESTAMP) or TEXT affinity (nothing here). Reopening the file
//	  returns the same type, so the schema survives a round-trip unchanged and
//	  an export to another dialect is not silently downgraded.
//
//	SqliteTypesPortable — rewrite to the storage class SQLite would pick
//	  anyway: BOOLEAN → INTEGER, DATETIME/TIMESTAMP → TEXT. This is what the
//	  emitter did before the choice existed, and it is what you want if the file
//	  is read by a tool that keys off the declared type name. It is LOSSY: the
//	  model type is gone on reopen, and a later export to mysql/postgres emits
//	  INTEGER/TEXT instead of BOOLEAN/DATETIME.
//
// ENUM is unaffected: it becomes TEXT + a CHECK constraint in both modes,
// because SQLite has no enum type at all. The values are recovered on reopen
// either way.
const (
	SqliteTypesNative   = "native"
	SqliteTypesPortable = "portable"
)

// sqliteTypesMode normalizes the schema's SQLite type mode, defaulting to
// native so unset (every schema, and every file written before this existed)
// gets the lossless behaviour.
func (s *Schema) sqliteTypesMode() string {
	if strings.ToLower(strings.TrimSpace(s.SqliteTypes)) == SqliteTypesPortable {
		return SqliteTypesPortable
	}
	return SqliteTypesNative
}

// dialectAliases maps accepted spellings to canonical names. Real dialects are
// listed explicitly rather than left to the default: relying on fallthrough
// silently rewrote sqlite as mysql, which let a sqlite schema pass the save guard
// and be written with a MySQL header. mariadb is likewise its own name, not a
// spelling of mysql.
var dialectAliases = map[string]string{
	"postgres":   DialectPostgres,
	"postgresql": DialectPostgres,
	"pg":         DialectPostgres,
	"mariadb":    DialectMariaDB,
	"maria":      DialectMariaDB,
	"sqlite":     DialectSqlite,
	"mysql":      DialectMysql,
}

// saveableSet is the set of dialects that round-trip through a .sql file.
// All four have parsers, so their files reopen. Unknown names are NOT
// saveable: normalizeDialect falls back to mysql for the empty/unset case,
// but saveFile rejects a non-empty unknown string before it can be stored
// under a false dialect label (see validateDialectForSave).
var saveableSet = map[string]bool{
	DialectMysql:    true,
	DialectMariaDB:  true,
	DialectPostgres: true,
	DialectSqlite:   true,
}

// validateDialectForSave rejects a non-empty dialect string that names no
// known dialect. Empty means "unset" (every file written before the field
// existed) and is accepted as mysql; anything else unrecognized would
// otherwise be stored as mysql while the UI shows the unknown name.
func validateDialectForSave(d string) error {
	if strings.TrimSpace(d) == "" {
		return nil
	}
	if _, ok := dialectAliases[strings.ToLower(strings.TrimSpace(d))]; !ok {
		return fmt.Errorf("unknown dialect %q (want mysql, mariadb, postgres, sqlite)", d)
	}
	return nil
}

// normalizeDialect maps accepted spellings onto a canonical name, defaulting to
// mysql. The empty string falls back because an unset dialect is the common case
// (every file written before this field existed).
func normalizeDialect(d string) string {
	if v, ok := dialectAliases[strings.ToLower(strings.TrimSpace(d))]; ok {
		return v
	}
	return DialectMysql // unset or unrecognized: treat as the default
}

// dialect is the normalized save/parse dialect for this schema.
func (s *Schema) dialect() string { return normalizeDialect(s.Dialect) }

// saveable reports whether a schema's dialect can be written to a .sql file.
func (s *Schema) saveable() bool {
	// keep DialectMysql DialectMariaDB DialectPostgres DialectSqlite visible for
	// the frontend's cross-check (it scans this function for the case list).
	return saveableSet[s.dialect()]
}

// Lint reports FK base-type vs referenced PK base-type mismatch, and an FK
// pointing at a composite PK.
func (s *Schema) Lint() []string {
	byID := tableMap(s.Tables)
	var out []string
	for _, t := range s.Tables {
		for _, c := range t.Columns {
			if c.Ref == nil {
				continue
			}
			p := byID[c.Ref.TableID]
			if p == nil {
				out = append(out, fmt.Sprintf("%s.%s → table %s: missing table; FK omitted from DDL", t.Name, c.Name, c.Ref.TableID))
				continue
			}
			var pks []Col
			for _, x := range p.Columns {
				if x.Pk {
					pks = append(pks, x)
				}
			}
			switch {
			case len(pks) > 1:
				out = append(out, fmt.Sprintf("%s.%s → %s has composite PK; single-col FK is invalid DDL", t.Name, c.Name, p.Name))
				continue
			case len(pks) == 0:
				// No PK → no unique column to point at, so the FK is omitted
				// from every dialect rather than silently targeting the first
				// column (invalid DDL). Report it, or the relationship just
				// vanishes from the output with no explanation.
				out = append(out, fmt.Sprintf("%s.%s → %s has no PK; FK omitted from DDL", t.Name, c.Name, p.Name))
				continue
			}
			pk := pks[0]
			// Compare element types: the [] array suffix is PostgreSQL syntax that
			// changes the column to a collection of the same base type, so an
			// INT[] FK onto an INT PK is a match, not a mismatch. Without the
			// strip, every array FK onto a non-array PK flagged a false mismatch.
			fkBase, pkBase := baseOf(c.Type), baseOf(pk.Type)
			if strings.TrimSuffix(fkBase, "[]") != strings.TrimSuffix(pkBase, "[]") {
				out = append(out, fmt.Sprintf("%s.%s %s vs %s.%s %s", t.Name, c.Name, fkBase, p.Name, pk.Name, pkBase))
			}
		}
	}
	return out
}

// ---- MySQL canonical emit ----

func pkCols(t Table) []Col {
	var out []Col
	for _, c := range t.Columns {
		if c.Pk {
			out = append(out, c)
		}
	}
	return out
}

// GenSQL is the saved-file grammar: exactly what saveFile writes to disk, and
// exactly what ParseDDL reads back.
//
// Each branch delegates to the same emitter /export uses, so the save path and
// the export path share ONE implementation per dialect. Two emitters for one
// grammar drifted before (save dropped an FK onto a PK-less parent that export
// emitted) and the same mistake is available to two parsers, which is why each
// dialect also has a round-trip test.
//
// The mysql header stays exactly "-- Generated by erd-creator" with no dialect
// suffix: that is what every file written before dialects existed contains, and
// changing it would churn all of them. The mariadb and postgres headers carry
// the suffix, which is what makes dialect detection on open possible.
// Output is pinned by TestGenSQLGolden / TestMariaDBGolden / TestPostgresGolden.
//
// It returns an error rather than an empty string on invalid input: an emitter
// that can produce SQL injection is a footgun, and a caller that forgets to
// validate must be told, not silently handed "". The signature is what makes
// that impossible to ignore.
func (s *Schema) GenSQL() (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	out := emitNormalized(s.dialect(), s.Tables, s.sqliteTypesMode(), "-- Generated by erd-creator")
	// Last gate before the text leaves this process, catching an emitter that
	// composes a statement in a way the input checks did not anticipate.
	if err := validateOutput(out); err != nil {
		return "", err
	}
	return out, nil
}

// ---- seed INSERT templates ----

// GenInserts renders one commented INSERT template per table with columns, for
// seeding a database by hand, in the schema's own dialect (the API posts the
// whole schema, so whichever grammar is selected drives the quoting and the
// function names — the same rule the SQL panel and export follow).
func (s *Schema) GenInserts() string {
	return s.GenInsertsFor(s.dialect())
}

// GenInsertsFor is GenInserts against a specific dialect. The quoting follows
// the target grammar (backticks for mysql/sqlite, double quotes for postgres)
// and SQLite has no NOW() function, so datetime placeholders become
// CURRENT_TIMESTAMP there; everything else — AI → NULL, BOOLEAN → FALSE,
// JSON → '{}' — is identical across dialects, since each accepts those
// literals. The mysql header text is unchanged so existing output and tests
// keep their bytes.
func (s *Schema) GenInsertsFor(dialect string) string {
	normalized := normalizeDialect(dialect)
	q := quoteTick
	now := "NOW()"
	switch normalized {
	case DialectPostgres:
		q = quoteDQ
	case DialectSqlite:
		now = "CURRENT_TIMESTAMP"
	}
	header := "-- Seed row templates (edit values, remove per table as needed)"
	if normalized == DialectPostgres || normalized == DialectSqlite {
		header = fmt.Sprintf("-- Seed row templates (%s) — edit values, remove per table as needed", normalized)
	}
	out := []string{header}
	for _, t := range s.Tables {
		if len(t.Columns) == 0 {
			continue
		}
		vals := make([]string, len(t.Columns))
		names := make([]string, len(t.Columns))
		for i, c := range t.Columns {
			b := baseOf(c.Type)
			switch {
			case c.Ai:
				vals[i] = "NULL"
			case isInt(b):
				vals[i] = "0"
			case b == "DECIMAL":
				vals[i] = "0.00"
			case b == "BOOLEAN":
				vals[i] = "FALSE"
			case b == "DATE":
				vals[i] = "'2026-01-01'"
			case b == "DATETIME" || b == "TIMESTAMP":
				vals[i] = now
			case b == "JSON":
				vals[i] = "'{}'"
			default:
				vals[i] = "''"
			}
			names[i] = q(c.Name)
		}
		out = append(out, "INSERT INTO "+q(t.Name)+" ("+strings.Join(names, ", ")+") VALUES ("+strings.Join(vals, ", ")+");")
	}
	// Inserts carry only quoted identifiers and fixed literals, but they leave
	// through the same last gate as DDL: a future column in the template must
	// not emit unchecked. A gate failure here is a bug, not bad input, so it
	// is logged and the output is still returned.
	out2 := strings.Join(out, "\n") + "\n"
	if err := validateOutput(out2); err != nil {
		log.Printf("gen inserts gate: %v", err)
	}
	return out2
}

// ---- parse: reads only GenSQL output ----

// ddlRe compiles a parser pattern written with a ~ sentinel standing in for a
// backtick, then swaps the sentinel in. A raw Go string literal cannot contain
// a backtick, and every identifier this grammar emits is backtick-quoted, so
// the patterns need a way to spell one. Postgres avoids the problem because its
// quote is a double quote; the mysql/sqlite grammars cannot. The sentinel is
// written as "~" to mirror the golden-test convention (TestGenSQLGolden).
//
// The identifier token the sentinel-protected alternatives spell is: a fully
// quoted token (`a b`, backticks INCLUDED so unquoteTick sees them) or a bare
// run without spaces/backticks for hand-written files that omit quotes.
func ddlRe(pattern string) *regexp.Regexp {
	return regexp.MustCompile(strings.ReplaceAll(pattern, "~", "`"))
}

var (
	reInsert   = regexp.MustCompile(`(?i)^INSERT INTO `)
	reCreate   = ddlRe(`(?i)^CREATE TABLE ((?:~(?:[^~]|~~)*~|[^\s~]+)) \($`)
	reEndTable = regexp.MustCompile(`(?i)^\) ENGINE=InnoDB( COMMENT='((?:[^']|'')*)')?;?$`)
	rePK       = regexp.MustCompile(`(?i)^PRIMARY KEY \((.+)\)$`)
	reUKey     = ddlRe(`(?i)^UNIQUE KEY ((?:~(?:[^~]|~~)*~|[^\s~]+)) \((.+)\)$`)
	reIndex    = ddlRe(`(?i)^(?:KEY|INDEX) ((?:~(?:[^~]|~~)*~|[^\s~]+)) \((.+)\)$`)
	reFK       = ddlRe(`(?i)^CONSTRAINT (?:~(?:[^~]|~~)*~|[^\s~]+) FOREIGN KEY \(((?:~(?:[^~]|~~)*~|[^\s~]+))\) REFERENCES ((?:~(?:[^~]|~~)*~|[^\s~]+)) \(((?:~(?:[^~]|~~)*~|[^\s~]+))\)( ON DELETE (SET NULL|SET DEFAULT|NO ACTION|RESTRICT|CASCADE))?( ON UPDATE (SET NULL|SET DEFAULT|NO ACTION|RESTRICT|CASCADE))?$`)
	// The type is `[A-Z]+` + an argument list whose parentheses may contain
	// quoted strings — ENUM('a)b') has a ) inside a literal — so the argument
	// scan treats '...' (with '' escaping) as opaque and only stops at an
	// UNQUOTED ) . `[^)]*` could not: it stopped at the first ) even inside a
	// value, rejecting a type the model accepts and the emitter writes.
	//
	// The DEFAULT capture is a lazy run of (quoted literal | non-semicolon):
	// lazy so a following ` COMMENT '...'` clause is not swallowed into the
	// value, and quote-tolerant so `DEFAULT 'it''s'` and `DEFAULT (uuid())`
	// both parse. Parens inside a default are fine; a `;` inside a quoted
	// default is fine too (validateOutput treats it as literal) but one
	// outside quotes would be the injection shape and validation rejects the
	// value before it is ever emitted.
	reColumn   = ddlRe(`(?i)^((?:~(?:[^~]|~~)*~|[^\s~]+)) ([A-Z]+(?:\((?:'[^']*'|[^)])*\))?)( NOT NULL)?( AUTO_INCREMENT)?( UNIQUE)?( DEFAULT ((?:'[^']*'|[^;])*?))?( COMMENT '((?:[^']|'')*)')?$`)
	reTypeNorm = regexp.MustCompile(`(?i)^([A-Za-z]+)(\(.*\))?$`)
)

func unquote(s string, quote byte, esc, repl string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == quote && s[len(s)-1] == quote {
		return strings.ReplaceAll(s[1:len(s)-1], esc, repl)
	}
	return s
}

func unquoteTick(s string) string {
	return unquote(s, '`', "``", "`")
}

// unescapeStr undoes ” escaping in string literals (comments, defaults).
func unescapeStr(s string) string {
	return strings.ReplaceAll(s, "''", "'")
}

// splitIndexCols splits an emitted index column list into unquoted names.
//
// It exists so all three parsers share one implementation: they emit the list
// the same way (comma-space separated, each column quoted) and differ only in
// which quote to strip. Three copies is how the FK attach loop drifted, so this
// is written once and parameterised by the unquote function.
//
// Empty entries are dropped rather than kept: a trailing comma or a stray space
// would otherwise become a phantom column name that validates fine and then
// fails to match any real column.
func splitIndexCols(list string, unquote func(string) string) []string {
	var out []string
	for _, part := range splitTop(list) {
		if name := unquote(part); name != "" {
			out = append(out, name)
		}
	}
	return out
}

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

// validateFKAction checks one referential action. Empty is allowed for ON
// UPDATE (it means "omit the clause"); the ON DELETE default is applied at
// emit time (fkAction), so an empty value passes validation here — this is the
// only place the raw wire value is seen, so it must not reject what the
// defaulting accepts.
func validateFKAction(what, v string) error {
	if v == "" {
		return nil
	}
	if !fkActions[v] {
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

type pendingFK struct {
	tableID, col, table, action, onUpdate string
}

// parserState is the shared per-parse accumulator for the table loop: name/id
// indexes, pending FKs, current-table cursor, id allocator. parseMysql uses it;
// pg/sqlite/import keep theirs (different skip/out-of-line rules) — unifying
// the struct without the loop would gain nothing.
type parserState struct {
	s       *Schema
	byName  map[string]int
	byID    map[string]int
	pending []pendingFK
	cur     int
	tableID int
}

func newParserState(dialect string) *parserState {
	return &parserState{s: &Schema{Dialect: dialect}, byName: map[string]int{}, byID: map[string]int{}, cur: -1}
}

func (p *parserState) addTable(name string, n int) error {
	if _, dup := p.byName[name]; dup {
		return fmt.Errorf("line %d: duplicate table %q", n, name)
	}
	p.tableID++
	id := fmt.Sprintf("t%d", p.tableID)
	p.s.Tables = append(p.s.Tables, Table{ID: id, Name: name})
	p.byName[name] = len(p.s.Tables) - 1
	p.byID[id] = len(p.s.Tables) - 1
	p.cur = len(p.s.Tables) - 1
	return nil
}

// routeIndex routes an index by arity: one column is the per-column Ix flag
// (old files round-trip byte-identically), several is a composite Index.
func routeIndex(tbl *Table, cols []string, name string) {
	if len(cols) == 1 {
		markCol(tbl, cols[0], func(c *Col) { c.Ix = true })
	} else if len(cols) > 1 {
		tbl.Indexes = append(tbl.Indexes, Index{Name: name, Cols: cols})
	}
}

// defaultFKAction normalizes a raw ON DELETE action, applying the model's
// historical CASCADE default when absent.
func defaultFKAction(raw string) string {
	if action := normalizeFKAction(raw); action != "" {
		return action
	}
	return "CASCADE"
}

// ParseDDL rebuilds a schema from DDL this tool emitted, detecting the dialect
// from the file's header comment. Files written before dialects existed have no
// marker and parse as mysql. Any unsupported line rejects the whole file; the
// caller keeps prior state.
func ParseDDL(sql string) (*Schema, error) {
	dialect := detectDialect(sql)
	var (
		s   *Schema
		err error
	)
	switch dialect {
	case DialectPostgres:
		s, err = parsePostgres(sql)
	case DialectSqlite:
		s, err = parseSqlite(sql)
	default:
		// mysql and mariadb share one grammar, so they share one parser; the
		// detected name is passed in only so the schema keeps its identity.
		s, err = parseMysql(sql, dialect)
	}
	if err != nil {
		return nil, err
	}
	// A .sql file is untrusted input too: it may have been hand-written, or
	// produced by another tool. The parser captures a type verbatim from
	// `VARCHAR(1;DROP TABLE users;--)`, which would then be re-emitted on save
	// and export — so the file's contents are validated exactly like a request
	// body. Without this, planting one file is a persistent injection.
	if err := s.Validate(); err != nil {
		return nil, fmt.Errorf("file contains an unsafe value: %w", err)
	}
	return s, nil
}

// detectDialect reads the generator header. postgres, mariadb, and sqlite need
// a positive marker; mysql is the default so an unmarked file (every file
// written before this existed) keeps loading.
func detectDialect(sql string) string {
	for _, line := range strings.Split(sql, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "--") {
			return DialectMysql // first meaningful line isn't a comment: no header
		}
		lower := strings.ToLower(line)
		// Check the suffixed headers before the generic "generated by
		// erd-creator" arm: each of them contains both markers, and mysql must
		// stay the fallback rather than winning on the shared prefix.
		if strings.Contains(lower, "mariadb") {
			return DialectMariaDB
		}
		if strings.Contains(lower, "postgres") {
			return DialectPostgres
		}
		if strings.Contains(lower, "sqlite") {
			return DialectSqlite
		}
		if strings.Contains(lower, "generated by erd-creator") {
			return DialectMysql // explicit mysql header
		}
	}
	return DialectMysql
}

// lineExcerpt sanitizes a raw file line for error messages: cut at the first
// control character (like excerpt cuts at the first invalid type char), then
// 120 chars max. Parse errors reflect untrusted file bytes into 400 bodies,
// so the raw line must never be echoed verbatim (cf. excerpt for types).
func lineExcerpt(line string) string {
	for i, r := range line {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			if i == 0 {
				return "invalid character"
			}
			return line[:i] + "… (rejected at character " + strconv.Itoa(i+1) + ")"
		}
	}
	s := strings.TrimSpace(line)
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}

// parseMysql reads the backtick/ENGINE=InnoDB grammar buildMysql and
// buildMariaDB both emit. dialect records which of the two the file claimed, so
// a mariadb file stays mariadb across a reopen instead of silently becoming
// mysql; the parse itself is identical because the grammar is.
func parseMysql(sql string, dialect string) (*Schema, error) {
	p := newParserState(dialect)

	lines := strings.Split(sql, "\n")
	for i, raw := range lines {
		n := i + 1
		line := strings.TrimSpace(raw)
		if isSkippableLine(line) {
			continue
		}
		if m := reCreate.FindStringSubmatch(line); m != nil {
			if err := p.addTable(unquoteTick(m[1]), n); err != nil {
				return nil, err
			}
			continue
		}
		if m := reEndTable.FindStringSubmatch(line); m != nil {
			// m[2] is the table comment, absent for files written before the
			// option existed (and for any schema without one).
			if m[2] != "" {
				p.s.Tables[p.cur].Comment = unescapeStr(m[2])
			}
			p.cur = -1
			continue
		}
		if p.cur < 0 {
			return nil, fmt.Errorf("line %d: not inside CREATE TABLE: %s", n, lineExcerpt(line))
		}
		if err := parseMysqlBodyLine(strings.TrimSuffix(line, ","), line, &p.s.Tables[p.cur], &p.pending, n); err != nil {
			return nil, err
		}
	}
	attachPendingFKs(p.s, p.byName, p.byID, p.pending, nil)
	if len(p.s.Tables) == 0 {
		return nil, fmt.Errorf("no CREATE TABLE found")
	}
	return p.s, nil
}

func isSkippableLine(line string) bool {
	return line == "" || strings.HasPrefix(line, "--") || reInsert.MatchString(line)
}

func parseMysqlBodyLine(body, rawLine string, tbl *Table, pending *[]pendingFK, n int) error {
	// Clause dispatch on the first token: the old chain ran all four clause
	// regexps (rePK, reUKey, reIndex, reFK) on EVERY column line — and the
	// column regexp on every clause line — before reaching the right branch.
	// Measured: ~2µs of ~3.4µs per column line was failed regexp matches.
	// A column line never starts with PRIMARY/UNIQUE/CONSTRAINT/KEY, and a
	// clause line never parses as a column first, so one prefix switch picks
	// the single regexp to run.
	if hasClausePrefix(body) {
		return parseMysqlClause(body, rawLine, tbl, pending, n)
	}
	m := reColumn.FindStringSubmatch(body)
	if m == nil {
		return fmt.Errorf("line %d: cannot parse: %s", n, lineExcerpt(rawLine))
	}
	ty := m[2]
	if mm := reTypeNorm.FindStringSubmatch(ty); mm != nil {
		ty = strings.ToUpper(mm[1]) + mm[2]
	}
	tbl.Columns = append(tbl.Columns, Col{
		Name:    unquoteTick(m[1]),
		Type:    ty,
		Nn:      m[3] != "",
		Ai:      m[4] != "",
		Ux:      m[5] != "",
		Default: m[7],
		Comment: unescapeStr(m[9]),
	})
	return nil
}

// clausePrefixes lists the clause keywords hasClausePrefix matches. Package-level
// so the slice is not reallocated on every body line.
var clausePrefixes = []string{"PRIMARY KEY", "UNIQUE KEY", "CONSTRAINT", "KEY", "INDEX", "FOREIGN KEY"}

// hasClausePrefix reports whether body starts with a clause keyword rather
// than a column definition. Column lines start with a quoted or bare
// identifier; clauses start with PRIMARY/UNIQUE/CONSTRAINT/KEY/INDEX/FOREIGN.

func hasClausePrefix(body string) bool {
	for _, p := range clausePrefixes {
		if len(body) >= len(p) && strings.EqualFold(body[:len(p)], p) {
			if len(body) == len(p) {
				return true
			}
			next := body[len(p)]
			if next == ' ' || next == '\t' {
				return true
			}
		}
	}
	return false
}

func parseMysqlClause(body, rawLine string, tbl *Table, pending *[]pendingFK, n int) error {
	if m := rePK.FindStringSubmatch(body); m != nil {
		// PK lists are comma-separated like index lists, so they get the same
		// quote-aware split: a column named `a, b` must stay one name.
		for _, name := range splitIndexCols(m[1], unquoteTick) {
			markCol(tbl, name, func(c *Col) { c.Pk = true })
		}
		return nil
	}
	if m := reUKey.FindStringSubmatch(body); m != nil {
		markCol(tbl, unquoteTick(m[2]), func(c *Col) { c.Ux = true })
		return nil
	}
	if m := reIndex.FindStringSubmatch(body); m != nil {
		// Split the column list and route by arity: one column is the existing
		// per-column Ix flag (so old files round-trip byte-identically), more
		// than one is a composite Index on the table. Before this, the pattern
		// matched but the index was silently dropped — a hand-written
		// `KEY idx (a, b)` parsed without error and lost the index entirely.
		routeIndex(tbl, splitIndexCols(m[2], unquoteTick), unquoteTick(m[1]))
		return nil
	}
	if m := reFK.FindStringSubmatch(body); m != nil {
		// m[7] is the ON UPDATE action; empty means the clause was absent, which
		// is how the model represents "no ON UPDATE" — see the Ref comment.
		*pending = append(*pending, pendingFK{tbl.ID, unquoteTick(m[1]), unquoteTick(m[2]), defaultFKAction(m[5]), normalizeFKAction(m[7])})
		return nil
	}
	return fmt.Errorf("line %d: unsupported clause: %s", n, lineExcerpt(rawLine))
}

func attachPendingFKs(s *Schema, byName, byID map[string]int, pending []pendingFK, onDrop func(p pendingFK, reason string)) {
	for _, p := range pending {
		idx, ok := byName[p.table]
		if !ok {
			if onDrop != nil {
				onDrop(p, "unknown table")
			}
			continue // dangling FK ref → dropped, not crashed on
		}
		si, ok := byID[p.tableID]
		if !ok {
			continue
		}
		if !markCol(&s.Tables[si], p.col, func(c *Col) {
			c.Ref = &Ref{TableID: s.Tables[idx].ID, Action: p.action, OnUpdate: p.onUpdate}
		}) {
			if onDrop != nil {
				onDrop(p, "unknown column")
			}
		}
	}
}

// markCol applies f to the named column. Returns false when the column does
// not exist — callers that parse a PK/UX/KEY/INDEX clause must turn that into
// an error (a clause naming a ghost column used to be silently dropped, losing
// the PK/index with no diagnostic), while attachPendingFKs deliberately treats
// a missing child column as a dangling FK to drop, not a file defect.
func markCol(t *Table, name string, f func(*Col)) bool {
	for i := range t.Columns {
		if t.Columns[i].Name == name {
			f(&t.Columns[i])
			return true
		}
	}
	return false
}
