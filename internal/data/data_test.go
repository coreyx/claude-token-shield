package data

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"

	shielddata "github.com/coreyx/claude-token-shield"
	"github.com/coreyx/claude-token-shield/internal/schemacheck"
)

// TestFilesMatchSchemas validates each embedded data file against its schema in schemas/.
func TestFilesMatchSchemas(t *testing.T) {
	pairs := map[string]string{
		PricesFile:  "../../schemas/prices.schema.json",
		RulesFile:   "../../schemas/rules.schema.json",
		StringsFile: "../../schemas/strings.schema.json",
	}
	for file, schemaPath := range pairs {
		t.Run(file, func(t *testing.T) {
			schema, err := os.ReadFile(schemaPath)
			if err != nil {
				t.Fatal(err)
			}
			doc, err := shielddata.Files.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			problems, err := schemacheck.Validate(schema, doc)
			if err != nil {
				t.Fatal(err)
			}
			if len(problems) > 0 {
				t.Errorf("%s does not match its schema:\n%s", file, strings.Join(problems, "\n"))
			}
		})
	}
}

// TestLoad reads the embedded files and spot-checks values the core depends on.
func TestLoad(t *testing.T) {
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	table := s.Prices.Tables[0]
	if table.Effective != "2026-11-03" {
		t.Errorf("effective = %q", table.Effective)
	}
	opus := table.Models["claude-opus-5-5"]
	if opus.Input != 4 || opus.ReadMult != 0.05 || opus.Write1hMult != 2 {
		t.Errorf("opus 5.5 = %+v", opus)
	}
	if tiers := table.Models["claude-haiku-5-5"].Tiers; len(tiers) != 1 || tiers[0].Above != 100000 || tiers[0].Input != 0.5 {
		t.Errorf("haiku 5.5 tiers = %+v", tiers)
	}
	for _, id := range s.Rules.PerMessageEffortModels {
		if _, ok := table.Models[id]; !ok {
			t.Errorf("per-message-effort model %s has no price", id)
		}
	}
	if s.Rules.MinClaudeCodeVersion != "2.1.260" {
		t.Errorf("minClaudeCodeVersion = %q", s.Rules.MinClaudeCodeVersion)
	}
}

// futureHitMiss matches the words AC 2.8 reserves for past requests.
var futureHitMiss = regexp.MustCompile(`(?i)\b(hit|hits|miss|misses|missed)\b`)

// TestCatalogFutureWording enforces AC 2.8 on the catalog the Go renderers read.
func TestCatalogFutureWording(t *testing.T) {
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for key, str := range s.Strings.Strings {
		if str.Tense == "future" && futureHitMiss.MatchString(str.Text) {
			t.Errorf("%s speaks of a future request with hit/miss: %q", key, str.Text)
		}
	}
}

// TestFormat matches the TypeScript formatString's behavior.
func TestFormat(t *testing.T) {
	s := Strings{Strings: map[string]CatalogString{"a.b": {Text: "warm until {time} · {tokens}", Tense: "none"}}}
	if got := s.Format("a.b", map[string]string{"time": "16:40", "tokens": "812k"}); got != "warm until 16:40 · 812k" {
		t.Errorf("filled = %q", got)
	}
	if got := s.Format("a.b", map[string]string{"time": "16:40"}); got != "warm until 16:40 · {tokens}" {
		t.Errorf("missing placeholder = %q", got)
	}
	if got := s.Format("nope", nil); got != "[nope]" {
		t.Errorf("missing key = %q", got)
	}
}

// editedFS returns the embedded files with one file's JSON changed by edit.
func editedFS(t *testing.T, file string, edit func(doc map[string]any)) fstest.MapFS {
	t.Helper()
	fsys := fstest.MapFS{}
	for _, name := range []string{PricesFile, RulesFile, StringsFile} {
		raw, err := shielddata.Files.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if name == file {
			var doc map[string]any
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatal(err)
			}
			edit(doc)
			if raw, err = json.Marshal(doc); err != nil {
				t.Fatal(err)
			}
		}
		fsys[name] = &fstest.MapFile{Data: raw}
	}
	return fsys
}

// TestLoadErrors checks each invariant the loader enforces.
func TestLoadErrors(t *testing.T) {
	firstTable := func(d map[string]any) map[string]any { return d["tables"].([]any)[0].(map[string]any) }
	cases := []struct {
		name string
		file string
		edit func(map[string]any)
		want string
	}{
		{"version", PricesFile, func(d map[string]any) { d["v"] = 2 }, "unsupported version"},
		{"no tables", PricesFile, func(d map[string]any) { d["tables"] = []any{} }, "needs at least one table"},
		{"date", PricesFile, func(d map[string]any) { firstTable(d)["effective"] = "Nov 3" }, "YYYY-MM-DD"},
		{"rate", PricesFile, func(d map[string]any) {
			firstTable(d)["models"].(map[string]any)["claude-opus-5-5"].(map[string]any)["input"] = 0
		}, "rates must be above 0"},
		{"unknown field", PricesFile, func(d map[string]any) { d["extra"] = 1 }, "unknown field"},
		{"duplicate kind", RulesFile, func(d map[string]any) {
			events := d["events"].([]any)
			d["events"] = append(events, events[0])
		}, "duplicate kind"},
		{"display", RulesFile, func(d map[string]any) {
			d["display"] = map[string]any{"maxProb": 0.01, "minProb": 0.99}
		}, "minProb must be below maxProb"},
		{"strings shape", StringsFile, func(d map[string]any) { d["strings"] = []any{} }, StringsFile},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := LoadFS(editedFS(t, c.file, c.edit))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("got error %v, want one containing %q", err, c.want)
			}
		})
	}
}

// TestLoadMissingFile reports which file is missing.
func TestLoadMissingFile(t *testing.T) {
	fsys := editedFS(t, "", nil)
	for _, name := range []string{PricesFile, RulesFile, StringsFile} {
		without := fstest.MapFS{}
		for k, v := range fsys {
			if k != name {
				without[k] = v
			}
		}
		if _, err := LoadFS(without); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("missing %s: got %v", name, err)
		}
	}
}
