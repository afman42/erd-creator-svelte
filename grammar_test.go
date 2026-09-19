// grammar_test.go — the MySQL canonical grammar: generate↔parse round-trip,
// escaping, lint, rejects. Ported from the deleted JS suite (erd.js grammar half).
package main

import (
	"strings"
	"testing"
)

func sampleSchema() *Schema {
	return &Schema{Tables: []Table{
		{Id: "t1", Name: "users", Columns: []Col{
			{Name: "id", Type: "INT", Pk: true, Nn: true, Ai: true, Comment: "pk"},
			{Name: "email", Type: "VARCHAR(190)", Nn: true, Ux: true},
			{Name: "status", Type: "ENUM('active','banned')"},
		}},
		{Id: "t2", Name: "posts", Columns: []Col{
			{Name: "id", Type: "BIGINT", Pk: true, Nn: true, Ai: true},
			{Name: "user_id", Type: "INT", Ref: &Ref{TableId: "t1", Action: "SET NULL"}},
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
	s := &Schema{Tables: []Table{{Id: "t1", Name: "we`ird", Columns: []Col{
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
	s := &Schema{Tables: []Table{{Id: "t1", Name: "m", Columns: []Col{
		{Name: "a", Type: "INT", Pk: true},
		{Name: "b", Type: "INT", Pk: true},
		{Name: "x", Type: "INT", Ref: &Ref{TableId: "t1"}},
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
		{Id: "t1", Name: "badref", Columns: []Col{{Name: "email", Type: "VARCHAR(190)", Nn: true}}},
		{Id: "t2", Name: "posts", Columns: []Col{{Name: "user_id", Type: "INT", Ref: &Ref{TableId: "t1"}}}},
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
	s := &Schema{Tables: []Table{{Id: "t1", Name: "empty"}}}
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
