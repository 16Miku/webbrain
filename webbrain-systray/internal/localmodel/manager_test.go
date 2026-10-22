package localmodel

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/core"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestLocalModelExitHelper(t *testing.T) {
	if os.Getenv("WBC_EXIT_HELPER") == "1" {
		os.Exit(0)
	}
}

func TestStartClaimPreventsOverlappingLaunches(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	starting := make(chan struct{})
	m.starting = starting // first launch has claimed Start but not published cmd
	if err := m.Start(); err != nil {
		t.Fatalf("overlapping Start should reuse the pending launch: %v", err)
	}
	stopped := make(chan struct{})
	go func() {
		m.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("Stop returned before the in-flight Start settled")
	case <-time.After(25 * time.Millisecond):
	}
	m.mu.Lock()
	m.starting = nil
	m.mu.Unlock()
	close(starting)
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not finish after Start settled")
	}
}

func TestInstallClaimsPhaseBeforeWorkerStarts(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	if err := m.Install("gguf"); err != nil {
		t.Fatal(err)
	}
	defer m.Cancel()
	if err := m.Install("gguf"); err == nil {
		t.Fatal("overlapping install was accepted")
	}
}

func TestRuntimeArchivesHavePinnedChecksums(t *testing.T) {
	for asset, size := range llamaAssetSizes {
		if size <= 0 || len(llamaAssetSHA[asset]) != 64 {
			t.Errorf("llama runtime %s has no valid size and SHA-256", asset)
		}
	}
	for _, asset := range []string{uvAsset("arm64"), uvAsset("amd64")} {
		pinned, ok := uvAssets[asset]
		if !ok || pinned.Size <= 0 || len(pinned.SHA256) != 64 {
			t.Errorf("uv runtime %s has no valid size and SHA-256", asset)
		}
	}
}

func TestRuntimeRejectsLegacyUnverifiedMarker(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	plan := Plan{Assets: []string{"llama-" + llamaTag + "-bin-win-cpu-x64.zip"}}
	if err := os.MkdirAll(runtimeDir(plan), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(runtimeDir(plan), ".installed")
	if err := os.WriteFile(marker, []byte(llamaTag+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if runtimeInstalled(plan) {
		t.Fatal("legacy runtime marker bypassed pinned archive verification")
	}
}

func TestUVRejectsUnverifiedInstall(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	if err := os.MkdirAll(uvDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uvDir(), "uv"), []byte("old uv"), 0o700); err != nil {
		t.Fatal(err)
	}
	if uvInstalled("arm64") {
		t.Fatal("uv without a pinned archive marker was accepted")
	}
}

func TestGGUFInstalledRejectsSameSizeCorruption(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	previous := gguf
	defer func() { gguf = previous }()
	hash := func(data []byte) string {
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	weights, projector := []byte("weights"), []byte("projector")
	gguf.Model = File{Name: "weights.gguf", Size: int64(len(weights)), SHA256: hash(weights)}
	gguf.Proj = File{Name: "projector.gguf", Size: int64(len(projector)), SHA256: hash(projector)}
	if err := os.MkdirAll(ggufDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	weightPath := filepath.Join(ggufDir(), gguf.Model.Name)
	projectorPath := filepath.Join(ggufDir(), gguf.Proj.Name)
	if err := os.WriteFile(weightPath, weights, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projectorPath, projector, 0o600); err != nil {
		t.Fatal(err)
	}
	plan := Plan{Assets: []string{"llama-" + llamaTag + "-bin-win-cpu-x64.zip"}}
	if err := os.MkdirAll(runtimeDir(plan), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest, ok := runtimeManifest(plan)
	if !ok {
		t.Fatal("test runtime has no pinned checksum")
	}
	if err := os.WriteFile(filepath.Join(runtimeDir(plan), ".installed"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil, nil, nil)
	if !m.ggufInstalled(plan) {
		t.Fatal("valid cached weights and projector were rejected")
	}
	bad := []byte("Weights")
	if err := os.WriteFile(weightPath, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(time.Minute)
	if err := os.Chtimes(weightPath, modified, modified); err != nil {
		t.Fatal(err)
	}
	if m.ggufInstalled(plan) || m.remaining(weightPath, gguf.Model.Size, gguf.Model.SHA256) != gguf.Model.Size {
		t.Fatal("same-sized corrupt weights were reported as installed")
	}
	if err := os.WriteFile(weightPath, weights, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projectorPath, []byte("Projector"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(projectorPath, modified, modified); err != nil {
		t.Fatal(err)
	}
	if m.ggufInstalled(plan) {
		t.Fatal("same-sized corrupt projector was reported as installed")
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
