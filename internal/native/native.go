// Package native holds the session model the Go companions share with the
// mod's TypeScript core (plugin/core/model): tier-tagged values, the parsed
// statusline snapshot, request and event records, and the reducer.
//
// Each function mirrors its TypeScript counterpart line for line; the parity
// fixtures in fixtures/parity hold the two to the same answers. Times are
// epoch milliseconds throughout.
package native

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Tier says how a value is known: "measured", "inferred" or "estimated", or
// "absent" when it isn't known at all (never zero-filled, REQ-1.0.7).
type Tier string

// The tiers.
const (
	Measured  Tier = "measured"
	Inferred  Tier = "inferred"
	Estimated Tier = "estimated"
	Absent    Tier = "absent"
)

// Value is a value with its tier; Reason says why it is absent ("missing",
// "null" or "malformed").
type Value[T any] struct {
	Tier   Tier
	V      T
	Reason string
}

// Known reports whether the value is present.
func (v Value[T]) Known() bool { return v.Tier != Absent }

// Of returns a present value with its tier.
func Of[T any](tier Tier, v T) Value[T] { return Value[T]{Tier: tier, V: v} }

// None returns an absent value with its reason.
func None[T any](reason string) Value[T] { return Value[T]{Tier: Absent, Reason: reason} }

// MissCause is Claude Code's diagnosis of the most recent miss.
type MissCause struct {
	Causes          []string
	ToolsAdded      *float64
	ToolsRemoved    *float64
	SystemCharDelta *float64
}

// PromptCache is the statusline's prompt_cache object, whitelisted.
type PromptCache struct {
	Warm                Value[bool]
	CachingObserved     Value[bool]
	TTL                 Value[string]
	ExpiresAt           Value[float64]
	Requests            Value[float64]
	Misses              Value[float64]
	ExpectedRebuilds    Value[float64]
	HitRatio            Value[float64]
	CacheWriteTokens    Value[float64]
	MissRecacheTokens   Value[float64]
	RecacheTokensIfCold Value[float64]
	LastMissAt          Value[float64]
	LastMissCause       Value[MissCause]
	MissCauses          Value[map[string]float64]
}

// Usage is one response's token counts.
type Usage struct{ Input, Read, Write, Output float64 }

// RateWindow is a subscription usage window; ResetsAt is epoch ms.
type RateWindow struct{ UsedPercentage, ResetsAt float64 }

// Snapshot is one statusline payload reduced to ids, numbers, times, enums and
// cause names (REQ-1.0.2). PromptCache is nil before the first response.
type Snapshot struct {
	ReceivedAt   float64
	SessionID    Value[string]
	CCVersion    Value[string]
	Model        Value[string]
	Effort       Value[string]
	FastMode     Value[bool]
	PromptCache  *PromptCache
	CurrentUsage Value[Usage]
	FiveHour     Value[RateWindow]
	SevenDay     Value[RateWindow]
}

var (
	modelID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/\[\]-]{0,127}$`)
	sessionID = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)
	version   = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	cause     = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
	efforts   = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}
	ttls      = map[string]bool{"5m": true, "1h": true}
)

// ParseSnapshot parses one raw statusline payload (JSON), copying only
// documented fields. A payload that isn't a JSON object counts as empty.
func ParseSnapshot(raw []byte, receivedAt float64) Snapshot {
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil {
		root = map[string]any{}
	}
	return ParseSnapshotMap(root, receivedAt)
}

// ParseSnapshotMap parses an already-decoded payload.
func ParseSnapshotMap(root map[string]any, receivedAt float64) Snapshot {
	if root == nil {
		root = map[string]any{}
	}
	s := Snapshot{ReceivedAt: receivedAt}
	s.SessionID = pattern(get(root, "session_id"), sessionID, Measured)
	s.CCVersion = pattern(get(root, "version"), version, Measured)
	m, _ := root["model"].(map[string]any)
	s.Model = pattern(get(m, "id"), modelID, Measured)
	e, _ := root["effort"].(map[string]any)
	s.Effort = enum(get(e, "level"), efforts)
	s.FastMode = boolean(get(root, "fast_mode"), Measured)
	if pc, ok := root["prompt_cache"].(map[string]any); ok {
		p := parsePromptCache(pc)
		s.PromptCache = &p
	}
	if cw, ok := root["context_window"].(map[string]any); ok {
		s.CurrentUsage = usage(get(cw, "current_usage"))
	} else {
		s.CurrentUsage = None[Usage]("missing")
	}
	limits, _ := root["rate_limits"].(map[string]any)
	s.FiveHour = rateWindow(get(limits, "five_hour"))
	s.SevenDay = rateWindow(get(limits, "seven_day"))
	return s
}

// field is a raw value and whether its key was present.
type field struct {
	v       any
	present bool
}

// get reads a key from a possibly nil object.
func get(m map[string]any, key string) field {
	if m == nil {
		return field{}
	}
	v, ok := m[key]
	return field{v, ok}
}

// why is the absence for a value that failed its check.
func why[T any](f field) Value[T] {
	if !f.present {
		return None[T]("missing")
	}
	if f.v == nil {
		return None[T]("null")
	}
	return None[T]("malformed")
}

// count reports whether v is a finite number of 0 or more.
func count(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && f >= 0 && f == f && f < 1e300
}

func pattern(f field, re *regexp.Regexp, tier Tier) Value[string] {
	if s, ok := f.v.(string); ok && re.MatchString(s) {
		return Of(tier, s)
	}
	return why[string](f)
}

func enum(f field, allowed map[string]bool) Value[string] {
	if s, ok := f.v.(string); ok && allowed[s] {
		return Of(Measured, s)
	}
	return why[string](f)
}

func boolean(f field, tier Tier) Value[bool] {
	if b, ok := f.v.(bool); ok {
		return Of(tier, b)
	}
	return why[bool](f)
}

func number(f field, tier Tier) Value[float64] {
	if n, ok := count(f.v); ok {
		return Of(tier, n)
	}
	return why[float64](f)
}

func fraction(f field) Value[float64] {
	if n, ok := count(f.v); ok && n <= 1 {
		return Of(Measured, n)
	}
	return why[float64](f)
}

// epochSeconds converts the statusline's epoch seconds to epoch ms; zero is not a time.
func epochSeconds(f field, tier Tier) Value[float64] {
	if n, ok := count(f.v); ok && n > 0 {
		return Of(tier, n*1000)
	}
	return why[float64](f)
}

func parsePromptCache(pc map[string]any) PromptCache {
	ttl := enum(get(pc, "ttl"), ttls)
	return PromptCache{
		Warm:                boolean(get(pc, "warm"), Inferred),
		CachingObserved:     boolean(get(pc, "caching_observed"), Measured),
		TTL:                 ttl,
		ExpiresAt:           epochSeconds(get(pc, "expires_at"), Inferred),
		Requests:            number(get(pc, "requests"), Measured),
		Misses:              number(get(pc, "misses"), Measured),
		ExpectedRebuilds:    number(get(pc, "expected_rebuilds"), Measured),
		HitRatio:            fraction(get(pc, "hit_ratio")),
		CacheWriteTokens:    number(get(pc, "cache_write_tokens"), Measured),
		MissRecacheTokens:   number(get(pc, "miss_recache_tokens"), Measured),
		RecacheTokensIfCold: number(get(pc, "recache_tokens_if_cold"), Inferred),
		LastMissAt:          epochSeconds(get(pc, "last_miss_at"), Measured),
		LastMissCause:       missCause(get(pc, "last_miss_cause")),
		MissCauses:          missCauses(get(pc, "miss_causes")),
	}
}

func usage(f field) Value[Usage] {
	m, ok := f.v.(map[string]any)
	if !ok {
		return why[Usage](f)
	}
	in, ok1 := count(m["input_tokens"])
	rd, ok2 := count(m["cache_read_input_tokens"])
	wr, ok3 := count(m["cache_creation_input_tokens"])
	out, ok4 := count(m["output_tokens"])
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return None[Usage]("malformed")
	}
	return Of(Measured, Usage{Input: in, Read: rd, Write: wr, Output: out})
}

func rateWindow(f field) Value[RateWindow] {
	m, ok := f.v.(map[string]any)
	if !ok {
		return why[RateWindow](f)
	}
	used, ok1 := count(m["used_percentage"])
	resets, ok2 := count(m["resets_at"])
	if !ok1 || !ok2 || resets == 0 {
		return None[RateWindow]("malformed")
	}
	return Of(Measured, RateWindow{UsedPercentage: used, ResetsAt: resets * 1000})
}

func missCause(f field) Value[MissCause] {
	m, ok := f.v.(map[string]any)
	if !ok {
		return why[MissCause](f)
	}
	raw, ok := m["causes"].([]any)
	if !ok || len(raw) == 0 {
		return None[MissCause]("malformed")
	}
	mc := MissCause{}
	for _, c := range raw {
		s, ok := c.(string)
		if !ok || !cause.MatchString(s) {
			return None[MissCause]("malformed")
		}
		mc.Causes = append(mc.Causes, s)
	}
	if n, ok := count(m["tools_added"]); ok {
		mc.ToolsAdded = &n
	}
	if n, ok := count(m["tools_removed"]); ok {
		mc.ToolsRemoved = &n
	}
	// A system prompt can shrink, so the delta may be negative.
	if n, ok := m["system_char_delta"].(float64); ok {
		mc.SystemCharDelta = &n
	}
	return Of(Inferred, mc)
}

func missCauses(f field) Value[map[string]float64] {
	m, ok := f.v.(map[string]any)
	if !ok {
		return why[map[string]float64](f)
	}
	out := map[string]float64{}
	for name, v := range m {
		n, ok := count(v)
		if !cause.MatchString(name) || !ok {
			return None[map[string]float64]("malformed")
		}
		out[name] = n
	}
	return Of(Inferred, out)
}

var (
	sizeSuffix    = regexp.MustCompile(`\[[^\]]*\]$`)
	vertexSuffix  = regexp.MustCompile(`@.*$`)
	bedrockSuffix = regexp.MustCompile(`-v\d+(:\d+)?$`)
	dateSuffix    = regexp.MustCompile(`-\d{8}$`)
)

// BaseModelID reduces a model id to the base id the data files use, as
// baseModelId does in plugin/core/model/ids.ts.
func BaseModelID(id string) string {
	s := strings.ToLower(strings.TrimSpace(id))
	s = sizeSuffix.ReplaceAllString(s, "")
	if at := strings.Index(s, "claude-"); at > 0 {
		s = s[at:]
	}
	s = vertexSuffix.ReplaceAllString(s, "")
	s = bedrockSuffix.ReplaceAllString(s, "")
	return dateSuffix.ReplaceAllString(s, "")
}

var versionPrefix = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)`)

// CompareVersions compares two major.minor.patch versions; ok is false when
// either isn't a version.
func CompareVersions(a, b string) (cmp int, ok bool) {
	pa := versionPrefix.FindStringSubmatch(strings.TrimSpace(a))
	pb := versionPrefix.FindStringSubmatch(strings.TrimSpace(b))
	if pa == nil || pb == nil {
		return 0, false
	}
	for i := 1; i <= 3; i++ {
		x, y := atoi(pa[i]), atoi(pb[i])
		if x != y {
			return x - y, true
		}
	}
	return 0, true
}

// atoi parses a string of digits.
func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}
