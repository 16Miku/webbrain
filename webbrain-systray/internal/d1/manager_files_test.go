package d1

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestInstallClaimsPhaseBeforeWorkerStarts(t *testing.T) {
	if _, ok := ortForPlatform(); !ok {
		t.Skip("no runtime archive for this platform")
	}
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, nil)
	if err := m.Install(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		m.Cancel()
		m.mu.Lock()
		done := m.installDone
		m.mu.Unlock()
		if done != nil {
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Error("install did not stop after cancellation")
			}
		}
	})
	if err := m.Install(); err == nil {
		t.Fatal("overlapping install was accepted")
	}
}

func TestRemoveWaitsForCanceledInstall(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, nil)
	installDone := make(chan struct{})
	canceled := make(chan struct{})
	m.installDone = installDone
	m.cancel = func() { close(canceled) }
	removed := make(chan error, 1)
	go func() { removed <- m.Remove() }()
	<-canceled
	select {
	case err := <-removed:
		t.Fatalf("Remove returned before install finished: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(installDone)
	select {
	case err := <-removed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Remove did not finish after install stopped")
	}
}

func TestShutdownWaitsForDecisionInstaller(t *testing.T) {
	m := NewManager(nil, nil)
	installDone, canceled := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-installDone:
		default:
			close(installDone)
		}
	})
	m.installDone, m.cancel = installDone, func() { close(canceled) }
	shutdownDone := make(chan struct{})
	go func() { m.BeginShutdown(); close(shutdownDone) }()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not cancel installation")
	}
	if err := m.Load(); err == nil {
		t.Fatal("decision model loaded during shutdown")
	}
	select {
	case <-shutdownDone:
		t.Fatal("shutdown returned before installation finished")
	case <-time.After(25 * time.Millisecond):
	}
	close(installDone)
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish after installation stopped")
	}
}

func TestValidFileRejectsSameSizeCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "model.data")
	good := []byte("pinned model contents")
	sum := sha256.Sum256(good)
	want := hex.EncodeToString(sum[:])
	m := NewManager(nil, nil)
	bad := []byte("xinned model contents")
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if m.validFile(path, int64(len(good)), want) {
		t.Fatal("same-sized corrupt file passed checksum verification")
	}
	if err := os.WriteFile(path, good, 0o600); err != nil {
		t.Fatal(err)
	}
	if !m.validFile(path, int64(len(good)), want) {
		t.Fatal("valid file did not pass checksum verification")
	}
	// A modified cached file must be rehashed on the next status or load.
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	if m.validFile(path, int64(len(good)), want) {
		t.Fatal("changed file reused a previous successful checksum")
	}
}

func TestORTRuntimeNeedsCompletedExtraction(t *testing.T) {
	asset, ok := ortForPlatform()
	if !ok {
		t.Skip("no runtime archive for this platform")
	}
	t.Setenv("WBC_HOME", t.TempDir())
	path := ortLibPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("complete runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil, nil)
	if m.ortReady(asset) {
		t.Fatal("library without completed-extraction marker was accepted")
	}
	if err := m.markORT(asset); err != nil {
		t.Fatal(err)
	}
	if !m.ortReady(asset) {
		t.Fatal("marked runtime was rejected")
	}
	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if m.ortReady(asset) {
		t.Fatal("truncated runtime was accepted")
	}
}
