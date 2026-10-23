// d1check runs parity cases through the Go decision-model port.
//
//	go run ./tools/d1check -model DIR -ort LIB -cases cases.json -out go.json
//	go run ./tools/d1check -tokenizer DIR/tokenizer.json -texts texts.json -out ids.json
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/esokullu/webbrain-systray/internal/d1"
)

func main() {
	model := flag.String("model", "", "model directory")
	ort := flag.String("ort", "", "ONNX Runtime shared library")
	cases := flag.String("cases", "", "JSON array of requests")
	tok := flag.String("tokenizer", "", "tokenizer.json (tokenizer-only mode)")
	texts := flag.String("texts", "", "JSON array of strings to tokenize")
	encodeOnly := flag.Bool("encode", false, "only print encoded rows")
	out := flag.String("out", "", "output file")
	threads := flag.Int("threads", 0, "intra-op threads")
	flag.Parse()

	if *tok != "" {
		t, err := d1.LoadTokenizer(*tok)
		if err != nil {
			panic(err)
		}
		var list []string
		data, _ := os.ReadFile(*texts)
		if err := json.Unmarshal(data, &list); err != nil {
			panic(err)
		}
		res := make([][]int, len(list))
		start := time.Now()
		for i, s := range list {
			res[i] = t.Encode(s)
		}
		fmt.Fprintf(os.Stderr, "tokenized %d texts in %v\n", len(list), time.Since(start))
		b, _ := json.Marshal(res)
		_ = os.WriteFile(*out, b, 0o644)
		return
	}

	eng, err := d1.OpenEngine(*model, *ort, *threads)
	if err != nil {
		panic(err)
	}
	defer eng.Close()
	data, err := os.ReadFile(*cases)
	if err != nil {
		panic(err)
	}
	var list []json.RawMessage
	if err := json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	var results []any
	for i, c := range list {
		start := time.Now()
		if *encodeOnly {
			ids, markers, err := eng.Encode(c)
			if err != nil {
				results = append(results, map[string]any{"ok": false, "error": err.Error()})
				continue
			}
			results = append(results, map[string]any{"ok": true, "ids": ids, "markers": markers})
			continue
		}
		res, err := eng.EvaluateJSON(context.Background(), c)
		if err != nil {
			results = append(results, map[string]any{"ok": false, "error": err.Error()})
		} else {
			results = append(results, map[string]any{"ok": true, "result": res})
		}
		fmt.Fprintf(os.Stderr, "case %d: %v\n", i, time.Since(start))
	}
	b, _ := json.MarshalIndent(results, "", " ")
	_ = os.WriteFile(*out, b, 0o644)
}
