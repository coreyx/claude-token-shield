package native

// RequestUsage is one request's token counts by kind.
type RequestUsage struct {
	Input   float64 `json:"input"`
	Read    float64 `json:"read"`
	Write5m float64 `json:"write5m"`
	Write1h float64 `json:"write1h"`
	Output  float64 `json:"output"`
}

// Request is one API request (plugin/core/model/types.ts RequestRecord).
type Request struct {
	ID          string       `json:"id"`
	Lane        string       `json:"lane"`
	TsStart     float64      `json:"tsStart"`
	TsStartTier Tier         `json:"tsStartTier"`
	DurationMs  *float64     `json:"durationMs,omitempty"`
	Model       string       `json:"model"`
	Speed       string       `json:"speed"`
	Effort      string       `json:"effort,omitempty"`
	TTL         string       `json:"ttl,omitempty"`
	Usage       RequestUsage `json:"usage"`
	Source      string       `json:"source"`
}

// EventDetail holds the ids on either side of a change.
type EventDetail struct {
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
}

// Event is something that may affect the cache; its impact comes from the rules.
type Event struct {
	Ts     float64      `json:"ts"`
	Kind   string       `json:"kind"`
	Detail *EventDetail `json:"detail,omitempty"`
}

// Resume holds a resumed or forked session's numbers.
type Resume struct {
	Ts                       float64  `json:"ts"`
	Source                   string   `json:"source"`
	SecondsSinceLastResponse *float64 `json:"secondsSinceLastResponse,omitempty"`
	ContextTokens            *float64 `json:"contextTokens,omitempty"`
	LikelyExpired            *bool    `json:"likelyExpired,omitempty"`
	EstimatedCacheWriteUSD   *float64 `json:"estimatedCacheWriteUsd,omitempty"`
}

// Fact is one input to the reducer; exactly one field is set.
type Fact struct {
	Snapshot *Snapshot
	Request  *Request
	Event    *Event
	Resume   *Resume
}

// State is the session model (plugin/core/model/types.ts SessionState).
type State struct {
	LastSnapshot *Snapshot
	Requests     []Request
	LastTouch    *Request
	Pending      []Event
	Events       []Event
	Resume       *Resume
}

// Log bounds, as in the TypeScript core.
const (
	RequestLogLimit = 200
	EventLogLimit   = 200
)

// Reduce feeds one fact into the state and returns the new state; the input
// is not changed.
func Reduce(s State, f Fact) State {
	switch {
	case f.Snapshot != nil:
		return applySnapshot(s, *f.Snapshot)
	case f.Request != nil:
		return applyRequest(s, *f.Request)
	case f.Event != nil:
		return addEvent(s, *f.Event)
	case f.Resume != nil:
		r := *f.Resume
		s.Resume = &r
	}
	return s
}

// applySnapshot keeps the newest snapshot and records a TTL change between
// two known TTLs (REQ-1.0.3); an older snapshot is ignored.
func applySnapshot(s State, snap Snapshot) State {
	prev := s.LastSnapshot
	if prev != nil && snap.ReceivedAt < prev.ReceivedAt {
		return s
	}
	s.LastSnapshot = &snap
	var from, to string
	if prev != nil && prev.PromptCache != nil && prev.PromptCache.TTL.Known() {
		from = prev.PromptCache.TTL.V
	}
	if snap.PromptCache != nil && snap.PromptCache.TTL.Known() {
		to = snap.PromptCache.TTL.V
	}
	if from != "" && to != "" && from != to {
		return addEvent(s, Event{Ts: snap.ReceivedAt, Kind: "ttl_bucket_change", Detail: &EventDetail{From: from, To: to}})
	}
	return s
}

// applyRequest records a request: main requests join the log and settle the
// events before their start; probes and keep-alives only restart the TTL.
func applyRequest(s State, r Request) State {
	if r.Lane == "subagent" || r.Lane == "compact" {
		return s
	}
	if s.LastTouch == nil || r.TsStart >= s.LastTouch.TsStart {
		touch := r
		s.LastTouch = &touch
	}
	if r.Lane != "main" {
		return s
	}
	s.Requests = bounded(append(append([]Request{}, s.Requests...), r), RequestLogLimit)
	pending := []Event{}
	for _, e := range s.Pending {
		if e.Ts > r.TsStart {
			pending = append(pending, e)
		}
	}
	s.Pending = pending
	return s
}

// addEvent adds an event to the pending list and the bounded log.
func addEvent(s State, e Event) State {
	s.Pending = append(append([]Event{}, s.Pending...), e)
	s.Events = bounded(append(append([]Event{}, s.Events...), e), EventLogLimit)
	return s
}

// bounded keeps the newest limit entries.
func bounded[T any](items []T, limit int) []T {
	if len(items) > limit {
		return items[len(items)-limit:]
	}
	return items
}
