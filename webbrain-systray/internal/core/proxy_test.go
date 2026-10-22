package core

import (
	"testing"
	"time"
)

func TestPickPortMaximum(t *testing.T) {
	const host = "127.0.0.1"
	const port = 65535
	if !portFree(host, port) {
		t.Skip("port 65535 is unavailable")
	}
	got, err := PickPort(host, port, false)
	if err != nil {
		t.Fatalf("PickPort(%q, %d, false): %v", host, port, err)
	}
	if got != port {
		t.Fatalf("PickPort returned %d, want %d", got, port)
	}
}

func TestTimedOutStopKeepsProxyStateUntilExit(t *testing.T) {
	done := make(chan struct{})
	p := &Proxy{port: 8327, done: done, cancel: func() {}}
	p.stop(20 * time.Millisecond)
	if !p.Running() || p.Port() != 8327 {
		t.Fatalf("timed-out stop lost live proxy state: running=%v port=%d", p.Running(), p.Port())
	}
	close(done)
	if p.Running() || p.Port() != 0 {
		t.Fatalf("exited proxy still appears live: running=%v port=%d", p.Running(), p.Port())
	}
}

func TestRestartWaitsForPreviousProxyToExit(t *testing.T) {
	done := make(chan struct{})
	p := &Proxy{port: 8327, done: done, cancel: func() {}}
	stopped := make(chan struct{})
	go func() {
		p.StopForRestart()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("restart proceeded while old proxy was still alive")
	case <-time.After(25 * time.Millisecond):
	}
	close(done)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("restart did not proceed after old proxy exited")
	}
	if p.Port() != 0 {
		t.Fatal("stopped proxy retained its port")
	}
}
