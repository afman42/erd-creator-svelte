// import.go — best-effort import of foreign .sql files.
//
// ParseDDL reads only DDL this tool emitted; anything else is a 400 and the
// canvas keeps prior state. That is correct for round-trip fidelity but means a
// mysqldump/pg_dump/SQLite file cannot be opened at all. ParseImport is the
// fallback openFile uses: strict first (own files take the zero-loss path, so
// the golden tests cannot move), then one generic lenient pass that recovers
// tables/columns/FKs/indexes and reports everything it could not carry as
// warnings. Warnings ride the open response only — never the model, never disk.
//
// The lenient pass is a single dialect-agnostic parser, not three lenient
// parsers: three copies is how the FK attach loop drifted before (two parsers
// silently dropped a new Ref field). One implementation, so a construct added
// here reaches every file.
package main

import (
	"fmt"
	"regexp"
	"strings"
)

const maxImportWarnings = 50

var (
	reImpCreate  = regexp.MustCompile(`(?i)^CREATE TABLE (?:IF NOT EXISTS )?(.+?)\s*\($`)
	reImpIndex   = regexp.MustCompile(`(?i)^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?\S+ ON (.+?)\s*\((.+)\)\s*;?$`)
	reImpAlterFK = regexp.MustCompile(`(?i)^ALTER TABLE (?:ONLY )?(\S+)(?:\s+\S+)*\s+ADD (?:CONSTRAINT \S+ )?FOREIGN KEY\s*\((.+)\)\s*REFERENCES\s*(\S+)\s*\((.+)\)(.*)$`)
	reImpPgCol   = regexp.MustCompile(`(?i)^COMMENT ON COLUMN (\S+)\.(\S+) IS '(.*)';?$`)
	reImpFK      = regexp.MustCompile(`(?i)^(?:CONSTRAINT \S+ )?FOREIGN KEY\s*\((.+)\)\s*REFERENCES\s*(\S+)\s*\((.+)\)(.*)$`)
	reImpInline  = regexp.MustCompile(`(?i)\bREFERENCES\s*(\S+)\s*\((.+?)\)(.*)$`)
	reImpAction  = regexp.MustCompile(`(?i)\bON (DELETE|UPDATE) (SET NULL|SET DEFAULT|NO ACTION|RESTRICT|CASCADE)`)
	reImpComment = regexp.MustCompile(`(?i)\bCOMMENT\s+'((?:[^']|'')*)'`)
	reImpPK      = regexp.MustCompile(`(?i)PRIMARY KEY\s*\((.+)\)`)
	reImpUKey    = regexp.MustCompile(`(?i)UNIQUE\b.*\((.+)\)`)
	reImpKey     = regexp.MustCompile(`(?i)^(?:KEY|INDEX)\s+\S+\s*\((.+)\)`)
)

// importLoss caps and sanitizes the skip list: excerpts never carry control
// characters and stop at 80 chars, so a planted line cannot ride a warning
// into the UI log verbatim. Past the cap the count is kept, not the text.
type importLoss struct {
	msgs    []string
	dropped int
}

func (l *importLoss) add(format string, args ...any) {
	if len(l.msgs) >= maxImportWarnings {
		l.dropped++
		return
	}
	l.msgs = append(l.msgs, fmt.Sprintf(format, args...))
}

func (l *importLoss) result() []string {
	if l.dropped > 0 {
		l.msgs = append(l.msgs, fmt.Sprintf("+%d more skipped", l.dropped))
	}
	return l.msgs
}

// importExcerpt is excerpt() for whole lines: no controls, 80 chars max.
func importExcerpt(line string) string {
	var b strings.Builder
	for _, r := range line {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			continue
		}
		b.WriteRune(r)
	}
	s := strings.TrimSpace(b.String())
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}

// impName strips quoting, schema prefixes and escapes to a bare identifier:
// `"public"."users"` → users, `[users]` → users, “ `a“b` “ → a`b.
func impName(tok string) string {
	tok = strings.TrimSpace(tok)
	if i := strings.LastIndex(tok, "."); i >= 0 {
		tok = strings.TrimSpace(tok[i+1:])
	}
	if len(tok) >= 2 {
		if (tok[0] == '"' && tok[len(tok)-1] == '"') || (tok[0] == '`' && tok[len(tok)-1] == '`') {
			q := tok[0:1]
			inner := tok[1 : len(tok)-1]
			return strings.ReplaceAll(inner, q+q, q)
		}
		if tok[0] == '[' && tok[len(tok)-1] == ']' {
			return tok[1 : len(tok)-1]
		}
	}
	return strings.Trim(tok, `"'`+"`")
}

// impSplitList splits a parenthesised column list, quote-aware via splitTop.
func impSplitList(list string) []string {
	var out []string
	for _, p := range splitTop(list) {
		if n := impName(strings.TrimSpace(p)); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// impBaseType maps common foreign spellings onto the model's portable names.
// Unmapped names pass through uppercased; the caller validates and falls back
// to TEXT with a loss when the result is not a valid type expression.
func impBaseType(base string) (string, bool) {
	norm := strings.Join(strings.Fields(strings.ToUpper(base)), " ")
	switch norm {
	case "SERIAL", "SMALLSERIAL":
		return "SMALLINT", true
	case "BIGSERIAL":
		return "BIGINT", true
	case "INTEGER", "INT4", "INT8":
		return "INT", false
	case "CHARACTER VARYING", "VARCHAR2":
		return "VARCHAR", false
	case "CHARACTER", "CHAR VARYING":
		return "CHAR", false
	case "DOUBLE PRECISION":
		return "DOUBLE", false
	case "TIMESTAMP WITHOUT TIME ZONE", "TIMESTAMP WITH TIME ZONE",
		"TIME WITHOUT TIME ZONE", "TIME WITH TIME ZONE":
		return strings.Split(norm, " ")[0], false
	case "BOOL":
		return "BOOLEAN", false
	}
	return norm, false
}

// impStopWords end a column's type: everything from here on is a constraint.
var impStopWords = map[string]bool{
	"NOT": true, "NULL": true, "PRIMARY": true, "UNIQUE": true,
	"REFERENCES": true, "DEFAULT": true, "CHECK": true, "COLLATE": true,
	"COMMENT": true, "GENERATED": true, "AS": true, "IDENTITY": true,
	"AUTO_INCREMENT": true, "AUTOINCREMENT": true, "CONSTRAINT": true,
	"KEY": true, "FOREIGN": true, "ON": true,
}

// impColName cuts the leading identifier off a body line, quote-aware.
func impColName(body string) (string, string) {
	body = strings.TrimSpace(body)
	if body == "" {
		return "", ""
	}
	switch body[0] {
	case '"', '`':
		q := body[0]
		for i := 1; i < len(body); i++ {
			if body[i] == q {
				if i+1 < len(body) && body[i+1] == q {
					i++
					continue
				}
				return impName(body[:i+1]), strings.TrimSpace(body[i+1:])
			}
		}
		return "", body
	case '[':
		if i := strings.IndexByte(body, ']'); i >= 0 {
			return impName(body[:i+1]), strings.TrimSpace(body[i+1:])
		}
		return "", body
	default:
		if i := strings.IndexAny(body, " \t("); i >= 0 {
			if body[i] == '(' {
				return body[:i], strings.TrimSpace(body[i:])
			}
			return body[:i], strings.TrimSpace(body[i:])
		}
		return body, ""
	}
}

// ParseImport parses foreign DDL best-effort: (schema, warnings, error).
// Strict ParseDDL runs first so own files never take the lossy path; zero
// tables or an unsafe result is still an error and the caller keeps prior state.
func ParseImport(sql string) (*Schema, []string, error) {
	if s, err := ParseDDL(sql); err == nil {
		return s, nil, nil
	}
	s, warnings, err := impParse(sql)
	if err != nil {
		return nil, nil, err
	}
	if len(s.Tables) == 0 {
		return nil, nil, fmt.Errorf("no CREATE TABLE found")
	}
	if err := s.Validate(); err != nil {
		return nil, nil, fmt.Errorf("file contains an unsafe value: %w", err)
	}
	return s, warnings, nil
}

// impNoise are dump directives with no model meaning: SET/USE/LOCK, DROP,
// grants. INSERT/SELECT rows are data, skipped the same way.
func impNoise(upper string) bool {
	for _, p := range []string{"SET ", "USE ", "LOCK ", "UNLOCK ", "START ", "BEGIN", "COMMIT",
		"DROP TABLE", "DROP INDEX", "TABLESPACE", "OWNER TO", "GRANT ", "REVOKE ",
		"INSERT ", "SELECT ", "VACUUM", "ANALYZE ", "PRAGMA "} {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return false
}

func impParse(sql string) (*Schema, []string, error) {
	var loss importLoss
	s := &Schema{Dialect: DialectMysql}
	byName := map[string]int{}
	byID := map[string]int{}
	var pending []pendingFK
	cur := -1
	tableID := 0
	sawPg, sawLite := false, false

	for i, raw := range strings.Split(sql, "\n") {
		n := i + 1
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "--") || strings.HasPrefix(line, "/*") || strings.HasPrefix(line, "*/") {
			continue
		}
		upper := strings.ToUpper(line)
		if impNoise(upper) {
			continue
		}
		if m := reImpCreate.FindStringSubmatch(line); m != nil {
			name := impName(m[1])
			if _, dup := byName[name]; dup {
				loss.add("line %d: duplicate table %q skipped", n, name)
				cur = -1
				continue
			}
			tableID++
			id := fmt.Sprintf("t%d", tableID)
			s.Tables = append(s.Tables, Table{ID: id, Name: name})
			byName[name] = len(s.Tables) - 1
			byID[id] = len(s.Tables) - 1
			cur = len(s.Tables) - 1
			continue
		}
		if m := reImpIndex.FindStringSubmatch(line); m != nil {
			tname := impName(m[2])
			idx, ok := byName[tname]
			if !ok {
				loss.add("line %d: index on unknown table %q skipped", n, importExcerpt(tname))
				continue
			}
			cols := impSplitList(m[3])
			switch {
			case len(cols) == 0:
				loss.add("line %d: empty index skipped", n)
			case len(cols) == 1 && strings.TrimSpace(m[1]) != "":
				markCol(&s.Tables[idx], cols[0], func(c *Col) { c.Ux = true })
			case len(cols) == 1:
				markCol(&s.Tables[idx], cols[0], func(c *Col) { c.Ix = true })
			default:
				s.Tables[idx].Indexes = append(s.Tables[idx].Indexes, Index{Cols: cols})
			}
			continue
		}
		if m := reImpPgCol.FindStringSubmatch(line); m != nil {
			if idx, ok := byName[impName(m[1])]; ok {
				tbl := &s.Tables[idx]
				name := impName(m[2])
				comment := unescapeStr(m[3])
				if !markCol(tbl, name, func(c *Col) { c.Comment = comment }) {
					loss.add("line %d: comment on unknown column %q skipped", n, importExcerpt(name))
				}
			}
			// Unknown table: a comment without its table (out-of-order dump).
			continue
		}
		if m := reImpAlterFK.FindStringSubmatch(line); m != nil {
			si, ok := byName[impName(m[1])]
			if !ok {
				loss.add("line %d: ALTER on unknown table skipped", n)
				continue
			}
			cols := impSplitList(m[2])
			if len(cols) != 1 {
				loss.add("line %d: composite ALTER FK skipped", n)
				continue
			}
			del, upd := impActions(m[5])
			pending = append(pending, pendingFK{s.Tables[si].ID, cols[0], impName(m[3]), del, upd})
			continue
		}
		if cur < 0 {
			if strings.HasPrefix(line, ")") || strings.HasPrefix(upper, "ENGINE") || line == ";" {
				continue
			}
			loss.add("line %d: skipped %q", n, importExcerpt(line))
			continue
		}
		// Inside a table body.
		if strings.HasPrefix(line, ")") {
			cur = -1
			continue
		}
		body := strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(line, ","), ";"))
		if body == "" {
			continue
		}
		tbl := &s.Tables[cur]
		// PRIMARY KEY clause (optional CONSTRAINT prefix).
		if up := strings.ToUpper(body); strings.Contains(up, "PRIMARY KEY") &&
			(strings.HasPrefix(up, "PRIMARY") || strings.HasPrefix(up, "CONSTRAINT")) {
			if m := reImpPK.FindStringSubmatch(body); m != nil {
				for _, name := range impSplitList(m[1]) {
					if !markCol(tbl, name, func(c *Col) { c.Pk = true }) {
						loss.add("line %d: PK on unknown column %q skipped", n, importExcerpt(name))
					}
				}
			} else {
				loss.add("line %d: skipped %q", n, importExcerpt(line))
			}
			continue
		}
		// FOREIGN KEY clause (bare or CONSTRAINT-prefixed).
		if m := reImpFK.FindStringSubmatch(body); m != nil {
			cols := impSplitList(m[1])
			if len(cols) != 1 {
				loss.add("line %d: composite FK skipped", n)
				continue
			}
			del, upd := impActions(m[4])
			pending = append(pending, pendingFK{tbl.ID, cols[0], impName(m[2]), del, upd})
			continue
		}
		// UNIQUE clause: UNIQUE [KEY|INDEX] [name] (cols).
		if up := strings.ToUpper(body); strings.HasPrefix(up, "UNIQUE") || strings.HasPrefix(up, "CONSTRAINT") {
			if m := reImpUKey.FindStringSubmatch(body); m != nil {
				cols := impSplitList(m[1])
				switch len(cols) {
				case 0:
					loss.add("line %d: empty UNIQUE skipped", n)
				case 1:
					markCol(tbl, cols[0], func(c *Col) { c.Ux = true })
				default:
					tbl.Indexes = append(tbl.Indexes, Index{Cols: cols})
				}
				continue
			}
			if strings.Contains(up, "CHECK") {
				loss.add("line %d: CHECK constraint skipped", n)
				continue
			}
			loss.add("line %d: skipped %q", n, importExcerpt(line))
			continue
		}
		if up := strings.ToUpper(body); strings.HasPrefix(up, "KEY ") || strings.HasPrefix(up, "INDEX ") || strings.HasPrefix(up, "CHECK") {
			if strings.HasPrefix(up, "CHECK") {
				loss.add("line %d: CHECK constraint skipped", n)
				continue
			}
			if m := reImpKey.FindStringSubmatch(body); m != nil {
				cols := impSplitList(m[1])
				if len(cols) == 1 {
					markCol(tbl, cols[0], func(c *Col) { c.Ix = true })
				} else if len(cols) > 1 {
					tbl.Indexes = append(tbl.Indexes, Index{Cols: cols})
				}
			} else {
				loss.add("line %d: skipped %q", n, importExcerpt(line))
			}
			continue
		}
		// Column definition.
		name, rest := impColName(body)
		if name == "" || rest == "" {
			loss.add("line %d: skipped %q", n, importExcerpt(line))
			continue
		}
		dup := false
		for _, c := range tbl.Columns {
			if c.Name == name {
				dup = true
				break
			}
		}
		if dup {
			loss.add("line %d: duplicate column %q skipped", n, importExcerpt(name))
			continue
		}
		typ, after, isAI, pg, lite := impColType(rest)
		sawPg, sawLite = sawPg || pg, sawLite || lite
		if !isValidTypeExpr(typ) {
			loss.add("line %d: type of %q not carried, kept as TEXT", n, importExcerpt(name))
			typ = "TEXT"
		}
		aup := " " + strings.ToUpper(after) + " "
		col := Col{
			Name: name, Type: typ,
			Nn: strings.Contains(aup, " NOT NULL "),
			Ux: strings.Contains(aup, " UNIQUE "),
			Ai: isAI || strings.Contains(aup, " AUTO_INCREMENT ") || strings.Contains(aup, " AUTOINCREMENT ") ||
				strings.Contains(aup, " IDENTITY ") || strings.Contains(aup, " GENERATED "),
		}
		if strings.Contains(aup, " PRIMARY KEY ") {
			col.Pk = true
			col.Nn = true
		}
		if m := reImpComment.FindStringSubmatch(after); m != nil {
			col.Comment = unescapeStr(m[1])
		}
		if m := reImpInline.FindStringSubmatch(after); m != nil {
			del, upd := impActions(m[3])
			pending = append(pending, pendingFK{tbl.ID, name, impName(m[1]), del, upd})
		}
		tbl.Columns = append(tbl.Columns, col)
	}
	// Attach FKs with losses (the shared helper drops silently — right for
	// strict parse, wrong for an import report — so the callback reports).
	attachPendingFKs(s, byName, byID, pending, func(p pendingFK, reason string) {
		switch reason {
		case "unknown table":
			loss.add("FK %q: unknown table, dropped", importExcerpt(p.col+"→"+p.table))
		case "unknown column":
			loss.add("FK on unknown column %q dropped", importExcerpt(p.col))
		}
	})
	if len(s.Tables) == 0 {
		return nil, nil, fmt.Errorf("no CREATE TABLE found")
	}
	// Header wins; otherwise the content votes (pg SERIAL/identity cues).
	if detectDialect(sql) != DialectMysql || (!sawPg && !sawLite) {
		s.Dialect = detectDialect(sql)
	} else if sawPg {
		s.Dialect = DialectPostgres
	} else {
		s.Dialect = DialectSqlite
	}
	return s, loss.result(), nil
}

// impActions reads ON DELETE/UPDATE trailing a REFERENCES clause.
// DELETE keeps the model's historical CASCADE default; UPDATE omits when absent.
func impActions(tail string) (string, string) {
	del, upd := "CASCADE", ""
	for _, m := range reImpAction.FindAllStringSubmatch(tail, -1) {
		a := normalizeFKAction(m[2])
		if strings.ToUpper(m[1]) == "DELETE" {
			del = a
		} else {
			upd = a
		}
	}
	return del, upd
}

// impColType splits "VARCHAR(190) NOT NULL ..." into (type, rest).
// The cut scan skips single-quoted literals (ENUM values, defaults), so a
// space inside 'a b' does not end the type early. ai reports a SERIAL-family
// spelling (pg sequence ⇒ AI); pg/lite are dialect cues.
func impColType(rest string) (string, string, bool, bool, bool) {
	words := strings.Fields(rest)
	cut := len(words)
	inQuote := false
	for k, w := range words {
		// Quote tracking: an odd run of ' toggles literal state. '' is one
		// escaped quote, so count singles and halve rounding up.
		q := 0
		for i := 0; i < len(w); i++ {
			if w[i] == '\'' {
				q++
			}
		}
		if inQuote {
			if q%2 == 1 {
				inQuote = false
			}
			continue
		}
		if q%2 == 1 {
			inQuote = true // literal starts mid-type (ENUM default): keep word
			continue
		}
		core := strings.ToUpper(strings.Trim(strings.Trim(w, ",;"), "()"))
		if impStopWords[core] {
			cut = k
			break
		}
	}
	typ := strings.Join(words[:cut], " ")
	after := strings.TrimSpace(strings.Join(words[cut:], " "))
	base, args := splitType(typ)
	mapped, isAI := impBaseType(base)
	if args != "" {
		typ = mapped + "(" + args + ")"
	} else {
		typ = mapped
	}
	// Cues the mapping consumed: SERIAL/identity is pg, AUTOINCREMENT is sqlite.
	pg := isAI
	ru := strings.ToUpper(rest)
	if strings.Contains(ru, "SERIAL") || strings.Contains(ru, "GENERATED ") || strings.Contains(ru, "IDENTITY") {
		pg = true
	}
	lite := strings.Contains(ru, "AUTOINCREMENT")
	return typ, after, isAI, pg, lite
}
