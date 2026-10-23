package download

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSafeJoin(t *testing.T) {
	dst := t.TempDir()
	cases := []struct {
		name  string
		strip int
		want  string // "" means rejected
	}{
		{"llama/bin/llama-server", 1, "bin/llama-server"},
		{"./llama/bin/llama-server", 1, "bin/llama-server"},
		{`llama\lib\ggml.dll`, 1, "lib/ggml.dll"},
		{"../evil", 0, ""},
		{"a/../../evil", 0, ""},
		{"llama/../../evil", 1, ""},
		{"llama", 1, ""},
		{"/etc/passwd", 0, "etc/passwd"},
	}
	for _, c := range cases {
		got, ok := safeJoin(dst, c.name, c.strip)
		if c.want == "" {
			if ok {
				t.Errorf("%q accepted as %s", c.name, got)
			}
			continue
		}
		if want := filepath.Join(dst, filepath.FromSlash(c.want)); !ok || got != want {
			t.Errorf("%q: got %s %v, want %s", c.name, got, ok, want)
		}
	}
}

func TestExtractTarGzStripsCommonPrefix(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "rt.tar.gz")
	f, _ := os.Create(src)
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	add := func(name string, body string, mode int64) {
		typ := byte(tar.TypeReg)
		if body == "" && name[len(name)-1] == '/' {
			typ = tar.TypeDir
		}
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: typ})
		_, _ = tw.Write([]byte(body))
	}
	add("./", "", 0o755)
	add("./build-1/", "", 0o755)
	add("./build-1/bin/", "", 0o755)
	add("./build-1/bin/llama-server", "#!/bin/sh\n", 0o755)
	add("./build-1/lib/libggml.so", "elf", 0o644)
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()

	if d := CommonPrefixDepth(src); d != 1 {
		t.Fatalf("CommonPrefixDepth = %d, want 1", d)
	}
	out := filepath.Join(dir, "out")
	if err := Extract(src, out, CommonPrefixDepth(src)); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(out, "bin", "llama-server"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows does not expose Unix executable permission bits.
	if runtime.GOOS != "windows" && st.Mode()&0o100 == 0 {
		t.Error("executable bit lost")
	}
	if _, err := os.Stat(filepath.Join(out, "lib", "libggml.so")); err != nil {
		t.Error(err)
	}
}
