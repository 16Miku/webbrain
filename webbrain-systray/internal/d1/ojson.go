package d1

// JSON values with JavaScript semantics: object keys keep JS property order
// (array-index keys first, ascending; then insertion order) and numbers
// print the way Number.prototype.toString does. The d1 prompt is built from
// these exact strings, so they must match the browser adapter.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type kind int

const (
	kNull kind = iota
	kBool
	kNum
	kStr
	kArr
	kObj
)

type Value struct {
	K    kind
	B    bool
	N    float64
	S    string
	A    []*Value
	Keys []string
	M    map[string]*Value
}

func (v *Value) IsNull() bool { return v == nil || v.K == kNull }

// Get returns an object member (nil when absent).
func (v *Value) Get(key string) *Value {
	if v == nil || v.K != kObj {
		return nil
	}
	return v.M[key]
}

// Has mirrors Object.hasOwn.
func (v *Value) Has(key string) bool {
	if v == nil || v.K != kObj {
		return false
	}
	_, ok := v.M[key]
	return ok
}

// Len is Object.keys(v).length for objects and arrays.
func (v *Value) Len() int {
	if v == nil {
		return 0
	}
	switch v.K {
	case kObj:
		return len(v.Keys)
	case kArr:
		return len(v.A)
	case kStr:
		return utf8.RuneCountInString(v.S)
	}
	return 0
}

// ParseJSON decodes data into a Value tree.
func ParseJSON(data []byte) (*Value, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (*Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return fromToken(dec, tok)
}

func fromToken(dec *json.Decoder, tok json.Token) (*Value, error) {
	switch t := tok.(type) {
	case nil:
		return &Value{K: kNull}, nil
	case bool:
		return &Value{K: kBool, B: t}, nil
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			// Out-of-range literals become ±Infinity in JS; reject them here.
			return nil, fmt.Errorf("number %s is out of range", t)
		}
		return &Value{K: kNum, N: f}, nil
	case string:
		return &Value{K: kStr, S: t}, nil
	case json.Delim:
		switch t {
		case '[':
			v := &Value{K: kArr, A: []*Value{}}
			for dec.More() {
				el, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				v.A = append(v.A, el)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return v, nil
		case '{':
			v := &Value{K: kObj, M: map[string]*Value{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := kt.(string)
				if !ok {
					return nil, errors.New("object key must be a string")
				}
				el, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				if _, dup := v.M[key]; !dup {
					v.Keys = append(v.Keys, key)
				}
				v.M[key] = el
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			v.Keys = jsKeyOrder(v.Keys)
			return v, nil
		}
	}
	return nil, fmt.Errorf("unexpected token %v", tok)
}

// arrayIndex reports whether k is a canonical array index ("0".."4294967294").
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= 4294967295 {
		return 0, false
	}
	return n, true
}

// jsKeyOrder applies OrdinaryOwnPropertyKeys: integer keys ascending first.
func jsKeyOrder(keys []string) []string {
	var ints []string
	var rest []string
	for _, k := range keys {
		if _, ok := arrayIndex(k); ok {
			ints = append(ints, k)
		} else {
			rest = append(rest, k)
		}
	}
	if len(ints) == 0 {
		return keys
	}
	sort.Slice(ints, func(i, j int) bool {
		a, _ := arrayIndex(ints[i])
		b, _ := arrayIndex(ints[j])
		return a < b
	})
	return append(ints, rest...)
}

// jsNumber formats like Number.prototype.toString (radix 10).
func jsNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	digits, exp := shortest(f)
	k := len(digits)
	n := exp + 1 // position of the decimal point
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	es := "+"
	if e < 0 {
		es = "-"
		e = -e
	}
	if k == 1 {
		return sign + digits + "e" + es + strconv.Itoa(e)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(e)
}

// shortest returns the shortest round-trip digits and the decimal exponent of
// the first digit (d.ddd × 10^exp).
func shortest(f float64) (string, int) {
	s := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX
	mant, expStr, _ := strings.Cut(s, "e")
	exp, _ := strconv.Atoi(expStr)
	return strings.Replace(mant, ".", "", 1), exp
}

// jsExponential is Number.prototype.toExponential() without fraction digits.
func jsExponential(f float64) string {
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	digits, exp := shortest(f)
	es := "+"
	if exp < 0 {
		es = "-"
		exp = -exp
	}
	m := digits[:1]
	if len(digits) > 1 {
		m += "." + digits[1:]
	}
	return sign + m + "e" + es + strconv.Itoa(exp)
}

// jsQuote is JSON.stringify for a string.
func jsQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// jsStringify is JSON.stringify(v) (compact).
func jsStringify(v *Value) string {
	var b strings.Builder
	var walk func(*Value)
	walk = func(v *Value) {
		switch {
		case v == nil || v.K == kNull:
			b.WriteString("null")
		case v.K == kBool:
			b.WriteString(strconv.FormatBool(v.B))
		case v.K == kNum:
			if math.IsInf(v.N, 0) || math.IsNaN(v.N) {
				b.WriteString("null")
			} else {
				b.WriteString(jsNumber(v.N))
			}
		case v.K == kStr:
			b.WriteString(jsQuote(v.S))
		case v.K == kArr:
			b.WriteByte('[')
			for i, el := range v.A {
				if i > 0 {
					b.WriteByte(',')
				}
				walk(el)
			}
			b.WriteByte(']')
		case v.K == kObj:
			b.WriteByte('{')
			for i, k := range v.Keys {
				if i > 0 {
					b.WriteByte(',')
				}
				b.WriteString(jsQuote(k))
				b.WriteByte(':')
				walk(v.M[k])
			}
			b.WriteByte('}')
		}
	}
	walk(v)
	return b.String()
}

// pyJSON reproduces the adapter's Python-style json.dumps rendering.
func pyJSON(v *Value) (string, error) {
	switch {
	case v == nil || v.K == kNull:
		return "null", nil
	case v.K == kArr:
		parts := make([]string, len(v.A))
		for i, el := range v.A {
			s, err := pyJSON(el)
			if err != nil {
				return "", err
			}
			parts[i] = s
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	case v.K == kObj:
		parts := make([]string, len(v.Keys))
		for i, k := range v.Keys {
			s, err := pyJSON(v.M[k])
			if err != nil {
				return "", err
			}
			parts[i] = jsQuote(k) + ": " + s
		}
		return "{" + strings.Join(parts, ", ") + "}", nil
	case v.K == kNum:
		if math.IsInf(v.N, 0) || math.IsNaN(v.N) {
			return "", errors.New("D1 JSON numbers must be finite")
		}
		if v.N != math.Trunc(v.N) && math.Abs(v.N) < 1e-4 {
			s := jsExponential(v.N)
			if i := strings.LastIndexAny(s, "+-"); i > 0 && s[i-1] == 'e' {
				d := s[i+1:]
				if len(d) < 2 {
					d = "0" + d
				}
				s = s[:i+1] + d
			}
			return s, nil
		}
		return jsNumber(v.N), nil
	case v.K == kBool:
		return strconv.FormatBool(v.B), nil
	default:
		return jsQuote(v.S), nil
	}
}

// ordered is an insertion-ordered JSON object for responses.
type ordered struct {
	keys []string
	vals map[string]any
}

func newOrdered() *ordered { return &ordered{vals: map[string]any{}} }

func (o *ordered) Set(k string, v any) *ordered {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
	return o
}

func (o *ordered) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range jsKeyOrder(append([]string(nil), o.keys...)) {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := json.Marshal(o.vals[k])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
