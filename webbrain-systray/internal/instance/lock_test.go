package instance

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestExclusiveLockAndRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "companion.lock")
	first, err := TryAcquire(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := TryAcquire(path); !errors.Is(err, ErrHeld) {
		if second != nil {
			second.Close()
		}
		t.Fatalf("second acquisition: got %v, want ErrHeld", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := TryAcquire(path)
	if err != nil {
		t.Fatalf("could not acquire after release: %v", err)
	}
	defer third.Close()
}
