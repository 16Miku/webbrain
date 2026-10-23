package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestWaitForStartingInstance(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	s := settings.Settings{Port: 0, PanelToken: "test-panel-token"}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Settings(), data, 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/companion/v1/info" {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"app": "webbrain-companion", "instance_id": settings.InstanceID(s.PanelToken),
			})
		}
	}))
	defer server.Close()
	_, rawPort, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		data, _ := json.Marshal(runtimeInfo{Port: port})
		_ = os.WriteFile(runtimeFile(), data, 0o600)
	}()
	gotPort, gotSettings, ok := waitForInstance(2 * time.Second)
	if !ok || gotPort != port || gotSettings.PanelToken != s.PanelToken {
		t.Fatalf("waitForInstance: got port %d, token %q, found %v", gotPort, gotSettings.PanelToken, ok)
	}
}

func TestExistingInstanceRejectsAnotherInstallation(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"app": "webbrain-companion", "instance_id": settings.InstanceID("another-panel-token"),
		})
	}))
	defer server.Close()
	_, rawPort, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := existingInstance(settings.Settings{Port: port, PanelToken: "this-panel-token"}); ok {
		t.Fatalf("accepted unrelated companion on port %d", got)
	}
}
