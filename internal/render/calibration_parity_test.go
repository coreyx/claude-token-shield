package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreyx/claude-token-shield/internal/summary"
)

// calibrationCase is one fixtures/calibration/*.json file, written by tests/parity/calibration.test.ts.
type calibrationCase struct {
	Name    string                     `json:"name"`
	Width   int                        `json:"width"`
	Glyphs  string                     `json:"glyphs"`
	Records []summary.AssessmentRecord `json:"records"`
	Expect  struct {
		Calibration any    `json:"calibration"`
		Text        string `json:"text"`
	} `json:"expect"`
}

// TestCalibrationParity gives the same calibration and text as the
// TypeScript core for every calibration fixture (AC 14.3, 14.4).
func TestCalibrationParity(t *testing.T) {
	d := shared(t)
	pr := d.Rules.Priors
	priors := summary.Priors{EpsWithin: pr.EpsWithin, EpsAfter: pr.EpsAfter, MinCalibrationN: pr.MinCalibrationN}
	files, _ := filepath.Glob("../../fixtures/calibration/*.json")
	if len(files) == 0 {
		t.Fatal("no calibration fixtures")
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		var c calibrationCase
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		t.Run(c.Name, func(t *testing.T) {
			cal := summary.Calibrate(c.Records, priors)
			b, _ := json.Marshal(cal)
			var got any
			_ = json.Unmarshal(b, &got)
			if diff := compare("calibration", c.Expect.Calibration, got); diff != "" {
				t.Errorf("calibration differs: %s", diff)
			}
			text := RenderCalibration(cal, priors.MinCalibrationN, c.Width, Options{Glyphs: GlyphSet(c.Glyphs), Strings: &d.Strings, Display: d.Rules.Display})
			if text != c.Expect.Text {
				t.Errorf("text differs:\n--- got\n%s\n--- want\n%s", text, c.Expect.Text)
			}
		})
	}
}
