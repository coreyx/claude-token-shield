package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreyx/claude-token-shield/internal/summary"
)

// ttlCase is one fixtures/ttl/*.json file, written by tests/parity/ttl.test.ts.
type ttlCase struct {
	Name     string                   `json:"name"`
	Now      float64                  `json:"now"`
	Since    string                   `json:"since"`
	Width    int                      `json:"width"`
	Glyphs   string                   `json:"glyphs"`
	Provider string                   `json:"provider"`
	Sessions []summary.SessionHistory `json:"sessions"`
	Expect   struct {
		Advice any    `json:"advice"`
		Text   string `json:"text"`
	} `json:"expect"`
}

// TestTTLParity gives the same advice and text as the TypeScript core for
// every TTL fixture (AC 16.1, 16.2).
func TestTTLParity(t *testing.T) {
	d := shared(t)
	files, _ := filepath.Glob("../../fixtures/ttl/*.json")
	if len(files) == 0 {
		t.Fatal("no TTL fixtures")
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		var c ttlCase
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		t.Run(c.Name, func(t *testing.T) {
			rng, _ := summary.SinceRange(c.Since, c.Now)
			a := summary.AdviseTTL(c.Sessions, rng, &d.Prices, c.Provider)
			b, _ := json.Marshal(a)
			var got any
			_ = json.Unmarshal(b, &got)
			if diff := compare("advice", c.Expect.Advice, got); diff != "" {
				t.Errorf("advice differs: %s", diff)
			}
			text := RenderTTLAdvice(a, c.Width, Options{Glyphs: GlyphSet(c.Glyphs), Strings: &d.Strings, Display: d.Rules.Display})
			if text != c.Expect.Text {
				t.Errorf("text differs:\n--- got\n%s\n--- want\n%s", text, c.Expect.Text)
			}
		})
	}
}
