package app

import (
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"testing"

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
