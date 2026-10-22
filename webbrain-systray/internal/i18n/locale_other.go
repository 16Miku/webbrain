//go:build !windows

package i18n

import (
	"os/exec"
	"runtime"
	"strings"
)

func systemLocale() string {
	if runtime.GOOS == "darwin" {
		// GUI apps launched from Finder get no LANG; ask the user defaults.
		out, err := exec.Command("/usr/bin/defaults", "read", "-g", "AppleLocale").Output()
		if err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return ""
}
