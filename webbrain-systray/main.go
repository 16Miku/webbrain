// WebBrain Companion: a small tray app that exposes your AI subscriptions as
// OpenAI / Anthropic / Gemini compatible endpoints on 127.0.0.1 (via an
// embedded CLIProxyAPI), shows their remaining quotas, can run Bonsai 2 27B
// locally, and hosts WebBrain's d1 decision model.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/esokullu/webbrain-systray/internal/app"
	"github.com/esokullu/webbrain-systray/internal/icons"
	"github.com/esokullu/webbrain-systray/internal/instance"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
	"github.com/esokullu/webbrain-systray/internal/tray"
)

var version = "0.1.0-dev"

type runtimeInfo struct {
	PID  int `json:"pid"`
	Port int `json:"port"`
}

func runtimeFile() string { return filepath.Join(paths.Config(), "companion.runtime.json") }

// existingInstance finds a companion that is already running for this user.
func existingInstance(s settings.Settings) (int, bool) {
	ports := []int{s.Port}
	if data, err := os.ReadFile(runtimeFile()); err == nil {
		var ri runtimeInfo
		if json.Unmarshal(data, &ri) == nil && ri.Port > 0 && ri.Port != ports[0] {
			ports = append([]int{ri.Port}, ports...)
		}
	}
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	for _, p := range ports {
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/companion/v1/info", p))
		if err != nil {
			continue
		}
		var info struct {
			App        string `json:"app"`
			InstanceID string `json:"instance_id"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&info)
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK && info.App == "webbrain-companion" && info.InstanceID == settings.InstanceID(s.PanelToken) {
			return p, true
		}
	}
	return 0, false
}

// A second launch waits for the lock holder to finish starting, then opens
// its panel. Reading settings here must stay read-only: the owner may still
// be creating its settings and proxy files.
func waitForInstance(timeout time.Duration) (int, settings.Settings, bool) {
	deadline := time.Now().Add(timeout)
	for {
		if data, err := os.ReadFile(paths.Settings()); err == nil {
			var s settings.Settings
			if json.Unmarshal(data, &s) == nil && s.PanelToken != "" {
				if port, ok := existingInstance(s); ok {
					return port, s, true
				}
			}
		}
		if time.Now().After(deadline) {
			return 0, settings.Settings{}, false
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func isTerminal() bool {
	st, err := os.Stdout.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func main() {
	headless := flag.Bool("headless", false, "run the proxy and APIs without a tray icon (servers, CI)")
	background := flag.Bool("background", false, "started at login: do not open the panel")
	_ = flag.Bool("panel", false, "open the panel (the default unless --background)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("WebBrain Companion", version)
		return
	}
	if err := paths.Ensure(); err != nil {
		fmt.Fprintln(os.Stderr, "cannot create data folders:", err)
		os.Exit(1)
	}
	instanceLock, err := instance.TryAcquire(paths.LockFile())
	if errors.Is(err, instance.ErrHeld) {
		if port, s, ok := waitForInstance(15 * time.Second); ok {
			if !*background {
				url := fmt.Sprintf("http://127.0.0.1:%d/companion/#k=%s", port, s.PanelToken)
				_ = osutil.OpenAppWindow(url, 460, 820)
			}
			return
		}
		fmt.Fprintln(os.Stderr, "another companion instance is starting; try opening the app again")
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot lock companion data:", err)
		os.Exit(1)
	}
	defer instanceLock.Close()
	// logx redirects os.Stdout/os.Stderr into the log file when no terminal is
	// attached; keep the originals for the headless banner and fatal errors.
	stdout, stderr := os.Stdout, os.Stderr
	logx.Init(paths.Logs(), isTerminal())
	store, err := settings.Open()
	if err != nil {
		logx.Printf("settings: %v", err)
		fmt.Fprintln(stderr, "cannot read settings:", err)
		os.Exit(1)
	}
	a := app.New(version, store)
	writeRuntime := func(port int) {
		data, _ := json.Marshal(runtimeInfo{PID: os.Getpid(), Port: port})
		_ = os.WriteFile(runtimeFile(), data, 0o600)
	}
	a.OnProxyStart = writeRuntime
	startErr := a.Start()
	if startErr != nil {
		logx.Printf("start: %v", startErr)
	} else {
		writeRuntime(a.Proxy.Port())
	}
	open := func(fragment string) {
		if !a.Proxy.Running() {
			_ = osutil.Reveal(logx.Path())
			return
		}
		_ = osutil.OpenAppWindow(a.PanelURL(fragment), 460, 820)
	}
	a.OpenPanel = open
	shutdown := func() {
		a.Shutdown()
		_ = os.Remove(runtimeFile())
	}

	if *headless {
		if startErr != nil {
			fmt.Fprintln(stderr, "start failed:", startErr)
			os.Exit(1)
		}
		fmt.Fprintf(stdout, "WebBrain Companion %s\n  OpenAI base URL: %s/v1\n  API key: %s\n  Panel: %s\n",
			version, a.Proxy.BaseURL(), store.Get().APIKey, a.PanelURL(""))
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		quit := make(chan struct{})
		var once sync.Once
		a.Quit = func() { once.Do(func() { close(quit) }) }
		select {
		case <-sig:
		case <-quit:
		}
		shutdown()
		return
	}

	tray.SetOnTap(func() { open("") })
	a.OnChange = tray.Refresh
	a.Quit = tray.Quit
	tooltip := "WebBrain Companion"
	if startErr != nil {
		tooltip += " — " + strings.SplitN(startErr.Error(), "\n", 2)[0]
	}
	tray.Run(tray.Options{
		Icon:    tray.Icon{Template: icons.Template, PNG: icons.PNG, ICO: icons.ICO},
		Tooltip: tooltip,
		Menu: func() []tray.Item {
			return a.Menu(app.MenuActions{OpenPanel: open, Quit: tray.Quit})
		},
		OnReady: func() {
			// Opening the app by hand shows the panel (the icon can be hidden in a
			// full menu bar or the Windows overflow area); starting at login
			// (--background) stays quiet.
			if !*background && startErr == nil {
				time.Sleep(400 * time.Millisecond)
				open("")
			}
		},
		OnExit: shutdown,
	})
}
