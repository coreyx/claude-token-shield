package cost

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

func prices(t *testing.T) *data.Prices {
	t.Helper()
	d, err := data.Load()
	if err != nil {
		t.Fatal(err)
	}
	return &d.Prices
}

// TestNextTurnWorkedExample checks AC 3.1 on the Go side.
func TestNextTurnWorkedExample(t *testing.T) {
	c := NextTurnCost(Input{PrefixTokens: 812470, Model: "claude-opus-5-5", TTL: "1h", Provider: "firstParty", At: 1.7e12 + 1.2e11}, prices(t))
	if c.USD == nil || math.Abs(c.USD.Cold-6.4998) > 0.01 || c.USD.Warm < 0.16 || c.USD.Warm > 0.18 {
		t.Errorf("got %+v", c.USD)
	}
}

// TestRequestUSD prices a past request with its output, as requestUsd does.
func TestRequestUSD(t *testing.T) {
	r := native.Request{TsStart: 1.79e12, Model: "claude-opus-5-5", Usage: native.RequestUsage{Input: 1000, Read: 100000, Write1h: 2000, Output: 500}}
	got, ok := RequestUSD(r, prices(t))
	want := (1000 + 100000*0.05 + 2000*2 + 500*5) * 4e-6
	if !ok || math.Abs(got-want) > 1e-12 {
		t.Errorf("got %v, want %v", got, want)
	}
	r.Speed = "fast"
	if got, _ := RequestUSD(r, prices(t)); math.Abs(got-want*2) > 1e-12 {
		t.Errorf("fast: got %v", got)
	}
	r.Model = "unknown"
	if _, ok := RequestUSD(r, prices(t)); ok {
		t.Error("an unpriced model should be unknown")
	}
}

// TestShareJSON matches the TypeScript PlanShare union.
func TestShareJSON(t *testing.T) {
	learning, _ := json.Marshal(Share{Status: "learning", Windows: 2})
	estimated, _ := json.Marshal(Share{Status: "estimated", Pct: 3.2, Low: 2, High: 4})
	if string(learning) != `{"status":"learning","windows":2}` {
		t.Errorf("learning: %s", learning)
	}
	if string(estimated) != `{"high":4,"low":2,"pct":3.2,"status":"estimated"}` {
		t.Errorf("estimated: %s", estimated)
	}
}

// TestPresentAndBilling covers the billing modes the parity fixtures don't all reach.
func TestPresentAndBilling(t *testing.T) {
	if p := Present("subscription", false); p.Dollars || !p.PlanShare {
		t.Errorf("subscription: %+v", p)
	}
	if p := Present("provider", false); p.DollarLabel != "cost.provider_priced" {
		t.Errorf("provider: %+v", p)
	}
	for _, prov := range []string{"vertex", "foundry"} {
		if BillingMode(nil, prov) != "provider" {
			t.Errorf("%s should be provider", prov)
		}
	}
}
