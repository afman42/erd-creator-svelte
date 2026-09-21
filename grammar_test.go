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
// explicit name is used verbatim.
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
// what is deliberate and worth pinning, because it is the same layering the
// type field uses:
//
//   - a control character (a newline) breaks the line-oriented format, so
//     Validate rejects it outright
//   - an empty column list is structurally invalid, so Validate rejects it
//   - a semicolon is NOT rejected by Validate: it is safe inside a quoted
//     identifier, exactly as it is in a table name (`a;b` is a legal table
//     name here). It is caught by validateOutput at the last gate instead,
//     because the emitted line would contain a mid-line separator.
//
// The property that matters is the last one: GenSQL must never emit any of
// them. Asserting Validate catches the semicolon too would be asserting a
// behaviour the table-name path does not have.
func TestRejectsBadIndexes(t *testing.T) {
	cases := []struct {
		name        string
		ix          Index
		wantInvalid bool // Validate must also reject it
	}{
		{"semicolon in name", Index{Name: "ok; DROP TABLE users;--", Cols: []string{"a", "b"}}, false},
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
