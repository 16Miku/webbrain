package logx

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestGUIOutputRotates(t *testing.T) {
	if os.Getenv("WBC_LOG_ROTATION_HELPER") == "1" {
		originalStderr := os.Stderr
		dir := os.Getenv("WBC_LOG_ROTATION_DIR")
		Init(dir, false)
		chunk := bytes.Repeat([]byte("x"), 32<<10)
		for i := 0; i < 9<<20/len(chunk); i++ {
			if _, err := os.Stdout.Write(chunk); err != nil {
				fmt.Fprintln(originalStderr, err)
				os.Exit(1)
			}
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			current, currentErr := os.Stat(Path())
			previous, previousErr := os.Stat(Path() + ".1")
			if currentErr == nil && previousErr == nil && current.Size() <= maxSize && previous.Size() <= maxSize && current.Size()+previous.Size() >= 9<<20 {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
		fmt.Fprintln(originalStderr, "redirected GUI output did not rotate within 5 seconds")
		os.Exit(1)
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestGUIOutputRotates$")
	cmd.Env = append(os.Environ(), "WBC_LOG_ROTATION_HELPER=1", "WBC_LOG_ROTATION_DIR="+dir)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("GUI logging helper failed: %v: %s", err, output)
	}
	if _, err := os.Stat(filepath.Join(dir, "companion.log.1")); err != nil {
		t.Fatalf("rotated log missing: %v", err)
	}
}
