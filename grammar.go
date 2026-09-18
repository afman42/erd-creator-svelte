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
	"strings"
)

// ---- model ----

// Ref has no JSON tags: on the wire the browser sends {"tableId","action"}.
type Ref struct {
	TableId string `json:"tableId"`
	Action  string `json:"action"`
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
	Ref     *Ref   `json:"ref"`
}

// Id is the wire key the browser uses for ref.tableId; on open the client
// re-allocates ids in its own namespace (adoptIds). X/Y are client-only.
type Table struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	X       int    `json:"-"`
	Y       int    `json:"-"`
	Columns []Col  `json:"columns"`
}

type Schema struct {
	// Dialect is the DDL flavor this schema is stored as. Empty means mysql, so
	// files written before dialects existed keep loading unchanged.
	Dialect string  `json:"dialect,omitempty"`
	Tables  []Table `json:"tables"`
}

// Dialect names. mariadb shares the mysql grammar (byte-identical DDL, only the
// header comment differs); sqlite is export-only and has no parser.
const (
	DialectMysql    = "mysql"
	DialectMariaDB  = "mariadb"
	DialectPostgres = "postgres"
	DialectSqlite   = "sqlite"
)

// normalizeDialect maps accepted spellings onto a canonical name, defaulting to
// mysql. The empty string falls back because an unset dialect is the common case
// (every file written before this field existed).
//
// Real dialects are listed explicitly rather than left to the default. Relying
// on the fallthrough silently rewrote them as mysql, which is how a sqlite
// schema passed the save guard and would have been written with a MySQL header.
// mariadb is likewise its own name, not a spelling of mysql: it shares the
// grammar but a mariadb schema must keep that identity on save.
func normalizeDialect(d string) string {
	switch strings.ToLower(strings.TrimSpace(d)) {
	case "postgres", "postgresql", "pg":
		return DialectPostgres
	case "mariadb", "maria":
		return DialectMariaDB
	case DialectSqlite:
		return DialectSqlite
	case DialectMysql:
		return DialectMysql
	default:
		return DialectMysql // unset or unrecognized: treat as the default
	}
}

// dialect is the normalized save/parse dialect for this schema.
func (s *Schema) dialect() string { return normalizeDialect(s.Dialect) }

// saveable reports whether a schema's dialect can be written to a .sql file.
// mysql, mariadb and postgres all have parsers, so their files reopen. sqlite
// is export-only: it has no parser, so saving it would produce a file that
// fails to load — silent data loss, hence the guard.
func (s *Schema) saveable() bool {
	switch s.dialect() {
	case DialectMysql, DialectMariaDB, DialectPostgres:
		return true
	}
	return false
}

// Lint: FK base-type vs referenced PK base-type mismatch; FK onto composite PK.
func (s *Schema) Lint() []string {
	var out []string
	for _, t := range s.Tables {
		for _, c := range t.Columns {
			if c.Ref == nil {
				continue
			}
			p := findTable(s.Tables, c.Ref.TableId)
			if p == nil {
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
			if baseOf(pk.Type) != baseOf(c.Type) {
				out = append(out, fmt.Sprintf("%s.%s %s vs %s.%s %s", t.Name, c.Name, baseOf(c.Type), p.Name, pk.Name, baseOf(pk.Type)))
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
func (s *Schema) GenSQL() string {
	switch s.dialect() {
	case DialectPostgres:
		return buildPostgres(s.Tables)
	case DialectMariaDB:
		return buildMariaDB(s.Tables)
	default:
		return buildMysql(s.Tables, "-- Generated by erd-creator")
	}
}

// ---- seed INSERT templates ----

func (s *Schema) GenInserts() string {
	out := []string{"-- Seed row templates (edit values, remove per table as needed)"}
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
				vals[i] = "NOW()"
			case b == "JSON":
				vals[i] = "'{}'"
			default:
				vals[i] = "''"
			}
			names[i] = quoteTick(c.Name)
		}
		out = append(out, "INSERT INTO "+quoteTick(t.Name)+" ("+strings.Join(names, ", ")+") VALUES ("+strings.Join(vals, ", ")+");")
	}
	return strings.Join(out, "\n") + "\n"
}

// ---- parse: reads only GenSQL output ----

var (
	reInsert   = regexp.MustCompile(`(?i)^INSERT INTO `)
	reCreate   = regexp.MustCompile(`(?i)^CREATE TABLE (\S+) \($`)
	reEndTable = regexp.MustCompile(`(?i)^\) ENGINE=InnoDB;?$`)
	rePK       = regexp.MustCompile(`(?i)^PRIMARY KEY \((.+)\)$`)
	reUKey     = regexp.MustCompile(`(?i)^UNIQUE KEY (\S+) \((.+)\)$`)
	reIndex    = regexp.MustCompile(`(?i)^(KEY|INDEX) \S+ \(.+\)$`)
	reFK       = regexp.MustCompile(`(?i)^CONSTRAINT \S+ FOREIGN KEY \((\S+)\) REFERENCES (\S+) \((\S+)\)( ON DELETE (SET NULL|SET DEFAULT|NO ACTION|RESTRICT|CASCADE))?$`)
	reColumn   = regexp.MustCompile(`(?i)^(\S+) ([A-Z]+(?:\([^)]*\))?)( NOT NULL)?( AUTO_INCREMENT)?( UNIQUE)?( COMMENT '((?:[^']|'')*)')?$`)
	reKeyword  = regexp.MustCompile(`(?i)^(PRIMARY KEY|UNIQUE KEY|CONSTRAINT|KEY|INDEX|FOREIGN KEY)\b`)
	reTypeNorm = regexp.MustCompile(`(?i)^([A-Za-z]+)(\(.*\))?$`)
)

func unquoteTick(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && strings.HasPrefix(s, "`") {
		return strings.ReplaceAll(s[1:len(s)-1], "``", "`")
	}
	return s
}

type pendingFK struct {
	tableID, col, table, action string
}

// ParseDDL rebuilds a schema from DDL this tool emitted, detecting the dialect
// from the file's header comment. Files written before dialects existed have no
// marker and parse as mysql. Any unsupported line rejects the whole file; the
// caller keeps prior state.
func ParseDDL(sql string) (*Schema, error) {
	dialect := detectDialect(sql)
	if dialect == DialectPostgres {
		return parsePostgres(sql)
	}
	// mysql and mariadb share one grammar, so they share one parser; the
	// detected name is passed in only so the schema keeps its identity.
	return parseMysql(sql, dialect)
}

// detectDialect reads the generator header. Only postgres needs a positive
// marker; mysql is the default so an unmarked file (every file written before
// this existed) keeps loading.
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
		// Check mariadb before the generic "generated by erd-creator" arm: the
		// mariadb header contains both markers, and mysql must stay the fallback
		// rather than winning on the shared prefix.
		if strings.Contains(lower, "mariadb") {
			return DialectMariaDB
		}
		if strings.Contains(lower, "postgres") {
			return DialectPostgres
		}
		if strings.Contains(lower, "generated by erd-creator") {
			return DialectMysql // explicit mysql header
		}
	}
	return DialectMysql
}

// parseMysql reads the backtick/ENGINE=InnoDB grammar buildMysql and
// buildMariaDB both emit. dialect records which of the two the file claimed, so
// a mariadb file stays mariadb across a reopen instead of silently becoming
// mysql; the parse itself is identical because the grammar is.
func parseMysql(sql string, dialect string) (*Schema, error) {
	s := &Schema{Dialect: dialect}
	byName := map[string]int{} // name → index in s.Tables
	var pending []pendingFK
	cur := -1
	tableID := 0

	lines := strings.Split(sql, "\n")
	for i, raw := range lines {
		n := i + 1
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "--") || reInsert.MatchString(line) {
			continue
		}
		if m := reCreate.FindStringSubmatch(line); m != nil {
			name := unquoteTick(m[1])
			if _, dup := byName[name]; dup {
				return nil, fmt.Errorf("line %d: duplicate table %q", n, name)
			}
			tableID++
			s.Tables = append(s.Tables, Table{Id: fmt.Sprintf("t%d", tableID), Name: name})
			byName[name] = len(s.Tables) - 1
			cur = len(s.Tables) - 1
			continue
		}
		if reEndTable.MatchString(line) {
			cur = -1
			continue
		}
		if cur < 0 {
			return nil, fmt.Errorf("line %d: not inside CREATE TABLE: %s", n, line)
		}
		body := strings.TrimSuffix(line, ",")
		tbl := &s.Tables[cur]

		if m := rePK.FindStringSubmatch(body); m != nil {
			for _, name := range strings.Split(m[1], ",") {
				markCol(tbl, unquoteTick(name), func(c *Col) { c.Pk = true })
			}
			continue
		}
		if m := reUKey.FindStringSubmatch(body); m != nil {
			markCol(tbl, unquoteTick(m[2]), func(c *Col) { c.Ux = true })
			continue
		}
		if reIndex.MatchString(body) {
			markCol(tbl, unquoteTick(body[strings.Index(body, "(")+1:strings.LastIndex(body, ")")]), func(c *Col) { c.Ix = true })
			continue
		}
		if m := reFK.FindStringSubmatch(body); m != nil {
			action := m[5]
			if action == "" {
				action = "CASCADE"
			}
			pending = append(pending, pendingFK{tbl.Id, unquoteTick(m[1]), unquoteTick(m[2]), action})
			continue
		}
		if reKeyword.MatchString(body) {
			return nil, fmt.Errorf("line %d: unsupported clause: %s", n, line)
		}
		m := reColumn.FindStringSubmatch(body)
		if m == nil {
			return nil, fmt.Errorf("line %d: cannot parse: %s", n, line)
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
			Comment: strings.ReplaceAll(m[7], "''", "'"),
		})
	}
	// attach FKs now that every table exists (parents may be defined later)
	for _, p := range pending {
		idx, ok := byName[p.table]
		if !ok {
			continue // dangling FK ref → dropped, not crashed on
		}
		for i := range s.Tables {
			if s.Tables[i].Id != p.tableID {
				continue
			}
			markCol(&s.Tables[i], p.col, func(c *Col) {
				c.Ref = &Ref{TableId: s.Tables[idx].Id, Action: p.action}
			})
		}
	}
	if len(s.Tables) == 0 {
		return nil, fmt.Errorf("no CREATE TABLE found")
	}
	return s, nil
}

func markCol(t *Table, name string, f func(*Col)) {
	for i := range t.Columns {
		if t.Columns[i].Name == name {
			f(&t.Columns[i])
		}
	}
}
