package osutil

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const autostartName = "WebBrain Companion"

// Executable is the path that should be launched at login: the .app bundle's
// binary on macOS, the program itself elsewhere.
func Executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return exe
}

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "one.webbrain.companion.plist")
}

func desktopEntryPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "autostart", "webbrain-companion.desktop")
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

// SetAutostart registers or removes the login item.
func SetAutostart(on bool) error {
	exe := Executable()
	switch runtime.GOOS {
	case "darwin":
		p := launchAgentPath()
		if !on {
			err := os.Remove(p)
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>one.webbrain.companion</string>
  <key>ProgramArguments</key><array><string>%s</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`, xmlEscape(exe))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		return os.WriteFile(p, []byte(plist), 0o644)
	case "windows":
		return setRunKey(on, `"`+exe+`" --background`)
	default:
		p := desktopEntryPath()
		if !on {
			err := os.Remove(p)
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		entry := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=%s\nExec=\"%s\" --background\nX-GNOME-Autostart-enabled=true\nTerminal=false\n", autostartName, exe)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		return os.WriteFile(p, []byte(entry), 0o644)
	}
}

// AutostartEnabled reports whether the login item exists.
func AutostartEnabled() bool {
	switch runtime.GOOS {
	case "darwin":
		_, err := os.Stat(launchAgentPath())
		return err == nil
	case "windows":
		return runKeyExists()
	default:
		_, err := os.Stat(desktopEntryPath())
		return err == nil
	}
}
