package osutil

import (
	"os"
	"runtime"
	"strings"
)

// Translocated reports whether macOS runs the app from a temporary read-only
// copy (Gatekeeper path randomization) because it was opened where it was
// downloaded instead of from Applications. Start at login would point at that
// copy, which disappears.
func Translocated() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	exe, err := os.Executable()
	return err == nil && strings.Contains(exe, "/AppTranslocation/")
}
