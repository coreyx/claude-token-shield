package render

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// rawFact is one input fact as the fixtures write it.
type rawFact struct {
	Kind       string          `json:"kind"`
	ReceivedAt float64         `json:"receivedAt"`
	Payload    json.RawMessage `json:"payload"`
	Request    *native.Request `json:"request"`
	Event      *native.Event   `json:"event"`
}

// parityCase is one fixtures/parity/*.json file.
type parityCase struct {
	Name         string     `json:"name"`
	Now          float64    `json:"now"`
	TzOffsetMin  int        `json:"tzOffsetMin"`
	Env          assess.Env `json:"env"`
	CCVersion    string     `json:"ccVersion"`
	DefaultModel string     `json:"defaultModel"`
	Mode         string     `json:"mode"`
	Width        int        `json:"width"`
	Glyphs       string     `json:"glyphs"`
	Facts        []rawFact  `json:"facts"`
	Expect       struct {
		View     any    `json:"view"`
		Segment  string `json:"segment"`
		Check    string `json:"check"`
		ExitCode int    `json:"exitCode"`
	} `json:"expect"`
}

// build runs facts through the reducer.
func build(t *testing.T, facts []rawFact) native.State {
	t.Helper()
	s := native.State{}
	for _, f := range facts {
		switch f.Kind {
		case "snapshot":
			snap := native.ParseSnapshot(f.Payload, f.ReceivedAt)
			s = native.Reduce(s, native.Fact{Snapshot: &snap})
		case "request":
			s = native.Reduce(s, native.Fact{Request: f.Request})
		case "event":
			s = native.Reduce(s, native.Fact{Event: f.Event})
		default:
			t.Fatalf("unknown fact kind %q", f.Kind)
		}
	}
	return s
}

func shared(t *testing.T) *data.Shared {
	t.Helper()
	d, err := data.Load()
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// TestParityFixtures holds the Go port to the TypeScript core's answers.
func TestParityFixtures(t *testing.T) {
	d := shared(t)
	files, err := filepath.Glob("../../fixtures/parity/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no parity fixtures found (%v)", err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var c parityCase
			if err := json.Unmarshal(raw, &c); err != nil {
				t.Fatal(err)
			}
			s := build(t, c.Facts)
			ev := Evaluate(s, c.Now, Context{Data: d, Env: c.Env, CCVersion: c.CCVersion, DefaultModel: c.DefaultModel, Mode: c.Mode})
			opts := Options{Glyphs: GlyphSet(c.Glyphs), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: c.TzOffsetMin, Billing: ev.Billing}

			var gotView any
			b, _ := json.Marshal(ev.View)
			_ = json.Unmarshal(b, &gotView)
			if diff := compare("view", c.Expect.View, gotView); diff != "" {
				t.Errorf("view differs: %s", diff)
			}
			if got := Segment(ev.A, ev.Cost, opts); got != c.Expect.Segment {
				t.Errorf("segment:\n got  %q\n want %q", got, c.Expect.Segment)
			}
			if got := Check(ev.View, c.Width, opts); got != c.Expect.Check {
				t.Errorf("check:\n--- got\n%s\n--- want\n%s", got, c.Expect.Check)
			}
			if got := ExitCodes[ev.A.State]; got != c.Expect.ExitCode {
				t.Errorf("exit code %d, want %d", got, c.Expect.ExitCode)
			}
		})
	}
}

// TestRenderGoldens rebuilds the TypeScript renderer's scenarios and matches every golden file.
func TestRenderGoldens(t *testing.T) {
	d := shared(t)
	raw, err := os.ReadFile("../../fixtures/render/scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	var scenarios map[string]struct {
		Now   float64   `json:"now"`
		Facts []rawFact `json:"facts"`
	}
	if err := json.Unmarshal(raw, &scenarios); err != nil {
		t.Fatal(err)
	}
	golden := func(t *testing.T, name, got string) {
		t.Helper()
		want, err := os.ReadFile(filepath.Join("../../fixtures/render", name))
		if err != nil {
			t.Fatal(err)
		}
		if got+"\n" != string(want) {
			t.Errorf("%s:\n--- got\n%s\n--- want\n%s", name, got, want)
		}
	}
	env := assess.Env{Provider: "firstParty", ToolSearch: true}
	for state, sc := range scenarios {
		t.Run(state, func(t *testing.T) {
			s := build(t, sc.Facts)
			for _, mode := range []string{"default", "verbose", "diff"} {
				ev := Evaluate(s, sc.Now, Context{Data: d, Env: env, Mode: mode})
				// The TypeScript scenarios render as API billing.
				view := CheckView(ev.A, s, ev.Quotes, ev.Rec, ev.Cost, "api", mode)
				for _, glyphs := range []string{"unicode", "ascii"} {
					opts := Options{Glyphs: GlyphSet(glyphs), Strings: &d.Strings, Display: d.Rules.Display, Billing: "api"}
					switch mode {
					case "default":
						golden(t, fmt.Sprintf("segment-%s-%s.txt", state, glyphs), Segment(ev.A, ev.Cost, opts))
						for _, w := range []int{80, 120} {
							golden(t, fmt.Sprintf("check-%s-%d-%s.txt", state, w, glyphs), Check(view, w, opts))
						}
					case "verbose":
						if state == "HOT" && glyphs == "unicode" {
							golden(t, "check-HOT-verbose-120-unicode.txt", Check(view, 120, opts))
						}
					case "diff":
						if state == "INVALIDATED" && glyphs == "unicode" {
							golden(t, "check-INVALIDATED-diff-100-unicode.txt", Check(view, 100, opts))
						}
					}
				}
			}
		})
	}
}

// compare reports the first difference between two decoded JSON values,
// allowing for the last bits of floating-point results.
func compare(path string, want, got any) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: want object, got %T", path, got)
		}
		keys := map[string]bool{}
		for k := range w {
			keys[k] = true
		}
		for k := range g {
			keys[k] = true
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			if d := compare(path+"."+k, w[k], g[k]); d != "" {
				return d
			}
		}
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s: want %d items, got %v", path, len(w), got)
		}
		for i := range w {
			if d := compare(fmt.Sprintf("%s[%d]", path, i), w[i], g[i]); d != "" {
				return d
			}
		}
	case float64:
		g, ok := got.(float64)
		if !ok || math.Abs(w-g) > 1e-9*math.Max(1, math.Abs(w)) {
			return fmt.Sprintf("%s: want %v, got %v", path, w, got)
		}
	default:
		if fmt.Sprint(want) != fmt.Sprint(got) || (want == nil) != (got == nil) {
			return fmt.Sprintf("%s: want %v, got %v", path, want, got)
		}
	}
	return ""
}

// TestCompare checks the comparison helper itself.
func TestCompare(t *testing.T) {
	if d := compare("x", map[string]any{"a": 1.0}, map[string]any{"a": 1.0 + 1e-12}); d != "" {
		t.Error(d)
	}
	for _, c := range [][2]any{{1.0, 2.0}, {[]any{1.0}, []any{}}, {map[string]any{}, "x"}, {"a", nil}} {
		if compare("x", c[0], c[1]) == "" {
			t.Errorf("%v vs %v should differ", c[0], c[1])
		}
	}
	_ = strings.TrimSpace
}
