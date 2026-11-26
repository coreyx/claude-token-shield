package summary

import "testing"

// TestClassify covers the edges the fixtures don't: an empty prefix and the 95% and 5% lines.
func TestClassify(t *testing.T) {
	cases := []struct {
		read, prefix float64
		want         string
	}{
		{0, 0, "MISS"}, {10, 0, "HIT"}, {95, 100, "HIT"}, {94, 100, "PARTIAL"}, {5, 100, "MISS"}, {6, 100, "PARTIAL"},
	}
	for _, c := range cases {
		if got := Classify(c.read, c.prefix); got != c.want {
			t.Errorf("Classify(%v, %v) = %s, want %s", c.read, c.prefix, got, c.want)
		}
	}
}

// TestSinceRange reads days and hours, defaults to 30 days, and refuses the rest.
func TestSinceRange(t *testing.T) {
	if r, ok := SinceRange("12h", 100*3_600_000); !ok || r.From != 88*3_600_000 {
		t.Errorf("12h: %+v %v", r, ok)
	}
	for _, bad := range []string{"soon", "0d", "7w"} {
		if _, ok := SinceRange(bad, 0); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}
