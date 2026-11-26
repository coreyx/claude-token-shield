// Package data loads the shared data files the plugin ships in plugin/data:
// prices, assessment rules and the user-facing string catalog. The Go
// companions read the copies embedded at build time, so the CLI and the
// statusline bridge price, classify and word things exactly as the mod does.
//
// The shapes mirror plugin/core/data/types.ts, and both meet the JSON Schemas
// under schemas/.
package data

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"

	shielddata "github.com/coreyx/claude-token-shield"
)

// Version is the data-file format version this code understands.
const Version = 1

// ModelPrice holds one model's rates: Input in USD per million tokens, the
// others as multiples of it.
type ModelPrice struct {
	Input       float64     `json:"input"`
	ReadMult    float64     `json:"read_mult"`
	Write5mMult float64     `json:"write_5m_mult"`
	Write1hMult float64     `json:"write_1h_mult"`
	OutputMult  float64     `json:"output_mult"`
	FastInput   *float64    `json:"fast_input,omitempty"`
	Tiers       []PriceTier `json:"tiers,omitempty"`
}

// PriceTier prices every token of a prompt larger than Above tokens at Input.
type PriceTier struct {
	Above int     `json:"above"`
	Input float64 `json:"input"`
}

// ProviderPrice says how a provider's prices relate to Anthropic's list
// prices; Basis is "list" or "estimated".
type ProviderPrice struct {
	Multiplier         float64  `json:"multiplier"`
	RegionalMultiplier *float64 `json:"regional_multiplier,omitempty"`
	DataZoneMultiplier *float64 `json:"data_zone_multiplier,omitempty"`
	Basis              string   `json:"basis"`
}

// PriceTable is one dated table; Effective is its first day, YYYY-MM-DD.
type PriceTable struct {
	Effective string                   `json:"effective"`
	Source    string                   `json:"source,omitempty"`
	Models    map[string]ModelPrice    `json:"models"`
	Providers map[string]ProviderPrice `json:"providers"`
}

// Prices is prices.json: every price table, kept by date.
type Prices struct {
	V      int          `json:"v"`
	Unit   string       `json:"unit"`
	Tables []PriceTable `json:"tables"`
}

// RuleCondition narrows when an event's impact differs from its default; every
// set field must match.
type RuleCondition struct {
	PerMessageEffort          *bool    `json:"perMessageEffort,omitempty"`
	ToolSearch                *bool    `json:"toolSearch,omitempty"`
	ExperimentalBetasDisabled *bool    `json:"experimentalBetasDisabled,omitempty"`
	Provider                  []string `json:"provider,omitempty"`
}

// RuleCase is one exception to an event's default impact.
type RuleCase struct {
	When   RuleCondition `json:"when"`
	Impact string        `json:"impact"`
}

// EventRule is one row of the invalidation table. The first matching case
// wins; otherwise Impact applies.
type EventRule struct {
	Kind            string     `json:"kind"`
	Impact          string     `json:"impact"`
	Basis           string     `json:"basis"`
	ExpectedRebuild bool       `json:"expectedRebuild,omitempty"`
	Note            string     `json:"note,omitempty"`
	Cases           []RuleCase `json:"cases,omitempty"`
}

// Rules is rules.json: the parts of the assessment algorithm that are data.
type Rules struct {
	V                      int            `json:"v"`
	MinClaudeCodeVersion   string         `json:"minClaudeCodeVersion"`
	PerMessageEffortModels []string       `json:"perMessageEffortModels"`
	Events                 []EventRule    `json:"events"`
	WarnWindowsSec         map[string]int `json:"warnWindowsSec"`
	Timing                 struct {
		SkewSec           float64 `json:"skewSec"`
		BaseMarginSec     float64 `json:"baseMarginSec"`
		NativeTimeErrSec  float64 `json:"nativeTimeErrSec"`
		StaleSnapshotSec  float64 `json:"staleSnapshotSec"`
		HeartbeatFreshSec float64 `json:"heartbeatFreshSec"`
	} `json:"timing"`
	Priors struct {
		EpsWithin float64 `json:"epsWithin"`
		EpsAfter  float64 `json:"epsAfter"`
		MayEvent  struct {
			Alpha float64 `json:"alpha"`
			Beta  float64 `json:"beta"`
		} `json:"mayEvent"`
		MinCalibrationN int `json:"minCalibrationN"`
	} `json:"priors"`
	Display struct {
		MaxProb float64 `json:"maxProb"`
		MinProb float64 `json:"minProb"`
	} `json:"display"`
}

// CatalogString is one catalog entry; Tense is "future", "past" or "none".
type CatalogString struct {
	Text  string `json:"text"`
	Tense string `json:"tense"`
}

// Strings is a string catalog such as strings.en.json.
type Strings struct {
	V       int                      `json:"v"`
	Locale  string                   `json:"locale"`
	Strings map[string]CatalogString `json:"strings"`
}

// Shared is the three files together.
type Shared struct {
	Prices  Prices
	Rules   Rules
	Strings Strings
}

// File names inside plugin/data, as embedded.
const (
	PricesFile  = "plugin/data/prices.json"
	RulesFile   = "plugin/data/rules.json"
	StringsFile = "plugin/data/strings.en.json"
)

// Load parses and checks the embedded copies of the three files.
func Load() (*Shared, error) {
	return LoadFS(shielddata.Files)
}

// LoadFS parses and checks the three files from fsys, which holds them at the
// paths named by PricesFile, RulesFile and StringsFile. Tests pass edited copies.
func LoadFS(fsys fs.FS) (*Shared, error) {
	var s Shared
	if err := decode(fsys, PricesFile, &s.Prices); err != nil {
		return nil, err
	}
	if err := decode(fsys, RulesFile, &s.Rules); err != nil {
		return nil, err
	}
	if err := decode(fsys, StringsFile, &s.Strings); err != nil {
		return nil, err
	}
	if err := s.check(); err != nil {
		return nil, err
	}
	return &s, nil
}

// decode reads one file strictly: an unknown field is an error, because the
// shipped files and this code are released together.
func decode(fsys fs.FS, name string, into any) error {
	raw, err := fs.ReadFile(fsys, name)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

var datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// check enforces the invariants the companions rely on, matching the
// TypeScript loader's checks.
func (s *Shared) check() error {
	if s.Prices.V != Version || s.Rules.V != Version || s.Strings.V != Version {
		return fmt.Errorf("data: unsupported version (prices %d, rules %d, strings %d; expected %d)",
			s.Prices.V, s.Rules.V, s.Strings.V, Version)
	}
	if len(s.Prices.Tables) == 0 {
		return fmt.Errorf("%s: tables: needs at least one table", PricesFile)
	}
	for i, t := range s.Prices.Tables {
		if !datePattern.MatchString(t.Effective) {
			return fmt.Errorf("%s: tables[%d].effective: must be a YYYY-MM-DD date", PricesFile, i)
		}
		for id, m := range t.Models {
			if m.Input <= 0 || m.ReadMult <= 0 || m.Write5mMult <= 0 || m.Write1hMult <= 0 || m.OutputMult <= 0 {
				return fmt.Errorf("%s: tables[%d].models.%s: rates must be above 0", PricesFile, i, id)
			}
		}
	}
	seen := map[string]bool{}
	for i, e := range s.Rules.Events {
		if seen[e.Kind] {
			return fmt.Errorf("%s: events[%d].kind: duplicate kind %q", RulesFile, i, e.Kind)
		}
		seen[e.Kind] = true
	}
	if s.Rules.Display.MinProb >= s.Rules.Display.MaxProb {
		return fmt.Errorf("%s: display: minProb must be below maxProb", RulesFile)
	}
	return nil
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// Format looks up a catalog string and fills its {placeholders}. A missing key
// shows as [key] and a missing placeholder stays as written, the same as the
// TypeScript formatString, so a gap is visible rather than hidden.
func (s *Strings) Format(key string, params map[string]string) string {
	entry, ok := s.Strings[key]
	if !ok {
		return "[" + key + "]"
	}
	return placeholder.ReplaceAllStringFunc(entry.Text, func(whole string) string {
		if v, ok := params[whole[1:len(whole)-1]]; ok {
			return v
		}
		return whole
	})
}
