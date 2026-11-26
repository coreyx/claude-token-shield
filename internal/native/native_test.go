package native

import (
	"strings"
	"testing"
)

// TestParseSnapshotWhitelist keeps paths and names out of the parsed snapshot (REQ-1.0.2).
func TestParseSnapshotWhitelist(t *testing.T) {
	raw := `{"cwd":"/home/example/project","session_name":"example title","model":{"id":"claude-opus-5-5","display_name":"Opus"},
	"version":"2.1.332","prompt_cache":{"warm":true,"ttl":"1h","expires_at":1767283200,"last_miss_cause":{"causes":["tools_changed"],"tools_added":1,"system_char_delta":-5},"miss_causes":{"tools_changed":1}}}`
	s := ParseSnapshot([]byte(raw), 1)
	if s.PromptCache == nil || s.PromptCache.ExpiresAt.V != 1767283200000 || s.Model.V != "claude-opus-5-5" {
		t.Fatalf("parsed %+v", s)
	}
	mc := s.PromptCache.LastMissCause.V
	if *mc.ToolsAdded != 1 || *mc.SystemCharDelta != -5 || mc.ToolsRemoved != nil {
		t.Errorf("miss cause %+v", mc)
	}
	if got := ParseSnapshot([]byte("not json"), 1); got.PromptCache != nil || got.Model.Reason != "missing" {
		t.Errorf("non-JSON payload: %+v", got)
	}
}

// TestParseSnapshotAbsence never zero-fills (REQ-1.0.7).
func TestParseSnapshotAbsence(t *testing.T) {
	cases := map[string]string{
		`{"prompt_cache":{"expires_at":null}}`:                         "null",
		`{"prompt_cache":{"expires_at":0}}`:                            "malformed",
		`{"prompt_cache":{}}`:                                          "missing",
		`{"prompt_cache":{"expires_at":"soon"}}`:                       "malformed",
		`{"prompt_cache":{"last_miss_cause":{"causes":["Bad Name"]}}}`: "",
	}
	for raw, reason := range cases {
		s := ParseSnapshotMap(nil, 0)
		if s.Model.Reason != "missing" {
			t.Error("nil map should parse as empty")
		}
		s = ParseSnapshot([]byte(raw), 0)
		if reason != "" && (s.PromptCache.ExpiresAt.Known() || s.PromptCache.ExpiresAt.Reason != reason) {
			t.Errorf("%s: %+v", raw, s.PromptCache.ExpiresAt)
		}
		if strings.Contains(raw, "Bad Name") && s.PromptCache.LastMissCause.Reason != "malformed" {
			t.Errorf("%s: cause should be malformed", raw)
		}
	}
	bad := ParseSnapshot([]byte(`{"context_window":{"current_usage":{"input_tokens":1}},"rate_limits":{"five_hour":{"used_percentage":5,"resets_at":0}},"prompt_cache":{"miss_causes":{"x":-1},"hit_ratio":2}}`), 0)
	if bad.CurrentUsage.Reason != "malformed" || bad.FiveHour.Reason != "malformed" || bad.PromptCache.MissCauses.Reason != "malformed" || bad.PromptCache.HitRatio.Known() {
		t.Errorf("malformed fields: %+v", bad)
	}
}

// TestReduce covers the paths the parity fixtures don't: TTL changes, resume, older snapshots and other lanes.
func TestReduce(t *testing.T) {
	snap := func(at float64, ttl string) Fact {
		s := ParseSnapshot([]byte(`{"prompt_cache":{"ttl":"`+ttl+`"}}`), at)
		return Fact{Snapshot: &s}
	}
	s := State{}
	for _, f := range []Fact{snap(1, "1h"), snap(2, "1h"), snap(3, "5m"), snap(2.5, "1h")} {
		s = Reduce(s, f)
	}
	if len(s.Events) != 1 || s.Events[0].Kind != "ttl_bucket_change" || s.LastSnapshot.ReceivedAt != 3 {
		t.Errorf("ttl change: %+v", s.Events)
	}
	s = Reduce(s, Fact{Resume: &Resume{Ts: 5, Source: "resume"}})
	s = Reduce(s, Fact{Request: &Request{Lane: "subagent", TsStart: 9}})
	s = Reduce(s, Fact{Request: &Request{Lane: "probe", TsStart: 8}})
	s = Reduce(s, Fact{})
	if s.Resume == nil || s.LastTouch == nil || s.LastTouch.Lane != "probe" || len(s.Requests) != 0 || len(s.Pending) != 1 {
		t.Errorf("state %+v", s)
	}
	for i := 0; i < RequestLogLimit+2; i++ {
		s = Reduce(s, Fact{Request: &Request{Lane: "main", TsStart: float64(10 + i)}})
	}
	if len(s.Requests) != RequestLogLimit || len(s.Pending) != 0 {
		t.Errorf("log %d, pending %d", len(s.Requests), len(s.Pending))
	}
}

// TestIDs mirrors the TypeScript id helpers.
func TestIDs(t *testing.T) {
	for in, want := range map[string]string{
		"us.anthropic.claude-opus-5-5-v1:0": "claude-opus-5-5",
		"claude-opus-5-5[1m]":               "claude-opus-5-5",
		"claude-haiku-4-5-20251001":         "claude-haiku-4-5",
		"claude-sonnet-5@20260101":          "claude-sonnet-5",
	} {
		if got := BaseModelID(in); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	if c, ok := CompareVersions("2.1.259", "2.1.260"); !ok || c >= 0 {
		t.Error("2.1.259 < 2.1.260")
	}
	if _, ok := CompareVersions("latest", "2.1.260"); ok {
		t.Error("non-version should not compare")
	}
	if c, _ := CompareVersions("2.1.260-beta", "2.1.260"); c != 0 {
		t.Error("suffix is ignored")
	}
}
