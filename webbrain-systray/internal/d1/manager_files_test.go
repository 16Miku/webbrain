package d1

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestValidFileRejectsSameSizeCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "model.data")
	good := []byte("pinned model contents")
	sum := sha256.Sum256(good)
	want := hex.EncodeToString(sum[:])
	m := NewManager(nil, nil)
	bad := []byte("xinned model contents")
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if m.validFile(path, int64(len(good)), want) {
		t.Fatal("same-sized corrupt file passed checksum verification")
	}
	if err := os.WriteFile(path, good, 0o600); err != nil {
		t.Fatal(err)
	}
	if !m.validFile(path, int64(len(good)), want) {
		t.Fatal("valid file did not pass checksum verification")
	}
	// A modified cached file must be rehashed on the next status or load.
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	if m.validFile(path, int64(len(good)), want) {
		t.Fatal("changed file reused a previous successful checksum")
	}
}
