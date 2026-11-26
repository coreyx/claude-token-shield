package native

// Payload rebuilds a statusline payload from a parsed snapshot: only the
// documented fields that parsed, in their documented shape and units. The
// bridge stores this, not the raw input, so paths, names and anything else
// the statusline JSON carries never reach the data directory (REQ-1.0.2);
// both the mod and tshield then parse it with their own ParseSnapshot.
//
// A field that was explicitly null stays null, so "absent: null" survives the
// round trip; missing and malformed fields are left out.
func Payload(s Snapshot) map[string]any {
	p := map[string]any{}
	putString(p, "session_id", s.SessionID)
	putString(p, "version", s.CCVersion)
	if s.Model.Known() {
		p["model"] = map[string]any{"id": s.Model.V}
	}
	if s.Effort.Known() {
		p["effort"] = map[string]any{"level": s.Effort.V}
	}
	putBool(p, "fast_mode", s.FastMode)
	if s.CurrentUsage.Known() {
		u := s.CurrentUsage.V
		p["context_window"] = map[string]any{"current_usage": map[string]any{
			"input_tokens": u.Input, "cache_read_input_tokens": u.Read, "cache_creation_input_tokens": u.Write, "output_tokens": u.Output,
		}}
	} else if s.CurrentUsage.Reason == "null" {
		p["context_window"] = map[string]any{"current_usage": nil}
	}
	limits := map[string]any{}
	putWindow(limits, "five_hour", s.FiveHour)
	putWindow(limits, "seven_day", s.SevenDay)
	if len(limits) > 0 {
		p["rate_limits"] = limits
	}
	if pc := s.PromptCache; pc != nil {
		c := map[string]any{}
		putBool(c, "warm", pc.Warm)
		putBool(c, "caching_observed", pc.CachingObserved)
		putString(c, "ttl", pc.TTL)
		putSeconds(c, "expires_at", pc.ExpiresAt)
		putNumber(c, "requests", pc.Requests)
		putNumber(c, "misses", pc.Misses)
		putNumber(c, "expected_rebuilds", pc.ExpectedRebuilds)
		putNumber(c, "hit_ratio", pc.HitRatio)
		putNumber(c, "cache_write_tokens", pc.CacheWriteTokens)
		putNumber(c, "miss_recache_tokens", pc.MissRecacheTokens)
		putNumber(c, "recache_tokens_if_cold", pc.RecacheTokensIfCold)
		putSeconds(c, "last_miss_at", pc.LastMissAt)
		if pc.LastMissCause.Known() {
			mc := pc.LastMissCause.V
			m := map[string]any{"causes": mc.Causes}
			if mc.ToolsAdded != nil {
				m["tools_added"] = *mc.ToolsAdded
			}
			if mc.ToolsRemoved != nil {
				m["tools_removed"] = *mc.ToolsRemoved
			}
			if mc.SystemCharDelta != nil {
				m["system_char_delta"] = *mc.SystemCharDelta
			}
			c["last_miss_cause"] = m
		} else if pc.LastMissCause.Reason == "null" {
			c["last_miss_cause"] = nil
		}
		if pc.MissCauses.Known() {
			c["miss_causes"] = pc.MissCauses.V
		} else if pc.MissCauses.Reason == "null" {
			c["miss_causes"] = nil
		}
		p["prompt_cache"] = c
	}
	return p
}

func putString(m map[string]any, key string, v Value[string]) {
	if v.Known() {
		m[key] = v.V
	} else if v.Reason == "null" {
		m[key] = nil
	}
}

func putBool(m map[string]any, key string, v Value[bool]) {
	if v.Known() {
		m[key] = v.V
	} else if v.Reason == "null" {
		m[key] = nil
	}
}

func putNumber(m map[string]any, key string, v Value[float64]) {
	if v.Known() {
		m[key] = v.V
	} else if v.Reason == "null" {
		m[key] = nil
	}
}

// putSeconds writes an epoch-ms value back as the statusline's epoch seconds.
func putSeconds(m map[string]any, key string, v Value[float64]) {
	if v.Known() {
		m[key] = v.V / 1000
	} else if v.Reason == "null" {
		m[key] = nil
	}
}

func putWindow(m map[string]any, key string, v Value[RateWindow]) {
	if v.Known() {
		m[key] = map[string]any{"used_percentage": v.V.UsedPercentage, "resets_at": v.V.ResetsAt / 1000}
	} else if v.Reason == "null" {
		m[key] = nil
	}
}
