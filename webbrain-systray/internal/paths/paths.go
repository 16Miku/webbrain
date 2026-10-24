// Package paths resolves the per-user directories the companion uses.
//
//	Config  (settings, proxy config, OAuth logins):
//	  Windows  %APPDATA%\WebBrain Companion
//	  macOS    ~/Library/Application Support/WebBrain Companion
//	  Linux    $XDG_CONFIG_HOME/webbrain-companion (~/.config/webbrain-companion)
//	Data    (models, runtimes, logs; large and not roaming):
//	  Windows  %LOCALAPPDATA%\WebBrain Companion
//	  macOS    ~/Library/Application Support/WebBrain Companion
//	  Linux    $XDG_DATA_HOME/webbrain-companion (~/.local/share/webbrain-companion)
//
// WBC_HOME overrides both (useful for tests and portable installs).
package paths

import (
	"os"
	"path/filepath"
	"runtime"
)

const (
	appName  = "WebBrain Companion"
	unixName = "webbrain-companion"
)

// Config returns the directory for small, user-owned state.
func Config() string {
	if h := os.Getenv("WBC_HOME"); h != "" {
		return h
	}
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("APPDATA"); d != "" {
			return filepath.Join(d, appName)
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", appName)
		}
	default:
		if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
			return filepath.Join(d, unixName)
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".config", unixName)
		}
	}
	return filepath.Join(os.TempDir(), unixName)
}

// Data returns the directory for large artifacts (models, runtimes) and logs.
func Data() string {
	if h := os.Getenv("WBC_HOME"); h != "" {
		return h
	}
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, appName)
		}
	case "darwin":
		return Config()
	default:
		if d := os.Getenv("XDG_DATA_HOME"); d != "" {
			return filepath.Join(d, unixName)
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".local", "share", unixName)
		}
	}
	return Config()
}

func AuthDir() string     { return filepath.Join(Config(), "auths") }
func ProxyConfig() string { return filepath.Join(Config(), "proxy.yaml") }
func Settings() string    { return filepath.Join(Config(), "companion.json") }
func LockFile() string    { return filepath.Join(Config(), "companion.lock") }
func Logs() string        { return filepath.Join(Data(), "logs") }
func Models() string      { return filepath.Join(Data(), "models") }
func Runtimes() string    { return filepath.Join(Data(), "runtimes") }

// Ensure creates every directory the companion writes to.
func Ensure() error {
	for _, d := range []string{Config(), AuthDir(), Data(), Logs(), Models(), Runtimes()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}
