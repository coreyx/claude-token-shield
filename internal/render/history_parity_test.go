package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreyx/claude-token-shield/internal/summary"
)

// historyCase is one fixtures/history/*.json file, written by tests/parity/history.test.ts.
type historyCase struct {
	Name        string                   `json:"name"`
	Now         float64                  `json:"now"`
	TzOffsetMin int                      `json:"tzOffsetMin"`
	Width       int                      `json:"width"`
	Glyphs      string                   `json:"glyphs"`
	Provider    string                   `json:"provider"`
	Since       string                   `json:"since"`
	Session     string                   `json:"session"`
	Misses      bool                     `json:"misses"`
	Sessions    []summary.SessionHistory `json:"sessions"`
	Expect      struct {
		Summary any    `json:"summary"`
		Advice  any    `json:"advice"`
		Text    string `json:"text"`
	} `json:"expect"`
}

// TestHistoryParity gives the same summary and text as the TypeScript core
// for every history fixture (AC 14.1, 14.2, 6.5).
func TestHistoryParity(t *testing.T) {
	d := shared(t)
	files, _ := filepath.Glob("../../fixtures/history/*.json")
	if len(files) == 0 {
		t.Fatal("no history fixtures")
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var c historyCase
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		t.Run(c.Name, func(t *testing.T) {
			rng, ok := summary.SinceRange(c.Since, c.Now)
			if !ok {
				t.Fatalf("since %q", c.Since)
			}
			filter := summary.Filter{Session: c.Session, Misses: c.Misses}
			s := summary.Summarize(c.Sessions, rng, filter, &d.Prices, c.Provider)
			advice := summary.Advice(c.Sessions, rng, filter, &d.Prices)
			ab, _ := json.Marshal(advice)
			var gotAdvice any
			_ = json.Unmarshal(ab, &gotAdvice)
			if diff := compare("advice", c.Expect.Advice, gotAdvice); diff != "" {
				t.Errorf("advice differs: %s", diff)
			}
			b, _ := json.Marshal(s)
			var got any
			_ = json.Unmarshal(b, &got)
			if diff := compare("summary", c.Expect.Summary, got); diff != "" {
				t.Errorf("summary differs: %s", diff)
			}
			text := RenderHistory(s, c.Width, Options{Glyphs: GlyphSet(c.Glyphs), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: c.TzOffsetMin}, &advice)
			if text != c.Expect.Text {
				t.Errorf("text differs:\n--- got\n%s\n--- want\n%s", text, c.Expect.Text)
			}
		})
	}
}
