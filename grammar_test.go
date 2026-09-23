// grammar_test.go — the MySQL canonical grammar: generate↔parse round-trip,
// escaping, lint, rejects. Ported from the deleted JS suite (erd.js grammar half).
package main

import (
	"strings"
	"testing"
)

func sampleSchema() *Schema {
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

func TestGenSQLShapes(t *testing.T) {
	sql := mustGenSQL(sampleSchema())
	for _, want := range []string{
		"`id` INT NOT NULL AUTO_INCREMENT",
		"`email` VARCHAR(190) NOT NULL UNIQUE",
		"COMMENT 'pk'",
		"KEY `idx_posts_tag` (`tag`)",
		"FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("missing %q in:\n%s", want, sql)
		}
	}
}

func TestRoundTripStable(t *testing.T) {
	s := sampleSchema()
	sql1 := mustGenSQL(s)
	s2, err := ParseDDL(sql1)
	if err != nil {
		t.Fatal(err)
	}
	if sql2 := mustGenSQL(s2); sql1 != sql2 {
		t.Errorf("round-trip drift:\n%s\n----\n%s", sql1, sql2)
	}
	// refs survived
	if s2.Tables[1].Columns[1].Ref == nil || s2.Tables[1].Columns[1].Ref.Action != "SET NULL" {
		t.Error("FK lost or action lost in round-trip")
	}
}

func TestRoundTripEscaping(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "we`ird", Columns: []Col{
		{Name: "a`b", Type: "INT", Pk: true},
		{Name: "c", Type: "VARCHAR(10)", Comment: "it's \"quoted\""},
		{Name: "e", Type: "ENUM('a''b','c,d')"},
	}}}}
	sql := mustGenSQL(s)
	s2, err := ParseDDL(sql)
	if err != nil {
		t.Fatal(err)
	}
	if got := mustGenSQL(s2); got != sql {
		t.Errorf("escaping drift:\n%s\n----\n%s", sql, got)
	}
	c := s2.Tables[0].Columns[1]
	if c.Comment != "it's \"quoted\"" {
		t.Errorf("comment mangled: %q", c.Comment)
	}
	if s2.Tables[0].Name != "we`ird" || s2.Tables[0].Columns[0].Name != "a`b" {
		t.Error("backtick identifiers mangled")
	}
}

func TestParseRejects(t *testing.T) {
	cases := map[string]string{
		"unsupported clause": "CREATE TABLE `a` (\n  ENGINE=InnoDB\n) ENGINE=InnoDB;\n",
		"garbage line":       "CREATE TABLE `a` (\n  ??? \n) ENGINE=InnoDB;\n",
		"outside table":      "DROP TABLE `a`;\n",
		"no tables":          "-- nothing\n",
		"duplicate table":    "CREATE TABLE `a` (\n  `id` INT\n) ENGINE=InnoDB;\nCREATE TABLE `a` (\n  `id` INT\n) ENGINE=InnoDB;\n",
	}
	for name, sql := range cases {
		if _, err := ParseDDL(sql); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestDanglingFKDropped(t *testing.T) {
	sql := "CREATE TABLE `a` (\n  `id` INT,\n  CONSTRAINT `fk_a_id` FOREIGN KEY (`id`) REFERENCES `gone` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB;\n"
	s, err := ParseDDL(sql)
	if err != nil {
		t.Fatal(err)
	}
	if s.Tables[0].Columns[0].Ref != nil {
		t.Error("dangling ref must be dropped")
	}
}

func TestCompositePKRoundTrip(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "m", Columns: []Col{
		{Name: "a", Type: "INT", Pk: true},
		{Name: "b", Type: "INT", Pk: true},
		{Name: "x", Type: "INT", Ref: &Ref{TableID: "t1"}},
	}}}}
	sql := mustGenSQL(s)
	if strings.Contains(sql, "CONSTRAINT `fk_m_x`") {
		t.Error("FK onto composite PK must not be emitted")
	}
	s2, err := ParseDDL(sql)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(pkCols(s2.Tables[0])); n != 2 {
		t.Errorf("composite PK lost: %d cols", n)
	}
}

func TestLint(t *testing.T) {
	s := sampleSchema()
	if l := s.Lint(); len(l) != 0 {
		t.Errorf("clean schema linted: %v", l)
	}
	s.Tables[1].Columns[1].Type = "VARCHAR(10)" // vs INT parent
	if l := s.Lint(); len(l) != 1 || !strings.Contains(l[0], "posts.user_id") {
		t.Errorf("mismatch not flagged: %v", l)
	}
}

func TestLintNoPK(t *testing.T) {
	s := &Schema{Tables: []Table{
		{ID: "t1", Name: "badref", Columns: []Col{{Name: "email", Type: "VARCHAR(190)", Nn: true}}},
		{ID: "t2", Name: "posts", Columns: []Col{{Name: "user_id", Type: "INT", Ref: &Ref{TableID: "t1"}}}},
	}}
	l := s.Lint()
	if len(l) != 1 || !strings.Contains(l[0], "has no PK") {
		t.Fatalf("PK-less parent not flagged: %v", l)
	}
}

// TestLintArraySuffixIsNotAMismatch pins the array-suffix rule: `INT[]` and
// `INT` are the SAME element type — the `[]` is PostgreSQL collection syntax,
// a dimension, not a distinct base type. baseOf kept the suffix, so every
// array FK onto a plain scalar PK (posts.tag_ids INT[] → tags.id INT) was
// flagged as a false mismatch. The suffix must be stripped before the element
// comparison; a genuine element mismatch (INT[] FK onto a VARCHAR PK) still
// fires.
func TestLintArraySuffixIsNotAMismatch(t *testing.T) {
	s := &Schema{Dialect: DialectPostgres, Tables: []Table{
		{ID: "t1", Name: "tags", Columns: []Col{{Name: "id", Type: "INT", Pk: true}}},
		{ID: "t2", Name: "posts", Columns: []Col{{Name: "tag_ids", Type: "INT[]", Nn: true, Ref: &Ref{TableID: "t1"}}}},
	}}
	if l := s.Lint(); len(l) != 0 {
		t.Fatalf("INT[] FK onto INT PK flagged as mismatch: %v", l)
	}
	// A real element mismatch still fires after the suffix is stripped.
	s.Tables[1].Columns[0].Type = "VARCHAR(255)[]"
	if l := s.Lint(); len(l) != 1 || !strings.Contains(l[0], "posts.tag_ids") {
		t.Fatalf("VARCHAR[] FK onto INT PK not flagged: %v", l)
	}
}

func TestGenInserts(t *testing.T) {
	out := sampleSchema().GenInserts()
	if !strings.Contains(out, "INSERT INTO `users` (`id`, `email`, `status`) VALUES (NULL, '', '');") {
		t.Errorf("users insert wrong:\n%s", out)
	}
}

func TestEmptyTableSkipped(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "empty"}}}
	if strings.Contains(mustGenSQL(s), "CREATE TABLE") {
		t.Error("empty table emitted")
	}
}

// TestGenSQLGolden pins the exact saved-file bytes. GenSQL now delegates to
// buildMysql, so TestGenSQLMatchesBuildMysql (export_test.go) can only catch a
// second emitter being reintroduced — it cannot catch a change to the emitter
// itself, because both sides call the same function. This is the test that
// fails if the output format drifts. Updating it is a deliberate act: the
// saved .sql format is a contract with every file already on disk.
//
// Written with a ~ sentinel for backticks, since a raw Go string cannot contain
// one and quoting each identifier separately buries the format.
func TestGenSQLGolden(t *testing.T) {
	const want = `-- Generated by erd-creator
CREATE TABLE ~users~ (
  ~id~ INT NOT NULL AUTO_INCREMENT COMMENT 'pk',
  ~email~ VARCHAR(190) NOT NULL UNIQUE,
  ~status~ ENUM('active','banned'),
  PRIMARY KEY (~id~)
) ENGINE=InnoDB;
CREATE TABLE ~posts~ (
  ~id~ BIGINT NOT NULL AUTO_INCREMENT,
  ~user_id~ INT,
  ~tag~ VARCHAR(40),
  PRIMARY KEY (~id~),
  KEY ~idx_posts_tag~ (~tag~),
  CONSTRAINT ~fk_posts_user_id~ FOREIGN KEY (~user_id~) REFERENCES ~users~ (~id~) ON DELETE SET NULL
) ENGINE=InnoDB;
`
	got := mustGenSQL(sampleSchema())
	if got != strings.ReplaceAll(want, "~", "`") {
		t.Errorf("saved-file format drifted.\n--- got ---\n%s\n--- want ---\n%s",
			got, strings.ReplaceAll(want, "~", "`"))
	}
}

// ---- composite indexes ----
//
// A composite index cannot be a Col flag: `ix` says "this column is indexed",
// which cannot express (a, b) as ONE index — three columns marked ix are three
// separate indexes. So an index over two or more columns is a Table-level
// Index, while a one-column index deliberately stays on Col.Ix so every
// existing file's bytes are unchanged. The parsers route by column count, which
// is what lets both shapes round-trip; these tests pin that routing.

// TestCompositeIndexGolden pins the emitted DDL per dialect.
func TestCompositeIndexGolden(t *testing.T) {
	cases := map[string]string{
		"mysql":    "  KEY `idx_posts_user_id_tag` (`user_id`, `tag`)",
		"mariadb":  "  KEY `idx_posts_user_id_tag` (`user_id`, `tag`)",
		"postgres": `CREATE INDEX "idx_posts_user_id_tag" ON "posts" ("user_id", "tag");`,
		"sqlite":   "CREATE INDEX IF NOT EXISTS `idx_posts_user_id_tag` ON `posts` (`user_id`, `tag`);",
	}
	for d, want := range cases {
		s := compositeIndexSchema()
		s.Dialect = d
		sql, err := s.GenSQL()
		if err != nil {
			t.Fatalf("%s: %v", d, err)
		}
		if !strings.Contains(sql, want) {
			t.Errorf("%s: missing %q in:\n%s", d, want, sql)
		}
	}
}

// TestCompositeIndexAbsentEmitsNothing: a table with no composite indexes must
// emit exactly the bytes it did before the field existed.
func TestCompositeIndexAbsentEmitsNothing(t *testing.T) {
	sql := mustGenSQL(sampleSchema())
	for _, banned := range []string{"idx_users_id_email", "idx_posts_user_id_tag"} {
		if strings.Contains(sql, banned) {
			t.Errorf("emitted a composite index nobody declared (%s):\n%s", banned, sql)
		}
	}
	// and the single-column IX path is untouched
	if !strings.Contains(sql, "KEY `idx_posts_tag` (`tag`)") {
		t.Errorf("single-column index changed:\n%s", sql)
	}
}

// compositeIndexSchema is a schema with a composite index plus a single-column
// index, so the two shapes are exercised together.
func compositeIndexSchema() *Schema {
	return &Schema{Tables: []Table{
		{ID: "t1", Name: "users", Columns: []Col{
			{Name: "id", Type: "INT", Pk: true, Nn: true, Ai: true},
		}},
		{ID: "t2", Name: "posts", Columns: []Col{
			{Name: "id", Type: "INT", Pk: true, Nn: true, Ai: true},
			{Name: "user_id", Type: "INT", Ref: &Ref{TableID: "t1"}},
			{Name: "tag", Type: "VARCHAR(40)", Ix: true},
		}, Indexes: []Index{
			{Cols: []string{"user_id", "tag"}},
		}},
	}}
}

// TestCompositeIndexRoundTrip: every dialect must read back what it wrote, and
// the second emit must match the first byte for byte.
func TestCompositeIndexRoundTrip(t *testing.T) {
	for _, d := range []string{"mysql", "mariadb", "postgres", "sqlite"} {
		s := compositeIndexSchema()
		s.Dialect = d
		sql1, err := s.GenSQL()
		if err != nil {
			t.Fatalf("%s: %v", d, err)
		}
		s2, err := ParseDDL(sql1)
		if err != nil {
			t.Fatalf("%s: parse: %v", d, err)
		}
		// the composite index came back with both columns, in order
		ixs := s2.Tables[1].Indexes
		if len(ixs) != 1 {
			t.Fatalf("%s: got %d composite indexes, want 1: %+v", d, len(ixs), ixs)
		}
		if got := ixs[0].Cols; len(got) != 2 || got[0] != "user_id" || got[1] != "tag" {
			t.Errorf("%s: composite index columns wrong: %v", d, got)
		}
		// the single-column index did NOT become a composite one
		if !s2.Tables[1].Columns[2].Ix {
			t.Errorf("%s: single-column Ix lost in round-trip", d)
		}
		if sql2 := mustGenSQL(s2); sql1 != sql2 {
			t.Errorf("%s: round-trip drift:\n%s\n----\n%s", d, sql1, sql2)
		}
	}
}

// TestCompositeIndexArityRouting is the regression for a real bug: the old
// reIndex pattern matched `KEY idx (a, b)` but the handler read a single column
// name out of it, so a hand-written composite index parsed WITHOUT error and
// was silently dropped — both columns came back ix=false and the index was
// gone. Silent, because the line was recognised and simply mis-read.
func TestCompositeIndexArityRouting(t *testing.T) {
	sql := "CREATE TABLE `t` (\n  `a` INT,\n  `b` INT,\n  PRIMARY KEY (`a`),\n  KEY `idx_t_ab` (`a`, `b`)\n) ENGINE=InnoDB;\n"
	s, err := ParseDDL(sql)
	if err != nil {
		t.Fatalf("composite index line rejected: %v", err)
	}
	if len(s.Tables[0].Indexes) != 1 {
		t.Fatalf("composite index dropped: %+v", s.Tables[0].Indexes)
	}
	if got := s.Tables[0].Indexes[0].Cols; len(got) != 2 {
		t.Errorf("want 2 columns, got %v", got)
	}
	// the columns themselves must NOT be flagged ix: a composite index is not
	// two single-column indexes
	for _, c := range s.Tables[0].Columns {
		if c.Ix {
			t.Errorf("column %s wrongly marked ix by a composite index", c.Name)
		}
	}
}

// TestSingleColumnIndexStaysColIx: the one-column path must keep using Col.Ix,
// or every existing file would be rewritten into the new representation.
func TestSingleColumnIndexStaysColIx(t *testing.T) {
	sql := "CREATE TABLE `t` (\n  `a` INT,\n  PRIMARY KEY (`a`),\n  KEY `idx_t_a` (`a`)\n) ENGINE=InnoDB;\n"
	s, err := ParseDDL(sql)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Tables[0].Indexes) != 0 {
		t.Errorf("one-column index became composite: %+v", s.Tables[0].Indexes)
	}
	if !s.Tables[0].Columns[0].Ix {
		t.Error("one-column index did not set Col.Ix")
	}
}

// TestIndexNameDerivation: an unnamed index gets idx_<table>_<cols>; an
// explicit name is used verbatim. The frontend preview mirrors this rule
// (TableIndexModal.svelte shownName: `idx_${table}_${cols.join("_")}`) —
// keep the two in agreement or the dialog shows a name the DDL won't use.
func TestIndexNameDerivation(t *testing.T) {
	s := compositeIndexSchema()
	sql := mustGenSQL(s)
	if !strings.Contains(sql, "idx_posts_user_id_tag") {
		t.Errorf("derived name missing:\n%s", sql)
	}
	s.Tables[1].Indexes[0].Name = "my_custom_idx"
	sql2 := mustGenSQL(s)
	if !strings.Contains(sql2, "my_custom_idx") {
		t.Errorf("explicit name not used:\n%s", sql2)
	}
	if strings.Contains(sql2, "idx_posts_user_id_tag") {
		t.Errorf("derived name emitted alongside the explicit one:\n%s", sql2)
	}
}

// TestRejectsBadIndexes: index names and columns are identifiers, so they are
// checked by the same machinery as table and column names. Which layer rejects
// what is deliberate and worth pinning:
//
//   - a semicolon in a name is rejected by Validate at the boundary: a quoted
//     identifier containing one is technically safe SQL, but it reads as an
//     injection ("ok; DROP TABLE ...") and the old last-gate rejection was a
//     confusing 400 far from the cause. No file on disk can contain one — the
//     old gate blocked it at save and never wrote such a file — so failing
//     early cannot strand an existing schema.
//   - a control character (a newline) breaks the line-oriented format, so
//     Validate rejects it outright
//   - an empty column list is structurally invalid, so Validate rejects it
//
// The property that matters is that GenSQL never emits any of them.
func TestRejectsBadIndexes(t *testing.T) {
	cases := []struct {
		name        string
		ix          Index
		wantInvalid bool // Validate must also reject it
	}{
		{"semicolon in name", Index{Name: "ok; DROP TABLE users;--", Cols: []string{"a", "b"}}, true},
		{"newline in column", Index{Name: "ok", Cols: []string{"a\nb", "c"}}, true},
		{"no columns", Index{Name: "ok", Cols: []string{}}, true},
	}
	for _, tc := range cases {
		s := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
			{Name: "a", Type: "INT", Pk: true}, {Name: "b", Type: "INT"}, {Name: "c", Type: "INT"},
		}, Indexes: []Index{tc.ix}}}}
		err := s.Validate()
		if tc.wantInvalid && err == nil {
			t.Errorf("%s: Validate accepted %+v", tc.name, tc.ix)
		}
		if !tc.wantInvalid && err != nil {
			t.Errorf("%s: Validate rejected %+v: %v", tc.name, tc.ix, err)
		}
		// never emitted, whichever layer caught it
		if sql, gerr := s.GenSQL(); gerr == nil {
			t.Errorf("%s: GenSQL emitted %+v:\n%s", tc.name, tc.ix, sql)
		}
	}
}

//
// ON UPDATE and ON DELETE use opposite conventions, which is why these tests
// exist: ON DELETE defaults to CASCADE (an unset action must keep meaning what
// the files already on disk mean), while ON UPDATE empty means OMIT (a new
// field must not silently add a clause nobody chose).
//
// TestOnUpdateAbsentEmitsNothing is the load-bearing one: it pins that a schema
// with no ON UPDATE action is byte-identical to what the emitter wrote before
// the field existed. If that breaks, every saved file's format changed.

// onUpdateSchema is sampleSchema's shape with one FK carrying ON UPDATE and one
// without, so both conventions are exercised in a single round-trip.
func onUpdateSchema() *Schema {
	return &Schema{Tables: []Table{
		{ID: "t1", Name: "users", Columns: []Col{
			{Name: "id", Type: "INT", Pk: true, Nn: true, Ai: true},
		}},
		{ID: "t2", Name: "posts", Columns: []Col{
			{Name: "id", Type: "BIGINT", Pk: true, Nn: true, Ai: true},
			{Name: "user_id", Type: "INT", Ref: &Ref{TableID: "t1", Action: "SET NULL", OnUpdate: "CASCADE"}},
			{Name: "editor_id", Type: "INT", Ref: &Ref{TableID: "t1", Action: "RESTRICT"}},
		}},
	}}
}

func TestOnUpdateAbsentEmitsNothing(t *testing.T) {
	sql := mustGenSQL(sampleSchema())
	if strings.Contains(sql, "ON UPDATE") {
		t.Errorf("a schema without an ON UPDATE action must not emit one:\n%s", sql)
	}
}

func TestOnUpdateRoundTrip(t *testing.T) {
	for _, d := range []string{"mysql", "mariadb", "postgres", "sqlite"} {
		s := onUpdateSchema()
		s.Dialect = d
		sql1, err := s.GenSQL()
		if err != nil {
			t.Fatalf("%s: %v", d, err)
		}
		if !strings.Contains(sql1, "ON UPDATE CASCADE") {
			t.Errorf("%s: ON UPDATE CASCADE not emitted:\n%s", d, sql1)
		}
		s2, err := ParseDDL(sql1)
		if err != nil {
			t.Fatalf("%s: parse: %v", d, err)
		}
		if got := s2.Tables[1].Columns[1].Ref; got == nil || got.OnUpdate != "CASCADE" {
			t.Errorf("%s: ON UPDATE lost in round-trip: %+v", d, got)
		}
		// the clause-less column must come back empty, not defaulted
		if blank := s2.Tables[1].Columns[2].Ref; blank == nil || blank.OnUpdate != "" {
			t.Errorf("%s: absent ON UPDATE became %+v", d, blank)
		}
		if sql2 := mustGenSQL(s2); sql1 != sql2 {
			t.Errorf("%s: round-trip drift:\n%s\n----\n%s", d, sql1, sql2)
		}
	}
}

// TestOnUpdateOrderIsDeleteThenUpdate pins the clause order. Both orders are
// valid SQL, but each parser matches one specific order, so an emitter that
// swapped them would write a file that fails to reopen — and that failure would
// surface on load, far from the change that caused it.
func TestOnUpdateOrderIsDeleteThenUpdate(t *testing.T) {
	sql := mustGenSQL(onUpdateSchema())
	const want = "ON DELETE SET NULL ON UPDATE CASCADE"
	if !strings.Contains(sql, want) {
		t.Errorf("clause order drifted, want %q in:\n%s", want, sql)
	}
}

// TestOnUpdateDefaults shows both conventions side by side: an empty ON DELETE
// still emits CASCADE, an empty ON UPDATE emits nothing.
func TestOnUpdateDefaults(t *testing.T) {
	s := &Schema{Tables: []Table{
		{ID: "t1", Name: "p", Columns: []Col{{Name: "id", Type: "INT", Pk: true}}},
		{ID: "t2", Name: "c", Columns: []Col{
			{Name: "pid", Type: "INT", Ref: &Ref{TableID: "t1"}},
		}},
	}}
	sql := mustGenSQL(s)
	if !strings.Contains(sql, "ON DELETE CASCADE") {
		t.Errorf("unset ON DELETE must default to CASCADE:\n%s", sql)
	}
	if strings.Contains(sql, "ON UPDATE") {
		t.Errorf("unset ON UPDATE must omit the clause:\n%s", sql)
	}
}

// TestRejectsFKActionInjection: the action is emitted as raw SQL inside a
// constraint clause, so it is an allowlist like the type field — a value that
// escaped its position becomes injection in whatever database the user pastes
// the output into.
func TestRejectsFKActionInjection(t *testing.T) {
	payloads := []string{
		"CASCADE; DROP TABLE users;--",
		"CASCADE ON UPDATE NO ACTION",
		"SET NULL\n--",
		"DROP TABLE users",
		"CASCADE'",
		"cascade", // lowercase is not canonical; the parser normalizes, input does not
	}
	for _, p := range payloads {
		for _, field := range []string{"action", "onUpdate"} {
			ref := &Ref{TableID: "t1"}
			if field == "action" {
				ref.Action = p
			} else {
				ref.OnUpdate = p
			}
			s := &Schema{Tables: []Table{
				{ID: "t1", Name: "p", Columns: []Col{{Name: "id", Type: "INT", Pk: true}}},
				{ID: "t2", Name: "c", Columns: []Col{{Name: "pid", Type: "INT", Ref: ref}}},
			}}
			if err := s.Validate(); err == nil {
				t.Errorf("%s=%q accepted — it would be emitted as raw SQL", field, p)
			}
			if sql, err := s.GenSQL(); err == nil {
				t.Errorf("GenSQL emitted %s=%q:\n%s", field, p, sql)
			}
		}
	}
}

// TestAcceptsRealFKActions: the allowlist must not reject what the UI offers,
// in either action field.
func TestAcceptsRealFKActions(t *testing.T) {
	for _, a := range []string{"CASCADE", "RESTRICT", "SET NULL", "NO ACTION", "SET DEFAULT"} {
		s := &Schema{Tables: []Table{
			{ID: "t1", Name: "p", Columns: []Col{{Name: "id", Type: "INT", Pk: true}}},
			{ID: "t2", Name: "c", Columns: []Col{
				{Name: "pid", Type: "INT", Ref: &Ref{TableID: "t1", Action: a, OnUpdate: a}},
			}},
		}}
		if err := s.Validate(); err != nil {
			t.Errorf("legitimate action %q rejected: %v", a, err)
		}
	}
}

// TestParseNormalizesFKActionCase: a hand-written file in lowercase must load
// as the canonical form, or the next save would reject what the file itself
// said. The parser uppercases type names for the same reason.
func TestParseNormalizesFKActionCase(t *testing.T) {
	sql := "CREATE TABLE `p` (\n  `id` INT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n" +
		"CREATE TABLE `c` (\n  `pid` INT,\n  CONSTRAINT `fk_c_pid` FOREIGN KEY (`pid`) REFERENCES `p` (`id`) on delete set null on update cascade\n) ENGINE=InnoDB;\n"
	s, err := ParseDDL(sql)
	if err != nil {
		t.Fatal(err)
	}
	ref := s.Tables[1].Columns[0].Ref
	if ref == nil || ref.Action != "SET NULL" || ref.OnUpdate != "CASCADE" {
		t.Fatalf("lowercase actions not canonicalized: %+v", ref)
	}
	if err := s.Validate(); err != nil {
		t.Errorf("parsed schema fails validation: %v", err)
	}
}

// ---- identifiers the line grammar must span ----

// TestRoundTripQuotedIdentifierSpaces: identifiers may contain spaces, so the
// emitters quote them and the parsers must read the FULL quoted token back.
// This pins the HIGH round-trip bug: mysql/sqlite tokenised with `(\S+)`,
// which stops at a space inside “ `user accounts` “ — the tool saved a file
// it could not reopen.
func TestRoundTripQuotedIdentifierSpaces(t *testing.T) {
	base := []Table{
		{ID: "t1", Name: "user accounts", Columns: []Col{
			{Name: "full name", Type: "VARCHAR(40)", Pk: true},
			{Name: "other col", Type: "INT"},
		}},
	}
	for _, d := range []string{"mysql", "mariadb", "postgres", "sqlite"} {
		s := &Schema{Dialect: d, Tables: base}
		sql, err := s.GenSQL()
		if err != nil {
			t.Fatalf("%s: %v", d, err)
		}
		s2, err := ParseDDL(sql)
		if err != nil {
			t.Fatalf("%s: could not reopen its own output:\n%s", d, sql)
		}
		if s2.Tables[0].Name != "user accounts" {
			t.Errorf("%s: table name mangled: %q", d, s2.Tables[0].Name)
		}
		if s2.Tables[0].Columns[0].Name != "full name" {
			t.Errorf("%s: column name mangled: %q", d, s2.Tables[0].Columns[0].Name)
		}
		if got := mustGenSQL(s2); got != sql {
			t.Errorf("%s: round-trip drift:\n%s\n----\n%s", d, sql, got)
		}
	}
}

// TestRoundTripEnumParenValue: an ENUM value containing a closing paren was
// not parseable — the old type scan `[^)]*` stopped at the first ) even inside
// a quoted literal, rejecting a type the model accepts and emits.
func TestRoundTripEnumParenValue(t *testing.T) {
	base := []Table{
		{ID: "t1", Name: "t", Columns: []Col{
			{Name: "st", Type: "ENUM('a)b','c')"},
			{Name: "id", Type: "INT", Pk: true},
		}},
	}
	for _, d := range []string{"mysql", "mariadb", "postgres", "sqlite"} {
		s := &Schema{Dialect: d, Tables: base}
		sql, err := s.GenSQL()
		if err != nil {
			t.Fatalf("%s: %v", d, err)
		}
		s2, err := ParseDDL(sql)
		if err != nil {
			t.Fatalf("%s: could not reopen ENUM with ) value:\n%s", d, sql)
		}
		got := s2.Tables[0].Columns[0].Type
		if got != "ENUM('a)b','c')" {
			t.Errorf("%s: enum value mangled: %q", d, got)
		}
	}
}

// TestRoundTripCommaInIndexedName: an index column or PK named `a, b` must not
// split on its comma. This was the arity-routing bug: reIndex's comma split
// turned one quoted `a, b` column into a composite index of two.
func TestRoundTripCommaInIndexedName(t *testing.T) {
	base := []Table{
		{ID: "t1", Name: "t", Columns: []Col{
			{Name: "a, b", Type: "INT", Ix: true},
			{Name: "id", Type: "INT", Pk: true},
		}},
	}
	for _, d := range []string{"mysql", "mariadb", "postgres", "sqlite"} {
		s := &Schema{Dialect: d, Tables: base}
		sql, err := s.GenSQL()
		if err != nil {
			t.Fatalf("%s: %v", d, err)
		}
		s2, err := ParseDDL(sql)
		if err != nil {
			t.Fatalf("%s: could not reopen comma-named index column:\n%s", d, sql)
		}
		if got := s2.Tables[0].Columns[0].Name; got != "a, b" {
			t.Errorf("%s: column name split: %q", d, got)
		}
		if !s2.Tables[0].Columns[0].Ix || len(s2.Tables[0].Indexes) != 0 {
			t.Errorf("%s: single-column index misrouted: %v", d, s2.Tables[0].Indexes)
		}
		if got := mustGenSQL(s2); got != sql {
			t.Errorf("%s: round-trip drift:\n%s\n----\n%s", d, sql, got)
		}
	}
}

// ---- validation: what cannot be represented or emitted ----

// TestRejectsDuplicateTableNames: two tables with the same name emit CREATE
// TABLE twice (invalid DDL), and the parser already rejects the duplicate on
// reopen — so validation rejects before emit, naming the table.
func TestRejectsDuplicateTableNames(t *testing.T) {
	s := &Schema{Tables: []Table{
		{ID: "t1", Name: "dup", Columns: []Col{{Name: "a", Type: "INT"}}},
		{ID: "t2", Name: "dup", Columns: []Col{{Name: "b", Type: "INT"}}},
	}}
	if err := s.Validate(); err == nil {
		t.Error("duplicate table names must be rejected")
	}
}

// TestRejectsDuplicateColumnNames: two columns with the same name emit the
// definition twice, and markCol on reopen touches only the first.
func TestRejectsDuplicateColumnNames(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
		{Name: "a", Type: "INT"},
		{Name: "a", Type: "VARCHAR(9)"},
	}}}}
	if err := s.Validate(); err == nil {
		t.Error("duplicate column names must be rejected")
	}
}

// TestRejectsSingleColumnTableIndex: a table-level index over one column is
// unrepresentable — the model and every parser keep single-column indexes on
// Col.Ix — so it is refused rather than saved as DDL that reopens differently.
func TestRejectsSingleColumnTableIndex(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
		{Name: "a", Type: "INT", Pk: true},
	}, Indexes: []Index{
		{Name: "ix", Cols: []string{"a"}},
	}}}}
	if err := s.Validate(); err == nil {
		t.Error("single-column table index must be rejected")
	}
}

// TestRejectsDuplicateIndexNames: two indexes deriving the same emitted name
// would write KEY idx_... twice; the database rejects that, so validation does.
func TestRejectsDuplicateIndexNames(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "t", Columns: []Col{
		{Name: "a", Type: "INT"},
		{Name: "b", Type: "INT"},
		{Name: "c", Type: "INT"},
	}, Indexes: []Index{
		{Cols: []string{"a", "b"}},
		{Cols: []string{"a", "b"}},
	}}}}
	if err := s.Validate(); err == nil {
		t.Error("duplicate derived index names must be rejected")
	}
}

// TestLintMissingTable: an FK whose parent table does not exist is dropped
// from the DDL — and must now be REPORTED, not silently vanish. The no-PK and
// composite-PK cases were reported; the missing-table case was the gap.
func TestLintMissingTable(t *testing.T) {
	s := &Schema{Tables: []Table{{ID: "t1", Name: "posts", Columns: []Col{
		{Name: "user_id", Type: "INT", Ref: &Ref{TableID: "gone"}},
	}}}}
	l := s.Lint()
	if len(l) != 1 || !strings.Contains(l[0], "gone") {
		t.Fatalf("missing-table FK not reported: %v", l)
	}
}
