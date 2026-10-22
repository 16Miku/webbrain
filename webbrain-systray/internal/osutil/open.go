// Package osutil wraps the small OS integrations a tray app needs: opening
// URLs and folders, a chromeless panel window, the clipboard and autostart.
package osutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/atotto/clipboard"
)

// OpenURL opens a link in the user's default browser.
func OpenURL(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return Command("/usr/bin/open", url).Start()
	case "windows":
		return Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return Command("xdg-open", url).Start()
	}
}

// Reveal opens a folder (or the folder containing a file) in the file manager.
func Reveal(path string) error {
	switch runtime.GOOS {
	case "darwin":
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			return Command("/usr/bin/open", "-R", path).Start()
		}
		return Command("/usr/bin/open", path).Start()
	case "windows":
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			return Command("explorer", "/select,", path).Start()
		}
		return Command("explorer", path).Start()
	default:
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			path = filepath.Dir(path)
		}
		return Command("xdg-open", path).Start()
	}
}

// Copy puts text on the clipboard.
func Copy(text string) error { return clipboard.WriteAll(text) }

// chromiumCandidates lists Chromium-family browsers that support --app.
func chromiumCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		var out []string
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi", "Arc"} {
			for _, root := range []string{"/Applications", filepath.Join(home, "Applications")} {
				p := filepath.Join(root, app+".app")
				if _, err := os.Stat(p); err == nil {
					out = append(out, p)
				}
			}
		}
		return out
	case "windows":
		var out []string
		roots := []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")}
		rels := []string{
			`Google\Chrome\Application\chrome.exe`,
			`Microsoft\Edge\Application\msedge.exe`,
			`BraveSoftware\Brave-Browser\Application\brave.exe`,
		}
		for _, rel := range rels {
			for _, root := range roots {
				if root == "" {
					continue
				}
				p := filepath.Join(root, rel)
				if _, err := os.Stat(p); err == nil {
					out = append(out, p)
				}
			}
		}
		return out
	default:
		var out []string
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"} {
			if p, err := exec.LookPath(name); err == nil {
				out = append(out, p)
			}
		}
		return out
	}
}

// OpenAppWindow shows url in a chromeless browser window (Chrome/Edge "app"
// mode) sized like a small panel, falling back to a normal browser tab.
func OpenAppWindow(url string, width, height int) error {
	size := "--window-size=" + itoa(width) + "," + itoa(height)
	for _, c := range chromiumCandidates() {
		var cmd *exec.Cmd
		if runtime.GOOS == "darwin" {
			cmd = Command("/usr/bin/open", "-na", c, "--args", "--app="+url, size)
		} else {
			cmd = Command(c, "--app="+url, size)
		}
		if err := cmd.Start(); err == nil {
			go func() { _ = cmd.Wait() }()
			return nil
		}
	}
	return OpenURL(url)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
