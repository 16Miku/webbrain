package app

import (
	"net"
	"strings"
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
