package app

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestSetPortRestoresWorkingProxyWhenLastPortIsOccupied(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	a := New("test", store)
	if err := a.Start(); err != nil {
		t.Fatal(err)
	}
	defer a.Shutdown()
	previous := store.Get().Port
	active := a.Proxy.Port()
	busy, err := net.Listen("tcp", "127.0.0.1:65535")
	if err != nil {
		t.Skipf("port 65535 is unavailable: %v", err)
	}
	defer busy.Close()
	if err := a.SetPort(65535); err == nil {
		t.Fatal("SetPort should fail when port 65535 is occupied")
	}
	if got := store.Get().Port; got != previous {
		t.Fatalf("saved port = %d, want previous %d", got, previous)
	}
	if !a.Proxy.Running() || a.Proxy.Port() != active {
		t.Fatalf("proxy stopped or moved after failed port change: running=%v port=%d, want %d", a.Proxy.Running(), a.Proxy.Port(), active)
	}
	if !strings.Contains(a.Snapshot().Notice, "65535") {
		t.Fatal("panel has no notice explaining the rejected port")
	}
}

func TestRapidNetworkTogglesApplyInRequestOrder(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("WBC_HOME", t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	a := New("test", store)
	if err := a.Start(); err != nil {
		t.Fatal(err)
	}
	defer a.Shutdown()
	e := gin.New()
	a.routes(e)
	send := func(network bool) chan struct{} {
		body := fmt.Sprintf(`{"network":%t}`, network)
		r := httptest.NewRequest(http.MethodPatch, "http://127.0.0.1:8327/companion/api/settings", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:50000"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Companion-Key", store.Get().PanelToken)
		w := httptest.NewRecorder()
		e.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("settings update returned %d: %s", w.Code, w.Body.String())
		}
		a.queueMu.Lock()
		done := a.queueTail
		a.queueMu.Unlock()
		return done
	}
	onDone := send(true)
	offDone := send(false) // arrives while the first change is still delayed
	for _, step := range []struct {
		done chan struct{}
		want bool
		host string
	}{{onDone, true, "0.0.0.0"}, {offDone, false, "127.0.0.1"}} {
		select {
		case <-step.done:
		case <-time.After(45 * time.Second):
			t.Fatal("queued network change did not finish")
		}
		if store.Get().Network != step.want || a.Proxy.Host() != step.host {
			t.Fatalf("queued network change finished with network=%v host=%q, want %v and %q", store.Get().Network, a.Proxy.Host(), step.want, step.host)
		}
	}
}

func TestConcurrentSettingsRestartsKeepProxyConfigCurrent(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	a := New("test", store)
	if err := a.Start(); err != nil {
		t.Fatal(err)
	}
	defer a.Shutdown()
	free, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := free.Addr().(*net.TCPAddr).Port
	_ = free.Close()
	operations := []func() error{func() error { return a.SetNetwork(false) }, func() error { return a.SetPort(port) }, a.RotateKey}
	var wg sync.WaitGroup
	errs := make(chan error, len(operations))
	for _, op := range operations {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- op()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(paths.ProxyConfig())
	if err != nil {
		t.Fatal(err)
	}
	config := string(data)
	if !a.Proxy.Running() || !strings.Contains(config, fmt.Sprintf("port: %d", a.Proxy.Port())) ||
		!strings.Contains(config, store.Get().APIKey) {
		t.Fatalf("proxy config does not match the final port and API key (running=%v port=%d)", a.Proxy.Running(), a.Proxy.Port())
	}
}
