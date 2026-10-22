package localmodel

import (
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/core"
	"github.com/esokullu/webbrain-systray/internal/osutil"
)

func TestLocalModelExitHelper(t *testing.T) {
	if os.Getenv("WBC_EXIT_HELPER") == "1" {
		os.Exit(0)
	}
}

func TestStopWaitsForExitCleanup(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := osutil.Command(executable, "-test.run=^TestLocalModelExitHelper$")
	cmd.Env = append(os.Environ(), "WBC_EXIT_HELPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	cleanupStarted := make(chan struct{})
	finishCleanup := make(chan struct{})
	stopStarted := make(chan struct{})
	var calls atomic.Int32
	m := NewManager(nil, func([]core.LocalUpstream) error {
		switch calls.Add(1) {
		case 1:
			close(cleanupStarted)
			<-finishCleanup
		case 2:
			close(stopStarted)
		}
		return nil
	}, nil)
	m.cmd, m.exited, m.phase = cmd, make(chan struct{}), PhaseRunning
	go m.waitForExit(cmd, m.exited)
	<-cleanupStarted
	stopped := make(chan struct{})
	go func() {
		m.Stop()
		close(stopped)
	}()
	<-stopStarted
	select {
	case <-stopped:
		close(finishCleanup)
		t.Fatal("Stop returned before the previous server finished cleanup")
	case <-time.After(25 * time.Millisecond):
	}
	close(finishCleanup)
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return after cleanup finished")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil || m.phase != PhaseIdle {
		t.Fatalf("server remains active after Stop: cmd=%v phase=%s", m.cmd, m.phase)
	}
}
