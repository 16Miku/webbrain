// Package app wires the companion together: the embedded proxy, accounts and
// their quotas, the local model, the decision model, the panel API and the
// tray menu.
package app

import (
	"context"

	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/esokullu/webbrain-systray/internal/accounts"
	"github.com/esokullu/webbrain-systray/internal/core"
	"github.com/esokullu/webbrain-systray/internal/d1"
	"github.com/esokullu/webbrain-systray/internal/i18n"
	"github.com/esokullu/webbrain-systray/internal/localmodel"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/quota"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

type login struct {
	Provider string    `json:"provider"`
	State    string    `json:"state"`
	Started  time.Time `json:"started"`
	Status   string    `json:"status"` // wait | ok | error
	Error    string    `json:"error,omitempty"`
}

type App struct {
	Version   string
	Store     *settings.Store
	Proxy     *core.Proxy
	Local     *localmodel.Manager
	D1        *d1.Manager
	restartMu sync.Mutex // serializes settings changes and their proxy restarts
	queueMu   sync.Mutex // orders restarts requested by the panel before they run
	queueTail chan struct{}

	mu        sync.Mutex
	creds     []core.Credential
	credsErr  string
	quotas    map[string]quota.State
	models    []string
	logins    map[string]*login
	notice    string
	quotaBusy bool

	subsMu sync.Mutex
	subs   map[chan struct{}]struct{}

	// OnChange is called (debounced by the tray) whenever state changes.
	OnChange func()
	// Quit exits the app (set by main; the panel offers it when the menu bar
	// icon is out of reach).
	Quit func()
	// OnProxyStart is called with the port after every (re)start, so main can
	// keep the single-instance runtime file current.
	OnProxyStart func(port int)
	// OpenPanel opens the panel window (set by main).
	OpenPanel func(fragment string)

	// internalKey authenticates apps on this computer with the proxy; it never
	// leaves the process.
	internalKey string

	ctx    context.Context
	cancel context.CancelFunc
}

func New(version string, store *settings.Store) *App {
	a := &App{
		Version: version,
		Store:   store,
		Proxy:   core.New(),
		quotas:  map[string]quota.State{},
		logins:  map[string]*login{},
		subs:    map[chan struct{}]struct{}{},

		internalKey: "wbc-local-" + settings.RandomSecret(),
	}
	a.ctx, a.cancel = context.WithCancel(context.Background())
	a.Local = localmodel.NewManager(store, a.registerLocal, a.changed)
	a.D1 = d1.NewManager(store, a.changed)
	return a
}

func (a *App) registerLocal(local []core.LocalUpstream) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	return a.Proxy.SetLocal(local)
}

// The panel must receive its response before a restart drops its connection.
// Chain delayed operations in request order so rapid changes apply in order.
func (a *App) queueRestart(label string, change func() error) {
	a.queueMu.Lock()
	previous := a.queueTail
	done := make(chan struct{})
	a.queueTail = done
	a.queueMu.Unlock()
	go func() {
		defer close(done)
		if previous != nil {
			<-previous
		}
		select {
		case <-time.After(300 * time.Millisecond):
		case <-a.ctx.Done():
			return
		}
		if a.ctx.Err() != nil {
			return
		}
		if err := change(); err != nil {
			logx.Printf("%s: %v", label, err)
		}
	}()
}

// changed notifies panel listeners and the tray.
func (a *App) changed() {
	a.subsMu.Lock()
	for ch := range a.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	a.subsMu.Unlock()
	if a.OnChange != nil {
		a.OnChange()
	}
}

// Subscribe returns a channel signalled on every state change.
func (a *App) Subscribe() (chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	a.subsMu.Lock()
	a.subs[ch] = struct{}{}
	a.subsMu.Unlock()
	return ch, func() {
		a.subsMu.Lock()
		delete(a.subs, ch)
		a.subsMu.Unlock()
	}
}

// Start brings the proxy up and starts background refreshes.
func (a *App) Start() error {
	s := a.Store.Get()
	i18n.Set(s.Language)
	err := a.Proxy.Start(a.proxyOptions(s, nil))
	if err != nil && s.Network {
		// The network address may be unavailable; fall back to this computer only.
		logx.Printf("network access: %v; listening on 127.0.0.1 only", err)
		s.Network = false
		err = a.Proxy.Start(a.proxyOptions(s, nil))
	}
	if err != nil {
		return err
	}
	if p := a.Proxy.Port(); p != s.Port {
		a.setNotice(fmt.Sprintf(i18n.T("port_moved"), s.Port, p))
	}
	if s.Autostart || osutil.AutostartEnabled() {
		// Re-register so the login item points at this executable.
		_ = osutil.SetAutostart(s.Autostart)
	}
	go a.loop()
	go func() {
		if s.Local.AutoStart {
			if err := a.Local.Start(); err != nil {
				logx.Printf("local model autostart: %v", err)
			}
		}
	}()
	go func() {
		if s.Decision.Enabled && a.D1.Installed() {
			if err := a.D1.Load(); err != nil {
				logx.Printf("decision model load: %v", err)
			}
		}
	}()
	return nil
}

// Shutdown stops child servers and the proxy.
func (a *App) Shutdown() {
	a.cancel()
	a.Local.Stop()
	a.D1.Unload()
	a.Proxy.Stop()
}

func (a *App) setNotice(s string) {
	a.mu.Lock()
	a.notice = s
	a.mu.Unlock()
	a.changed()
}

func (a *App) loop() {
	a.refreshAccounts()
	a.RefreshQuotas("")
	accT := time.NewTicker(30 * time.Second)
	defer accT.Stop()
	lastQuota := time.Now()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-accT.C:
			a.refreshAccounts()
			every := time.Duration(a.Store.Get().QuotaRefreshMinutes) * time.Minute
			if every <= 0 {
				every = 5 * time.Minute
			}
			if time.Since(lastQuota) >= every {
				lastQuota = time.Now()
				a.RefreshQuotas("")
			}
		}
	}
}

func (a *App) refreshAccounts() {
	m := a.Proxy.Mgmt()
	if m == nil {
		return
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	creds, err := m.Credentials(ctx)
	models, modelErr := m.Models(ctx)
	a.mu.Lock()
	if err != nil {
		a.credsErr = err.Error()
	} else {
		a.credsErr = ""
		a.creds = creds
		// Forget quotas of removed accounts.
		keep := map[string]bool{}
		for _, c := range creds {
			keep[c.Name()] = true
		}
		for k := range a.quotas {
			if !keep[k] {
				delete(a.quotas, k)
			}
		}
	}
	if modelErr == nil {
		sort.Strings(models)
		a.models = models
	}
	a.mu.Unlock()
	a.changed()
}

// RefreshQuotas re-reads usage for one account (by name) or all of them.
func (a *App) RefreshQuotas(name string) {
	m := a.Proxy.Mgmt()
	if m == nil {
		return
	}
	a.mu.Lock()
	if name == "" && a.quotaBusy {
		a.mu.Unlock()
		return
	}
	if name == "" {
		a.quotaBusy = true
	}
	creds := append([]core.Credential(nil), a.creds...)
	a.mu.Unlock()
	defer func() {
		if name == "" {
			a.mu.Lock()
			a.quotaBusy = false
			a.mu.Unlock()
		}
	}()
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for _, c := range creds {
		if name != "" && c.Name() != name {
			continue
		}
		if !quota.Supported(c.Provider()) {
			continue
		}
		wg.Add(1)
		go func(c core.Credential) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(a.ctx, 40*time.Second)
			defer cancel()
			st := quota.Fetch(ctx, m, c)
			a.mu.Lock()
			prev, had := a.quotas[c.Name()]
			if st.Status == "error" && had && prev.Status == "ok" && time.Since(prev.FetchedAt) < 30*time.Minute {
				// Keep showing the last good numbers; note the failure.
				prev.Error = st.Error
				st = prev
			}
			a.quotas[c.Name()] = st
			a.mu.Unlock()
			a.changed()
		}(c)
	}
	wg.Wait()
}

// --- logins -----------------------------------------------------------------------

func (a *App) StartLogin(provider string) (core.LoginStart, error) {
	if _, ok := accounts.Lookup(provider); !ok {
		return core.LoginStart{}, fmt.Errorf("unknown provider %q", provider)
	}
	m := a.Proxy.Mgmt()
	if m == nil {
		return core.LoginStart{}, errors.New("proxy is not running")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	ls, err := m.StartLogin(ctx, provider)
	if err != nil {
		return ls, err
	}
	a.mu.Lock()
	a.logins[ls.State] = &login{Provider: provider, State: ls.State, Started: time.Now(), Status: "wait"}
	a.mu.Unlock()
	if ls.URL != "" {
		_ = osutil.OpenURL(ls.URL)
	}
	go a.watchLogin(ls.State)
	return ls, nil
}

func (a *App) watchLogin(state string) {
	m := a.Proxy.Mgmt()
	deadline := time.Now().Add(31 * time.Minute)
	for time.Now().Before(deadline) {
		select {
		case <-a.ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
		a.mu.Lock()
		l := a.logins[state]
		a.mu.Unlock()
		if l == nil || l.Status != "wait" {
			return
		}
		ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
		status, msg, err := m.LoginStatus(ctx, state)
		cancel()
		if err != nil {
			continue
		}
		if status == "ok" || status == "error" {
			a.mu.Lock()
			l.Status, l.Error = status, msg
			a.mu.Unlock()
			if status == "ok" {
				a.refreshAccounts()
				go a.RefreshQuotas("")
			}
			a.changed()
			return
		}
	}
	a.mu.Lock()
	if l := a.logins[state]; l != nil && l.Status == "wait" {
		l.Status, l.Error = "error", "timed out"
	}
	a.mu.Unlock()
	a.changed()
}

func (a *App) Login(state string) (login, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	l, ok := a.logins[state]
	if !ok {
		return login{}, false
	}
	return *l, true
}

func (a *App) CancelLogin(state string) {
	a.mu.Lock()
	l := a.logins[state]
	delete(a.logins, state)
	a.mu.Unlock()
	if l != nil {
		if m := a.Proxy.Mgmt(); m != nil {
			ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
			_ = m.CancelLogin(ctx, state)
			cancel()
		}
	}
	a.changed()
}

func (a *App) SubmitCallback(state, redirectURL string) error {
	a.mu.Lock()
	l := a.logins[state]
	a.mu.Unlock()
	if l == nil {
		return errors.New("this sign-in is no longer pending")
	}
	if !strings.HasPrefix(redirectURL, "http://") && !strings.HasPrefix(redirectURL, "https://") {
		return errors.New("paste the full address from the browser's address bar")
	}
	// The proxy infers the provider from the pending state in the URL.
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	return a.Proxy.Mgmt().SubmitCallback(ctx, "", redirectURL)
}

func (a *App) RemoveAccount(name string) error {
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	if err := a.Proxy.Mgmt().DeleteCredential(ctx, name); err != nil {
		return err
	}
	a.refreshAccounts()
	return nil
}

func (a *App) SetAccountDisabled(name string, disabled bool) error {
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	if err := a.Proxy.Mgmt().SetCredentialDisabled(ctx, name, disabled); err != nil {
		return err
	}
	a.refreshAccounts()
	if !disabled {
		go a.RefreshQuotas(name)
	}
	return nil
}

// RotateKey issues a new client API key and restarts the proxy with it.
func (a *App) RotateKey() error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	s, err := a.Store.Update(func(s *settings.Settings) { s.APIKey = settings.NewAPIKey() })
	if err != nil {
		return err
	}
	port := a.Proxy.Port()
	if port == 0 {
		port = s.Port
	}
	return a.restartOn(s, port, false)
}

// proxyOptions builds the proxy configuration from the settings. The internal
// key goes last: the management client uses it.
func (a *App) proxyOptions(s settings.Settings, local []core.LocalUpstream) core.Options {
	return a.proxyOptionsOn(s, local, s.Port, false)
}

func (a *App) proxyOptionsOn(s settings.Settings, local []core.LocalUpstream, port int, strict bool) core.Options {
	host := "127.0.0.1"
	if s.Network {
		host = "0.0.0.0"
	}
	return core.Options{
		PreferredPort: port,
		StrictPort:    strict,
		Host:          host,
		APIKeys:       []string{s.APIKey, a.internalKey},
		Routes:        a.routes,
		Local:         local,
		Middleware:    []gin.HandlerFunc{noCORS, a.access},
	}
}

// SetNetwork turns access from other devices on or off (0.0.0.0 with the API
// key, or 127.0.0.1 only) and restarts the proxy on the same port, so open
// panels and configured apps keep working.
func (a *App) SetNetwork(on bool) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	s, err := a.Store.Update(func(s *settings.Settings) { s.Network = on })
	if err != nil {
		return err
	}
	port := a.Proxy.Port()
	if port == 0 {
		port = s.Port
	}
	if err := a.restartOn(s, port, true); err != nil {
		if on {
			// Could not listen on the network on this port: back to this computer only.
			s, _ = a.Store.Update(func(s *settings.Settings) { s.Network = false })
			_ = a.restartOn(s, port, false)
			a.setNotice(fmt.Sprintf(i18n.T("network_failed"), port))
		}
		return err
	}
	return nil
}

// SetPort changes the preferred port and restarts the proxy.
func (a *App) SetPort(port int) error {
	if port < 1024 || port > 65535 {
		return errors.New("choose a port between 1024 and 65535")
	}
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	previous := a.Store.Get()
	previousPort := a.Proxy.Port()
	panelOpen := a.listeners() > 0
	s, err := a.Store.Update(func(s *settings.Settings) { s.Port = port })
	if err != nil {
		return err
	}
	if err := a.restartProxy(s); err != nil {
		restored, saveErr := a.Store.Update(func(s *settings.Settings) { s.Port = previous.Port })
		restorePort := previousPort
		if restorePort == 0 {
			restorePort = previous.Port
		}
		restartErr := a.restartOn(restored, restorePort, previousPort != 0)
		if restartErr == nil {
			a.setNotice(fmt.Sprintf(i18n.T("port_failed"), port, a.Proxy.Port()))
			if panelOpen && a.OpenPanel != nil {
				go a.OpenPanel("")
			}
		}
		return errors.Join(err, saveErr, restartErr)
	}
	return nil
}

func (a *App) restartProxy(s settings.Settings) error {
	return a.restartOn(s, s.Port, false)
}

// restartOn restarts the proxy, preferring port (strict: only that port).
func (a *App) restartOn(s settings.Settings, port int, strict bool) error {
	local := a.Proxy.Local()
	before := a.Proxy.Port()
	panelOpen := a.listeners() > 0
	a.Proxy.Stop()
	err := a.Proxy.Start(a.proxyOptionsOn(s, local, port, strict))
	a.mu.Lock()
	a.notice = ""
	a.mu.Unlock()
	p := a.Proxy.Port()
	if err == nil && p != s.Port {
		a.setNotice(fmt.Sprintf(i18n.T("port_moved"), s.Port, p))
	}
	if err == nil {
		if a.OnProxyStart != nil {
			a.OnProxyStart(p)
		}
		// An open panel was served from the old port; open it on the new one.
		if before != 0 && p != before && a.OpenPanel != nil && panelOpen {
			go a.OpenPanel("")
		}
	}
	go a.refreshAccounts()
	a.changed()
	return err
}

// listeners counts open panels (event streams).
func (a *App) listeners() int {
	a.subsMu.Lock()
	defer a.subsMu.Unlock()
	return len(a.subs)
}

func (a *App) SetAutostart(on bool) error {
	if err := osutil.SetAutostart(on); err != nil {
		return err
	}
	_, err := a.Store.Update(func(s *settings.Settings) { s.Autostart = on })
	a.changed()
	return err
}

func (a *App) SetLanguage(l string) {
	_, _ = a.Store.Update(func(s *settings.Settings) { s.Language = l })
	i18n.Set(l)
	a.changed()
}
