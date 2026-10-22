package d1

import (
	"reflect"
	"testing"
)

// Expected strings are what V8 prints for the same values.
func TestJSNumber(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", -2.5: "-2.5", 0.1: "0.1", 0.30000000000000004: "0.30000000000000004",
		1e20: "100000000000000000000", 1e21: "1e+21", 123456789012345680000: "123456789012345680000",
		0.000001: "0.000001", 1e-7: "1e-7", 1.5e-7: "1.5e-7", 2.5e-10: "2.5e-10", 1.7976931348623157e308: "1.7976931348623157e+308",
	}
	for f, want := range cases {
		if got := jsNumber(f); got != want {
			t.Errorf("jsNumber(%v) = %s, want %s", f, got, want)
		}
	}
	if got := jsExponential(12345); got != "1.2345e+4" {
		t.Errorf("jsExponential(12345) = %s", got)
	}
	if got := jsExponential(0.00042); got != "4.2e-4" {
		t.Errorf("jsExponential(0.00042) = %s", got)
	}
}

// Integer-like keys come first in ascending order, then the rest in insertion order.
func TestJSKeyOrder(t *testing.T) {
	got := jsKeyOrder([]string{"b", "10", "a", "2", "01", "1"})
	want := []string{"1", "2", "10", "b", "a", "01"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestStringifyRoundTrip(t *testing.T) {
	v, err := ParseJSON([]byte(`{"z":1,"a":[true,null,"x\"y"],"5":{"k":0.5}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := jsStringify(v), `{"5":{"k":0.5},"z":1,"a":[true,null,"x\"y"]}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}
