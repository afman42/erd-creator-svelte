// grammar_sqlite.go — the SQLite parse half of the saved-file grammar.
//
// Reads back exactly what buildSqlite (export.go) emits, the same contract
// parseMysql and parsePostgres have with their emitters. SQLite needs its own
// parser because its grammar differs structurally from MySQL's, not merely in
// quoting:
//
//   - tables end with ");" — there is no ENGINE=InnoDB clause
//   - comments are "-- name: text" lines INSIDE the body, not inline COMMENT
//   - a single integer PK is an inline "INTEGER PRIMARY KEY" (the rowid alias)
//     rather than a separate PRIMARY KEY (...) clause plus AUTO_INCREMENT
//   - indexes are separate CREATE INDEX IF NOT EXISTS statements after the table
//   - ENUM becomes TEXT + an inline CHECK (col IN (...))
//
// The type mappings are one-way and mostly NOT inverted. SQLite has no BOOLEAN
// or datetime type, so buildSqlite writes INTEGER and TEXT; those are valid
// model types, so the schema stays emittable in every dialect and re-emitting is
// stable. This mirrors the postgres parser, which deliberately leaves TINYINT
// and DATETIME alone for the same reason.
//
// ENUM is the exception: it IS recovered exactly, because the CHECK constraint
// carries the values and silently dropping them would change the schema.
package main

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	reSqliteCreate      = regexp.MustCompile(`(?i)^CREATE TABLE (\S+) \($`)
	reSqliteEnd         = regexp.MustCompile(`^\);$`)
	reSqliteCommentLine = regexp.MustCompile(`^-- (.*)$`)
	reSqliteRowidPk     = regexp.MustCompile(`(?i)^(\S+) INTEGER PRIMARY KEY$`)
	reSqlitePK          = regexp.MustCompile(`(?i)^PRIMARY KEY \((.+)\)$`)
	reSqliteFK          = regexp.MustCompile(`(?i)^FOREIGN KEY \((\S+)\) REFERENCES (\S+) \((\S+)\) ON DELETE (.+)$`)
	reSqliteIndex       = regexp.MustCompile(`(?i)^CREATE INDEX IF NOT EXISTS \S+ ON (\S+) \((\S+)\);$`)
	reSqliteCol         = regexp.MustCompile(`(?i)^(\S+) ([A-Z]+(?:\([^)]*\))?)( NOT NULL)?( UNIQUE)?$`)
	reSqliteEnumChk     = regexp.MustCompile(`(?i)^CHECK \(.*? IN \((.*)\)\)$`)
)

// sqliteEnumLiteral rebuilds the model's ENUM('a','b') literal from the
// parenthesised value list of a CHECK constraint. The values are SQL string
// literals, so ” unescapes to ' before the model re-quotes them.
func sqliteEnumLiteral(list string) string {
	parts := splitTop(list)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if len(p) >= 2 && p[0] == '\'' && p[len(p)-1] == '\'' {
			p = p[1 : len(p)-1]
		}
		out = append(out, sqlStr(strings.ReplaceAll(p, "''", "'")))
	}
	return strings.Join(out, ",")
}

// stripCommentName removes the "name: " prefix buildSqlite writes ahead of a
// comment. The prefix cannot be matched positionally, because a column name may
// itself contain ": " ("-- a:b: x" is the comment "x" on column "a:b"). So the
// whole line is kept and the prefix is stripped once the column name is known.
func stripCommentName(line, colName string) string {
	prefix := colName + ": "
	if strings.HasPrefix(line, prefix) {
		return line[len(prefix):]
	}
	return line
}

// sqliteTypesFromHeader recovers the type-rendering mode buildSqlite recorded
// in the header. Only the non-default (portable) mode is written, so a header
// without the marker means native — which is also what every file written before
// the setting existed means.
func sqliteTypesFromHeader(sql string) string {
	for _, line := range strings.Split(sql, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "--") {
			break // past the header block
		}
		if strings.Contains(strings.ToLower(line), "types: "+SqliteTypesPortable) {
			return SqliteTypesPortable
		}
	}
	return SqliteTypesNative
}

// parseSqlite reads the grammar buildSqlite emits.
func parseSqlite(sql string) (*Schema, error) {
	s := &Schema{Dialect: DialectSqlite, SqliteTypes: sqliteTypesFromHeader(sql)}
	byName := map[string]int{} // name → index in s.Tables
	byId := map[string]int{}   // id → index, O(1) for pending FK attachment
	var pending []pendingFK
	cur := -1
	tableID := 0
	commentLine := "" // "-- ..." text awaiting the column it documents

	lines := strings.Split(sql, "\n")
	for i, raw := range lines {
		n := i + 1
		line := strings.TrimSpace(raw)
		if line == "" || reInsert.MatchString(line) {
			continue
		}
		if m := reSqliteCreate.FindStringSubmatch(line); m != nil {
			name := unquoteTick(m[1])
			if _, dup := byName[name]; dup {
				return nil, fmt.Errorf("line %d: duplicate table %q", n, name)
			}
			tableID++
			id := fmt.Sprintf("t%d", tableID)
			s.Tables = append(s.Tables, Table{Id: id, Name: name})
			byName[name] = len(s.Tables) - 1
			byId[id] = len(s.Tables) - 1
			cur = len(s.Tables) - 1
			commentLine = ""
			continue
		}
		if reSqliteEnd.MatchString(line) {
			cur = -1
			commentLine = ""
			continue
		}
		// index statements are emitted after the table body, so they are read
		// while cur is -1 and must be handled before the inside-a-table guard
		if m := reSqliteIndex.FindStringSubmatch(line); m != nil {
			if idx, ok := byName[unquoteTick(m[1])]; ok {
				markCol(&s.Tables[idx], unquoteTick(m[2]), func(c *Col) { c.Ix = true })
			}
			continue
		}
		// comments: the header before the first table is skipped; inside a body
		// the text is held until the column definition it documents arrives
		if strings.HasPrefix(line, "--") {
			if cur >= 0 {
				if m := reSqliteCommentLine.FindStringSubmatch(line); m != nil {
					commentLine = m[1]
				}
			}
			continue
		}
		if cur < 0 {
			return nil, fmt.Errorf("line %d: not inside CREATE TABLE: %s", n, line)
		}
		body := strings.TrimSuffix(line, ",")
		tbl := &s.Tables[cur]

		if m := reSqlitePK.FindStringSubmatch(body); m != nil {
			for _, name := range strings.Split(m[1], ",") {
				markCol(tbl, unquoteTick(name), func(c *Col) { c.Pk = true })
			}
			commentLine = ""
			continue
		}
		if m := reSqliteFK.FindStringSubmatch(body); m != nil {
			pending = append(pending, pendingFK{tbl.Id, unquoteTick(m[1]), unquoteTick(m[2]), m[4]})
			commentLine = ""
			continue
		}

		// A column definition. Split off an inline CHECK first: it contains
		// parentheses that would otherwise be read as part of the type.
		check := ""
		if j := strings.Index(body, " CHECK ("); j >= 0 {
			check = body[j+1:]
			body = strings.TrimSpace(body[:j])
		}
		if m := reSqliteRowidPk.FindStringSubmatch(body); m != nil {
			name := unquoteTick(m[1])
			tbl.Columns = append(tbl.Columns, Col{
				Name: name, Type: "INT", Pk: true, Ai: true, Nn: true,
				Comment: stripCommentName(commentLine, name),
			})
			commentLine = ""
			continue
		}
		m := reSqliteCol.FindStringSubmatch(body)
		if m == nil {
			return nil, fmt.Errorf("line %d: cannot parse: %s", n, line)
		}
		name := unquoteTick(m[1])
		ty := m[2]
		if check != "" {
			if em := reSqliteEnumChk.FindStringSubmatch(check); em != nil {
				ty = "ENUM(" + sqliteEnumLiteral(em[1]) + ")"
			}
		}
		tbl.Columns = append(tbl.Columns, Col{
			Name:    name,
			Type:    ty,
			Nn:      m[3] != "",
			Ux:      m[4] != "",
			Comment: stripCommentName(commentLine, name),
		})
		commentLine = ""
	}
	// attach FKs now that every table exists (parents may be defined later)
	for _, p := range pending {
		idx, ok := byName[p.table]
		if !ok {
			continue // dangling FK ref → dropped, not crashed on
		}
		si, ok := byId[p.tableID]
		if !ok {
			continue
		}
		markCol(&s.Tables[si], p.col, func(c *Col) {
			c.Ref = &Ref{TableId: s.Tables[idx].Id, Action: p.action}
		})
	}
	if len(s.Tables) == 0 {
		return nil, fmt.Errorf("no CREATE TABLE found")
	}
	return s, nil
}
