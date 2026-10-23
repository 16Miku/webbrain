package localmodel

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/core"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestLocalModelExitHelper(t *testing.T) {
	if os.Getenv("WBC_EXIT_HELPER") == "1" {
		os.Exit(0)
	}
}

func TestLocalModelWaitHelper(t *testing.T) {
	if os.Getenv("WBC_WAIT_HELPER") == "1" {
		time.Sleep(30 * time.Second)
	}
}

func TestRegistrationFailureStopsServerAndReportsError(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := osutil.Command(executable, "-test.run=^TestLocalModelWaitHelper$")
	cmd.Env = append(os.Environ(), "WBC_WAIT_HELPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	m := NewManager(nil, func([]core.LocalUpstream) error { return nil }, nil)
	m.cmd, m.exited, m.phase = cmd, make(chan struct{}), PhaseStarting
	go m.waitForExit(cmd, m.exited)
	m.registrationFailed(errors.New("data volume full"))
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil || m.phase != PhaseError || !strings.Contains(m.err, "data volume full") {
		t.Fatalf("registration failure left cmd=%v phase=%q error=%q", m.cmd, m.phase, m.err)
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

func TestRestartIncludesStartingModel(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	m.phase = PhaseStarting
	if !m.Active() {
		t.Fatal("starting model was not considered active")
	}
	if err := m.Restart(); err == nil {
		t.Fatal("Restart skipped starting a replacement model")
	}
}

func TestExplicitStopOverridesQueuedRestart(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	m.phase = PhaseStarting
	if err := m.StopExplicit(); err != nil {
		t.Fatal(err)
	}
	if err := m.Restart(); err != nil {
		t.Fatalf("queued restart ran after explicit stop: %v", err)
	}
	if err := m.StartExplicit(); err == nil {
		t.Fatal("manual start did not clear the stop request and attempt a launch")
	}
}

func TestShutdownWaitsForLocalInstaller(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
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
	if err := m.Install("gguf"); err == nil {
		t.Fatal("installation started during shutdown")
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

func TestInstallDefaultPreservesAutostartChoice(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	if err := m.defaultAutoStart(); err != nil {
		t.Fatal(err)
	}
	if !store.Get().Local.AutoStart {
		t.Fatal("first install did not enable autostart by default")
	}
	if _, err := store.Update(func(s *settings.Settings) {
		s.Local.AutoStart = false
		s.Local.AutoStartConfigured = true
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.defaultAutoStart(); err != nil {
		t.Fatal(err)
	}
	if store.Get().Local.AutoStart {
		t.Fatal("install completion overwrote the user's disabled autostart choice")
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
	if err := m.Install("gguf"); err == nil {
		t.Fatal("overlapping install was accepted")
	}
}

func TestInstallRejectsFailedSettingsSaveBeforeDownload(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(paths.Settings()+".tmp", 0o700); err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	if err := m.Install("gguf"); err == nil {
		t.Fatal("install accepted a format preference that could not be saved")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.phase != PhaseIdle || m.cancel != nil {
		t.Fatal("failed preference save started an install worker")
	}
}

func TestRemoveReportsRuntimeDirectoryReadError(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Runtimes(), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	if err := m.Remove("gguf"); err == nil {
		t.Fatal("Remove reported success when runtime files could not be listed")
	}
	status := m.Status()
	if status.Phase != PhaseError || status.Error == "" {
		t.Fatalf("failed removal was not shown as an error: phase=%q error=%q", status.Phase, status.Error)
	}
}

func TestRemoveWaitsForInstallAndRejectsRetry(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Update(func(s *settings.Settings) { s.Local.AutoStart = true }); err != nil {
		t.Fatal(err)
	}
	model := filepath.Join(ggufDir(), "partial-model")
	if err := os.MkdirAll(ggufDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(model, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	done, cancelled := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-done:
		default:
			close(done)
		}
	})
	m := NewManager(store, func([]core.LocalUpstream) error { return nil }, nil)
	m.phase, m.installDone, m.cancel = PhaseDownloading, done, func() { close(cancelled) }
	removed := make(chan error, 1)
	go func() { removed <- m.Remove("gguf") }()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("Remove did not cancel the installer")
	}
	if !m.Busy() {
		t.Fatal("Remove did not reserve the manager")
	}
	if err := m.Install("gguf"); err == nil {
		t.Fatal("Retry started during removal")
	}
	if err := m.Start(); err == nil {
		t.Fatal("Start was accepted during removal")
	}
	if _, err := os.Stat(model); err != nil {
		t.Fatalf("Remove deleted files before the installer stopped: %v", err)
	}
	close(done)
	select {
	case err := <-removed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Remove did not finish after the installer stopped")
	}
	if _, err := os.Stat(model); !os.IsNotExist(err) {
		t.Fatalf("Remove left model files behind: %v", err)
	}
	if store.Get().Local.AutoStart {
		t.Fatal("Remove left autostart enabled")
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

func TestRuntimeInstalledRejectsMissingAndCorruptExtractedFiles(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	plan := Plan{Assets: []string{"llama-" + llamaTag + "-bin-win-cpu-x64.zip"}}
	dir := runtimeDir(plan)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	server := "llama-server"
	if runtime.GOOS == "windows" {
		server += ".exe"
	}
	serverPath := filepath.Join(dir, server)
	libraryPath := filepath.Join(dir, "libggml.so")
	if err := os.WriteFile(serverPath, []byte("server"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(libraryPath, []byte("library"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest, err := installedRuntimeManifest(plan)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".installed"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if !runtimeInstalled(plan) {
		t.Fatal("valid extracted runtime was rejected")
	}
	if err := os.Remove(libraryPath); err != nil {
		t.Fatal(err)
	}
	if runtimeInstalled(plan) {
		t.Fatal("runtime with a missing library was accepted")
	}
	if err := os.WriteFile(libraryPath, []byte("Library"), 0o600); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(time.Minute)
	if err := os.Chtimes(libraryPath, modified, modified); err != nil {
		t.Fatal(err)
	}
	if runtimeInstalled(plan) {
		t.Fatal("runtime with a same-sized corrupt library was accepted")
	}
	if err := os.WriteFile(libraryPath, []byte("library"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(libraryPath, modified.Add(time.Minute), modified.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if !runtimeInstalled(plan) {
		t.Fatal("repaired runtime was rejected")
	}
	if err := os.Remove(serverPath); err != nil {
		t.Fatal(err)
	}
	if runtimeInstalled(plan) {
		t.Fatal("runtime with a missing llama-server was accepted")
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

func TestUVInstalledRejectsCorruptOrNonExecutableBinary(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	if err := os.MkdirAll(uvDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(uvDir(), "uv")
	if err := os.WriteFile(bin, []byte("working uv"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest, err := installedUVManifest("arm64")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uvDir(), ".installed"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if !uvInstalled("arm64") {
		t.Fatal("valid extracted uv executable was rejected")
	}
	if err := os.WriteFile(bin, []byte("Working uv"), 0o700); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(time.Minute)
	if err := os.Chtimes(bin, modified, modified); err != nil {
		t.Fatal(err)
	}
	if uvInstalled("arm64") {
		t.Fatal("same-sized corrupted uv executable was accepted")
	}
	if err := os.WriteFile(bin, []byte("working uv"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(bin, modified.Add(time.Minute), modified.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if !uvInstalled("arm64") {
		t.Fatal("repaired uv executable was rejected")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(bin, 0o600); err != nil {
			t.Fatal(err)
		}
		if uvInstalled("arm64") {
			t.Fatal("uv executable without execute permission was accepted")
		}
	}
}

func TestMLXEnvironmentRejectsStaleDependencies(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	bin := filepath.Join(mlxVenv(), "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "python"), []byte("python"), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(mlxVenv(), ".installed")
	if err := os.WriteFile(marker, []byte("old packages\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if mlxEnvironmentInstalled() {
		t.Fatal("stale MLX dependency marker was accepted")
	}
	modulePaths := make([]string, 5)
	for i := range modulePaths {
		modulePaths[i] = filepath.Join(mlxVenv(), "lib", "python3.11", "site-packages", fmt.Sprintf("module-%d.py", i))
		if err := os.MkdirAll(filepath.Dir(modulePaths[i]), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(modulePaths[i], []byte("module"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	manifest, err := installedMLXManifest(modulePaths)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if !mlxEnvironmentInstalled() {
		t.Fatal("verified MLX environment was rejected")
	}
	if err := os.Remove(modulePaths[2]); err != nil {
		t.Fatal(err)
	}
	if mlxEnvironmentInstalled() {
		t.Fatal("MLX environment missing an installed package was accepted")
	}
	if err := os.WriteFile(modulePaths[2], []byte("module"), 0o600); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(filepath.Join(bin, "python"), 0o600); err != nil {
			t.Fatal(err)
		}
		if mlxEnvironmentInstalled() {
			t.Fatal("MLX environment with a non-executable Python was accepted")
		}
	}
}

func TestStopReportsFailedLocalModelUnregister(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := osutil.Command(executable, "-test.run=^TestLocalModelWaitHelper$")
	cmd.Env = append(os.Environ(), "WBC_WAIT_HELPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	var calls atomic.Int32
	m := NewManager(nil, func([]core.LocalUpstream) error {
		calls.Add(1)
		return errors.New("proxy config is read-only")
	}, nil)
	m.cmd, m.exited, m.phase = cmd, make(chan struct{}), PhaseRunning
	go m.waitForExit(cmd, m.exited)
	if err := m.Stop(); err == nil || !strings.Contains(err.Error(), "proxy config is read-only") {
		t.Fatalf("Stop hid unregister failure: %v", err)
	}
	if calls.Load() < 2 {
		t.Fatalf("expected unregister retry after process exit, got %d calls", calls.Load())
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.phase != PhaseError || !strings.Contains(m.err, "proxy config is read-only") {
		t.Fatalf("failed unregister reported phase=%q error=%q", m.phase, m.err)
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
	server := "llama-server"
	if runtime.GOOS == "windows" {
		server += ".exe"
	}
	if err := os.WriteFile(filepath.Join(runtimeDir(plan), server), []byte("server"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest, err := installedRuntimeManifest(plan)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir(plan), ".installed"), manifest, 0o600); err != nil {
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
