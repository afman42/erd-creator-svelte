// grammar.go — the schema model, MySQL canonical parse, and lint.
// Single source of truth: the browser sends/renders schema JSON; grammar
// decisions live in this package. The saved .sql is exactly what GenSQL emits —
// GenSQL delegates to buildMysql (export.go) so save and export share ONE
// emitter — and ParseDDL reads only that subset (same contract the old JS
// parser had).
package main

import (
	"fmt"
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

// lintFK checks one FK column: missing parent, composite PK, missing PK, type
// mismatch. Returns the diagnostic, or "" when the FK is clean.
func lintFK(t Table, c Col, byID map[string]*Table) string {
	p := byID[c.Ref.TableID]
	if p == nil {
		return fmt.Sprintf("%s.%s → table %s: missing table; FK omitted from DDL", t.Name, c.Name, c.Ref.TableID)
	}
	var pks []Col
	for _, x := range p.Columns {
		if x.Pk {
			pks = append(pks, x)
		}
	}
	switch {
	case len(pks) > 1:
		return fmt.Sprintf("%s.%s → %s has composite PK; single-col FK is invalid DDL", t.Name, c.Name, p.Name)
	case len(pks) == 0:
		// No PK → no unique column to point at, so the FK is omitted from
		// every dialect rather than silently targeting the first column
		// (invalid DDL). Report it, or the relationship just vanishes from
		// the output with no explanation.
		return fmt.Sprintf("%s.%s → %s has no PK; FK omitted from DDL", t.Name, c.Name, p.Name)
	}
	pk := pks[0]
	// Compare element types: the [] array suffix is PostgreSQL syntax that
	// changes the column to a collection of the same base type, so an
	// INT[] FK onto an INT PK is a match, not a mismatch. Without the
	// strip, every array FK onto a non-array PK flagged a false mismatch.
	fkBase, pkBase := baseOf(c.Type), baseOf(pk.Type)
	if strings.TrimSuffix(fkBase, "[]") != strings.TrimSuffix(pkBase, "[]") {
		return fmt.Sprintf("%s.%s %s vs %s.%s %s", t.Name, c.Name, fkBase, p.Name, pk.Name, pkBase)
	}
	return ""
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
			if msg := lintFK(t, c, byID); msg != "" {
				out = append(out, msg)
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
	// Unknown dialect labels must not silently become mysql: validateDialectForSave
	// is the canonical guard (files.go:saveFile uses it before storing), so the
	// save path and the export path agree instead of one normalizing.
	if err := validateDialectForSave(s.Dialect); err != nil {
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
//
// The last gate is fail-closed like GenSQL: a validateOutput trip is a bug, not
// bad input, so it comes back as an error rather than a half-checked string.
func (s *Schema) GenInserts() (string, error) {
	return s.GenInsertsFor(s.dialect())
}

// GenInsertsFor is GenInserts against a specific dialect. The quoting follows
// the target grammar (backticks for mysql/sqlite, double quotes for postgres)
// and SQLite has no NOW() function, so datetime placeholders become
// CURRENT_TIMESTAMP there; everything else — AI → NULL, BOOLEAN → FALSE,
// JSON → '{}' — is identical across dialects, since each accepts those
// literals. The mysql header text is unchanged so existing output and tests
// keep their bytes.
//
// Fail-closed: a validateOutput trip returns an error (see GenInserts) rather
// than logging and returning the unchecked text.
func (s *Schema) GenInsertsFor(dialect string) (string, error) {
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
			vals[i] = seedValue(c, now)
			names[i] = q(c.Name)
		}
		out = append(out, "INSERT INTO "+q(t.Name)+" ("+strings.Join(names, ", ")+") VALUES ("+strings.Join(vals, ", ")+");")
	}
	// Inserts carry only quoted identifiers and fixed literals, but they leave
	// through the same last gate as DDL: a future column in the template must
	// not emit unchecked. A gate failure here is a bug, not bad input, so it
	// is returned fail-closed rather than logged.
	out2 := strings.Join(out, "\n") + "\n"
	if err := validateOutput(out2); err != nil {
		return "", err
	}
	return out2, nil
}

// seedValue renders one INSERT-template placeholder for a column. AI → NULL,
// datetime uses the dialect's now-function; the rest are fixed literals both
// mysql/postgres/sqlite accept.
func seedValue(c Col, now string) string {
	if c.Ai {
		return "NULL"
	}
	switch b := baseOf(c.Type); b {
	case "DECIMAL":
		return "0.00"
	case "BOOLEAN":
		return "FALSE"
	case "DATE":
		return "'2026-01-01'"
	case "DATETIME", "TIMESTAMP":
		return now
	case "JSON":
		return "'{}'"
	default:
		if isInt(b) {
			return "0"
		}
		return "''"
	}
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

// pendingFK and the parser helpers below are the shared per-parse
// accumulator. Referental-action policy (fkActions, validateFKAction,
// normalizeFKAction, defaultFKAction) and the type model (splitType, baseOf,
// isInt, isArrayType) live in spec.go so validate, emitters, parsers, and
// import all query one implementation.
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
// Reports the ghost column name; a clause naming a column that does not exist
// must not be silently dropped.
func routeIndex(tbl *Table, cols []string, name string) (string, bool) {
	if len(cols) == 1 && !markCol(tbl, cols[0], func(c *Col) { c.Ix = true }) {
		return cols[0], false
	}
	if len(cols) > 1 {
		tbl.Indexes = append(tbl.Indexes, Index{Name: name, Cols: cols})
	}
	return "", true
}

// ParseDDL rebuilds a schema from DDL this tool emitted, detecting the dialect
// from the file's header comment. Files written before dialects existed have no
// marker and parse as mysql. Any unsupported line rejects the whole file; the
// caller keeps prior state.
//
// ParseDDLWithWarnings is the same parse with its losses surfaced: dangling FK
// refs the attach step drops, plus Lint() output for FKs that parsed but cannot
// be emitted (dangling refs, composite-PK targets). ParseDDL stays as the
// error-only wrapper so existing callers are untouched.
func ParseDDL(sql string) (*Schema, error) {
	s, _, err := ParseDDLWithWarnings(sql)
	return s, err
}

// ParseDDLWithWarnings parses strict DDL and returns (schema, warnings, error).
// Warnings are sanitized drop reports, never the model: the schema never
// carries the loss list, so a later save cannot persist warnings into the file.
func ParseDDLWithWarnings(sql string) (*Schema, []string, error) {
	dialect := detectDialect(sql)
	var (
		s        *Schema
		warnings []string
		err      error
	)
	switch dialect {
	case DialectPostgres:
		s, warnings, err = parsePostgres(sql)
	case DialectSqlite:
		s, warnings, err = parseSqlite(sql)
	default:
		// mysql and mariadb share one grammar, so they share one parser; the
		// detected name is passed in only so the schema keeps its identity.
		s, warnings, err = parseMysql(sql, dialect)
	}
	if err != nil {
		return nil, nil, err
	}
	// A .sql file is untrusted input too: it may have been hand-written, or
	// produced by another tool. The parser captures a type verbatim from
	// `VARCHAR(1;DROP TABLE users;--)`, which would then be re-emitted on save
	// and export — so the file's contents are validated exactly like a request
	// body. Without this, planting one file is a persistent injection.
	if err := s.Validate(); err != nil {
		return nil, nil, fmt.Errorf("file contains an unsafe value: %w", err)
	}
	warnings = append(warnings, s.Lint()...)
	return s, warnings, nil
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
func parseMysql(sql string, dialect string) (*Schema, []string, error) {
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
				return nil, nil, err
			}
			continue
		}
		if m := reEndTable.FindStringSubmatch(line); m != nil {
			// A stray ") ENGINE=InnoDB" outside any CREATE TABLE (p.cur is -1
			// before the first table and after each close) used to index
			// Tables[-1] and panic. Guard first, like the body path below.
			if p.cur < 0 || p.cur >= len(p.s.Tables) {
				return nil, nil, fmt.Errorf("line %d: not inside CREATE TABLE: %s", n, lineExcerpt(line))
			}
			// m[2] is the table comment, absent for files written before the
			// option existed (and for any schema without one).
			if m[2] != "" {
				p.s.Tables[p.cur].Comment = unescapeStr(m[2])
			}
			p.cur = -1
			continue
		}
		if p.cur < 0 {
			return nil, nil, fmt.Errorf("line %d: not inside CREATE TABLE: %s", n, lineExcerpt(line))
		}
		if err := parseMysqlBodyLine(strings.TrimSuffix(line, ","), line, &p.s.Tables[p.cur], &p.pending, n); err != nil {
			return nil, nil, err
		}
	}
	var warnings []string
	attachPendingFKs(p.s, p.byName, p.byID, p.pending, func(p pendingFK, reason string) {
		warnings = append(warnings, fkDropWarning(p, reason))
	})
	if len(p.s.Tables) == 0 {
		return nil, nil, fmt.Errorf("no CREATE TABLE found")
	}
	return p.s, warnings, nil
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
		if err := markPKColumns(tbl, splitIndexCols(m[1], unquoteTick), n); err != nil {
			return err
		}
		return nil
	}
	if m := reUKey.FindStringSubmatch(body); m != nil {
		if name := unquoteTick(m[2]); !markCol(tbl, name, func(c *Col) { c.Ux = true }) {
			return fmt.Errorf("line %d: unknown column %q", n, name)
		}
		return nil
	}
	if m := reIndex.FindStringSubmatch(body); m != nil {
		// Split the column list and route by arity: one column is the existing
		// per-column Ix flag (so old files round-trip byte-identically), more
		// than one is a composite Index on the table. Before this, the pattern
		// matched but the index was silently dropped — a hand-written
		// `KEY idx (a, b)` parsed without error and lost the index entirely.
		if name, ok := routeIndex(tbl, splitIndexCols(m[2], unquoteTick), unquoteTick(m[1])); !ok {
			return fmt.Errorf("line %d: unknown column %q", n, name)
		}
		return nil
	}
	if m := reFK.FindStringSubmatch(body); m != nil {
		// m[5]/m[7] are the raw ON DELETE/UPDATE actions; resolveActions
		// (spec.go) applies the DELETE default and the UPDATE omit rule.
		del, upd := resolveActions(m[5], m[7])
		*pending = append(*pending, pendingFK{tbl.ID, unquoteTick(m[1]), unquoteTick(m[2]), del, upd})
		return nil
	}
	return fmt.Errorf("line %d: unsupported clause: %s", n, lineExcerpt(rawLine))
}

func attachPendingFKs(s *Schema, byName, byID map[string]int, pending []pendingFK, onDrop func(p pendingFK, reason string)) {
	for _, p := range pending {
		idx, okTable := byName[p.table]
		si, okCol := byID[p.tableID]
		if !okTable || !okCol {
			if onDrop != nil {
				onDrop(p, "unknown table")
			}
			continue // dangling FK ref → dropped, not crashed on
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

// fkDropWarning renders one attachPendingFKs drop as a sanitized open warning.
// importExcerpt keeps planted identifiers out of the UI log verbatim; the
// strict parsers and the lenient import pass share it so the wording matches.
func fkDropWarning(p pendingFK, reason string) string {
	switch reason {
	case "unknown table":
		return fmt.Sprintf("FK %q: unknown table, dropped", importExcerpt(p.col+"→"+p.table))
	case "unknown column":
		return fmt.Sprintf("FK on unknown column %q dropped", importExcerpt(p.col))
	default:
		return fmt.Sprintf("FK %q dropped: %s", importExcerpt(p.col), importExcerpt(reason))
	}
}

// markPKColumns marks every named column as a primary key, reporting the
// first ghost column. It is the single shared PK loop for the strict parsers
// (mysql, postgres, sqlite): three copies is how the FK attach loop drifted
// before, so the split-and-mark stays in one place. The lenient import twin
// keeps its own loss-reporting loop.
func markPKColumns(tbl *Table, cols []string, n int) error {
	for _, name := range cols {
		if !markCol(tbl, name, func(c *Col) { c.Pk = true }) {
			return fmt.Errorf("line %d: unknown column %q", n, name)
		}
	}
	return nil
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
