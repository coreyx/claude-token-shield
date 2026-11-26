package summary

import (
	"math"
	"sort"
)

// AssessmentRecord is the assessment that preceded one main request, and
// what the request found (plugin/core/history/calibrate.ts).
type AssessmentRecord struct {
	Ts           float64    `json:"ts"`
	State        string     `json:"state"`
	PHit         float64    `json:"pHit"`
	Interval     [2]float64 `json:"interval"`
	TTL          *string    `json:"ttl"`
	RemainingSec *float64   `json:"remainingSec"`
	MarginSec    float64    `json:"marginSec"`
	CCVersion    *string    `json:"ccVersion"`
	Model        *string    `json:"model"`
	Outcome      string     `json:"outcome"`
}

// Bucket is one reliability-table row.
type Bucket struct {
	State         string     `json:"state"`
	TTL           *string    `json:"ttl"`
	Band          string     `json:"band"`
	N             int        `json:"n"`
	MeanPredicted float64    `json:"meanPredicted"`
	Observed      float64    `json:"observed"`
	Wilson        [2]float64 `json:"wilson"`
}

// BrierGroup is the Brier score of one Claude Code version × model × TTL.
type BrierGroup struct {
	CCVersion *string `json:"ccVersion"`
	Model     *string `json:"model"`
	TTL       *string `json:"ttl"`
	N         int     `json:"n"`
	Brier     float64 `json:"brier"`
}

// Priors are the rates calibration falls back on, from rules.json.
type Priors struct {
	EpsWithin, EpsAfter float64
	MinCalibrationN     int
}

// HotStats is what the HOT predictions found.
type HotStats struct {
	N           int      `json:"n"`
	MissRate    *float64 `json:"missRate"`
	StatedUpper *float64 `json:"statedUpper"`
}

// LearnedRates are rates for the assessor.
type LearnedRates struct {
	EpsWithin float64 `json:"epsWithin"`
	EpsAfter  float64 `json:"epsAfter"`
	N         int     `json:"n"`
	Drift     bool    `json:"drift"`
}

// Calibration is what calibration found.
type Calibration struct {
	N       int          `json:"n"`
	Buckets []Bucket     `json:"buckets"`
	Brier   *float64     `json:"brier"`
	BrierBy []BrierGroup `json:"brierBy"`
	Hot     HotStats     `json:"hot"`
	Drift   bool         `json:"drift"`
	Learned LearnedRates `json:"learned"`
}

const z = 1.96

var bandOrder = []string{"over_10m", "1_10m", "margin", "past", "unknown"}
var stateOrder = []string{"HOT", "EXPIRING", "UNCERTAIN", "INVALIDATED", "COLD", "UNKNOWN"}

func indexOf(list []string, v string) int {
	for i, s := range list {
		if s == v {
			return i
		}
	}
	return len(list)
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Wilson is a 95% Wilson score interval for k successes in n trials.
func Wilson(k, n float64) [2]float64 {
	if n == 0 {
		return [2]float64{0, 1}
	}
	p := k / n
	z2 := z * z
	centre := (p + z2/(2*n)) / (1 + z2/n)
	half := (z * math.Sqrt(p*(1-p)/n+z2/(4*n*n))) / (1 + z2/n)
	return [2]float64{math.Max(0, centre-half), math.Min(1, centre+half)}
}

// BandOf is the band a prediction falls in.
func BandOf(remaining *float64, margin float64) string {
	switch {
	case remaining == nil:
		return "unknown"
	case *remaining < -margin:
		return "past"
	case math.Abs(*remaining) <= margin:
		return "margin"
	case *remaining <= 600:
		return "1_10m"
	}
	return "over_10m"
}

func wasRead(outcome string) float64 {
	if outcome == "MISS" {
		return 0
	}
	return 1
}

// Calibrate calibrates the recorded predictions (design D19).
func Calibrate(records []AssessmentRecord, p Priors) Calibration {
	type group struct {
		state, band     string
		ttl             *string
		n               int
		predicted, read float64
	}
	type bgroup struct {
		ccVersion, model, ttl *string
		n                     int
		sum                   float64
	}
	groups := map[string]*group{}
	gorder := []string{}
	bgroups := map[string]*bgroup{}
	border := []string{}
	brierSum := 0.0
	for _, r := range records {
		band := BandOf(r.RemainingSec, r.MarginSec)
		key := r.State + "|" + str(r.TTL) + "|" + band
		g, ok := groups[key]
		if !ok {
			g = &group{state: r.State, band: band, ttl: r.TTL}
			groups[key] = g
			gorder = append(gorder, key)
		}
		g.n++
		g.predicted += r.PHit
		g.read += wasRead(r.Outcome)
		sq := math.Pow(r.PHit-wasRead(r.Outcome), 2)
		brierSum += sq
		bkey := str(r.CCVersion) + "|" + str(r.Model) + "|" + str(r.TTL)
		b, ok := bgroups[bkey]
		if !ok {
			b = &bgroup{ccVersion: r.CCVersion, model: r.Model, ttl: r.TTL}
			bgroups[bkey] = b
			border = append(border, bkey)
		}
		b.n++
		b.sum += sq
	}
	c := Calibration{N: len(records), Buckets: []Bucket{}, BrierBy: []BrierGroup{}}
	for _, k := range gorder {
		g := groups[k]
		n := float64(g.n)
		c.Buckets = append(c.Buckets, Bucket{State: g.state, TTL: g.ttl, Band: g.band, N: g.n, MeanPredicted: g.predicted / n, Observed: g.read / n, Wilson: Wilson(g.read, n)})
	}
	sort.SliceStable(c.Buckets, func(a, b int) bool {
		x, y := c.Buckets[a], c.Buckets[b]
		if d := indexOf(stateOrder, x.State) - indexOf(stateOrder, y.State); d != 0 {
			return d < 0
		}
		if str(x.TTL) != str(y.TTL) {
			return str(x.TTL) < str(y.TTL)
		}
		return indexOf(bandOrder, x.Band) < indexOf(bandOrder, y.Band)
	})
	sort.Strings(border)
	for _, k := range border {
		b := bgroups[k]
		c.BrierBy = append(c.BrierBy, BrierGroup{CCVersion: b.ccVersion, Model: b.model, TTL: b.ttl, N: b.n, Brier: b.sum / float64(b.n)})
	}
	if len(records) > 0 {
		v := brierSum / float64(len(records))
		c.Brier = &v
	}

	hotN, hotMisses, lowerSum := 0, 0, 0.0
	for _, r := range records {
		if r.State == "HOT" {
			hotN++
			lowerSum += r.Interval[0]
			if r.Outcome == "MISS" {
				hotMisses++
			}
		}
	}
	c.Hot.N = hotN
	if hotN > 0 {
		m := float64(hotMisses) / float64(hotN)
		u := 1 - lowerSum/float64(hotN)
		c.Hot.MissRate, c.Hot.StatedUpper = &m, &u
	}
	enoughHot := hotN >= p.MinCalibrationN
	c.Drift = enoughHot && c.Hot.MissRate != nil && *c.Hot.MissRate > *c.Hot.StatedUpper

	// Observed rates are floored at a tenth of the prior: a run with no misses
	// at all must not claim certainty the assessor would then repeat.
	epsWithin := p.EpsWithin
	if enoughHot && c.Hot.MissRate != nil {
		if c.Drift {
			epsWithin = Wilson(float64(hotMisses), float64(hotN))[1]
		} else {
			epsWithin = math.Max(*c.Hot.MissRate, p.EpsWithin/10)
		}
	}
	afterN, afterRead := 0, 0
	for _, r := range records {
		if r.State == "COLD" || BandOf(r.RemainingSec, r.MarginSec) == "past" {
			afterN++
			if r.Outcome != "MISS" {
				afterRead++
			}
		}
	}
	epsAfter := p.EpsAfter
	if afterN >= p.MinCalibrationN {
		epsAfter = math.Max(float64(afterRead)/float64(afterN), p.EpsAfter/10)
	}
	c.Learned = LearnedRates{EpsWithin: epsWithin, EpsAfter: epsAfter, N: len(records), Drift: c.Drift}
	return c
}
