// Package d1 hosts WebBrain's on-device decision model
// (webbrain-one/d1-browser-decision-fp32) natively: it downloads the pinned
// ONNX graphs and an ONNX Runtime build, then answers the same
// {state, images, questions} requests as the extension's WebGPU adapter.
package d1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/esokullu/webbrain-systray/internal/download"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

const (
	ModelName = "d1-browser-decision-fp32"
	Provider  = "companion_d1"
	repo      = "webbrain-one/d1-browser-decision-fp32"
	revision  = "9023fa407e3f17e02ad1fba1b921a0dc846dca89"

	ortVersion = "1.31.0"

	PhaseIdle        = "idle"
	PhaseDownloading = "downloading"
	PhaseInstalling  = "installing"
	PhaseLoading     = "loading"
	PhaseReady       = "ready"
	PhaseError       = "error"
)

// ErrNotReady is returned when a decision is requested before the model is installed.
var ErrNotReady = errors.New("the decision model is not installed; open the companion panel to install it")

type file struct {
	name string
	size int64
	sha  string
}

var modelFiles = []file{
	{"onnx/decision.data", 1522925568, "631417aa49dacb602b7e099062cd44c89e3747533a4094a61ff5f1cb3ccb0daf"},
	{"onnx/vision.data", 343372800, "490b694cf9a8770793e1cccc3d698bfb076f4b177216f9036e82eb0735b09390"},
	{"onnx/projector.data", 33566720, "e52c40550fbce097580870a7ddcca3f6992d93942931039ea717878514dd7a47"},
	{"onnx/decision.onnx", 366403, "ef66e7aa7f288fd71578cb6f6b71a04d6f531ad7755536487e155f66f605baf9"},
	{"onnx/vision.onnx", 119183, "aa7cbbabc0ee925ab4dd44a6c85dd7bf92ef36da5f2ebcdf1066f918d1a2ea89"},
	{"onnx/projector.onnx", 5712, "5489cd6636df06e474866ea55a37b06ec30a9fffcc993c89caff76639cc07d1e"},
	{"tokenizer.json", 4733371, "1efc3a6609abf6b63b1f47188d139f3b59973a6a434dffe970a7261a51ed2711"},
	{"config.json", 1765, "68ddf4bd4f3e489455211f80836b36281115cb9206b8e8d47858d062bdb6508d"},
	{"tiling-ratios.json", 681, "256b18bf3b533c9aaa34099b049e688893282341fb078b772b3ecb7b59ab43b6"},
}

type ortAsset struct {
	archive string
	size    int64
	sha     string
	lib     string // library path inside the archive (after the top folder)
}

func ortForPlatform() (ortAsset, bool) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64":
		return ortAsset{"onnxruntime-linux-x64-" + ortVersion + ".tgz", 11408003, ortSHA["linux-x64"], "lib/libonnxruntime.so." + ortVersion}, true
	case "linux/arm64":
		return ortAsset{"onnxruntime-linux-aarch64-" + ortVersion + ".tgz", 10331104, ortSHA["linux-aarch64"], "lib/libonnxruntime.so." + ortVersion}, true
	case "darwin/arm64":
		return ortAsset{"onnxruntime-osx-arm64-" + ortVersion + ".tgz", 36549009, ortSHA["osx-arm64"], "lib/libonnxruntime." + ortVersion + ".dylib"}, true
	case "windows/amd64":
		return ortAsset{"onnxruntime-win-x64-" + ortVersion + ".zip", 82887349, ortSHA["win-x64"], "lib/onnxruntime.dll"}, true
	case "windows/arm64":
		return ortAsset{"onnxruntime-win-arm64-" + ortVersion + ".zip", 85806468, ortSHA["win-arm64"], "lib/onnxruntime.dll"}, true
	}
	return ortAsset{}, false
}

func modelDir() string { return filepath.Join(paths.Models(), ModelName) }
func ortDir() string   { return filepath.Join(paths.Runtimes(), "onnxruntime-"+ortVersion) }

func ortLibPath() string {
	a, ok := ortForPlatform()
	if !ok {
		return ""
	}
	return filepath.Join(ortDir(), filepath.FromSlash(a.lib))
}

type Status struct {
	Model         string             `json:"model"`
	Phase         string             `json:"phase"`
	Step          string             `json:"step,omitempty"`
	Progress      *download.Progress `json:"progress,omitempty"`
	Error         string             `json:"error,omitempty"`
	Installed     bool               `json:"installed"`
	Supported     bool               `json:"supported"`
	Enabled       bool               `json:"enabled"`
	Runtime       string             `json:"runtime,omitempty"`
	DownloadBytes int64              `json:"download_bytes"`
	DiskBytes     int64              `json:"disk_bytes"`
	Endpoint      string             `json:"endpoint"`
	Requests      int64              `json:"requests"`
	LastLatencyMs float64            `json:"last_latency_ms,omitempty"`
	License       string             `json:"license"`
}

type Manager struct {
	mu       sync.Mutex
	store    *settings.Store
	onChange func()
	phase    string
	step     string
	progress *download.Progress
	err      string
	cancel   context.CancelFunc
	eng      *engine
	evalMu   sync.Mutex
	verifyMu sync.Mutex
	verified map[string]verifiedFile
	requests int64
	latency  float64
}

type verifiedFile struct {
	size    int64
	modTime time.Time
	sha     string
}

func NewManager(store *settings.Store, onChange func()) *Manager {
	return &Manager{store: store, onChange: onChange, phase: PhaseIdle}
}

func (m *Manager) changed() {
	if m.onChange != nil {
		go m.onChange()
	}
}

func okFile(path string, size int64) bool {
	st, err := os.Stat(path)
	return err == nil && st.Size() == size
}

// validFile checks the pinned hash once per unchanged file in this process.
// Status calls this often, so rehashing the 1.9 GB model on every refresh
// would make the panel unusable.
func (m *Manager) validFile(path string, size int64, sha string) bool {
	m.verifyMu.Lock()
	defer m.verifyMu.Unlock()
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() || st.Size() != size {
		delete(m.verified, path)
		return false
	}
	if sha == "" {
		return true
	}
	if v, ok := m.verified[path]; ok && v.size == size && v.modTime.Equal(st.ModTime()) && v.sha == sha {
		return true
	}
	delete(m.verified, path)
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	h := sha256.New()
	_, err = io.Copy(h, f)
	_ = f.Close()
	if err != nil || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), sha) {
		return false
	}
	after, err := os.Stat(path)
	if err != nil || after.Size() != size || !after.ModTime().Equal(st.ModTime()) {
		return false
	}
	if m.verified == nil {
		m.verified = make(map[string]verifiedFile)
	}
	m.verified[path] = verifiedFile{size: size, modTime: st.ModTime(), sha: sha}
	return true
}

// Installed reports whether the model files and runtime are present.
func (m *Manager) Installed() bool {
	if _, ok := ortForPlatform(); !ok {
		return false
	}
	for _, f := range modelFiles {
		if !m.validFile(filepath.Join(modelDir(), filepath.FromSlash(f.name)), f.size, f.sha) {
			return false
		}
	}
	_, err := os.Stat(ortLibPath())
	return err == nil
}

func (m *Manager) Status() Status {
	_, supported := ortForPlatform()
	st := Status{Model: ModelName, Supported: supported, Installed: m.Installed(), Enabled: m.store.Get().Decision.Enabled,
		License: "LFM Open License v1.0"}
	for _, f := range modelFiles {
		p := filepath.Join(modelDir(), filepath.FromSlash(f.name))
		if m.validFile(p, f.size, f.sha) {
			st.DiskBytes += f.size
			continue
		}
		rem := f.size
		if s, err := os.Stat(p + ".part"); err == nil && s.Size() < f.size {
			rem -= s.Size()
		}
		st.DownloadBytes += rem
	}
	if a, ok := ortForPlatform(); ok {
		if _, err := os.Stat(ortLibPath()); err != nil {
			st.DownloadBytes += a.size
		}
	}
	m.mu.Lock()
	st.Phase, st.Step, st.Error = m.phase, m.step, m.err
	if m.progress != nil {
		p := *m.progress
		st.Progress = &p
	}
	if m.eng != nil {
		st.Runtime = "ONNX Runtime " + m.eng.ort.version + " on the CPU"
	}
	st.Requests, st.LastLatencyMs = m.requests, m.latency
	m.mu.Unlock()
	return st
}

func (m *Manager) set(phase, step string, err error) {
	m.mu.Lock()
	m.phase, m.step = phase, step
	m.err = ""
	if err != nil {
		m.err = err.Error()
	}
	if phase != PhaseDownloading {
		m.progress = nil
	}
	m.mu.Unlock()
	m.changed()
}

// Install downloads the model and runtime, then loads them.
func (m *Manager) Install() error {
	asset, ok := ortForPlatform()
	if !ok {
		return errors.New("ONNX Runtime " + ortVersion + " has no build for this platform")
	}
	m.mu.Lock()
	if m.phase == PhaseDownloading || m.phase == PhaseInstalling || m.phase == PhaseLoading {
		m.mu.Unlock()
		return errors.New("already installing")
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.mu.Unlock()
	go func() {
		defer cancel()
		if err := m.install(ctx, asset); err != nil {
			if errors.Is(err, context.Canceled) {
				m.set(PhaseIdle, "", nil)
				return
			}
			logx.Printf("decision model install: %v", err)
			m.set(PhaseError, "", err)
			return
		}
		_, _ = m.store.Update(func(s *settings.Settings) { s.Decision.Enabled = true })
		if err := m.Load(); err != nil {
			logx.Printf("decision model load: %v", err)
		}
	}()
	return nil
}

func (m *Manager) Cancel() {
	m.mu.Lock()
	c := m.cancel
	m.mu.Unlock()
	if c != nil {
		c()
	}
}

func (m *Manager) install(ctx context.Context, asset ortAsset) error {
	type item struct {
		label, url, dest string
		size             int64
		sha              string
	}
	var items []item
	for _, f := range modelFiles {
		items = append(items, item{"d1 decision model", fmt.Sprintf("https://huggingface.co/%s/resolve/%s/%s", repo, revision, f.name),
			filepath.Join(modelDir(), filepath.FromSlash(f.name)), f.size, f.sha})
	}
	archive := filepath.Join(paths.Runtimes(), "_downloads", asset.archive)
	needORT := !okFileAny(ortLibPath())
	if needORT {
		items = append(items, item{"ONNX Runtime " + ortVersion, "https://github.com/microsoft/onnxruntime/releases/download/v" + ortVersion + "/" + asset.archive,
			archive, asset.size, asset.sha})
	}
	var total, done int64
	for _, it := range items {
		if !m.validFile(it.dest, it.size, it.sha) {
			total += it.size
		}
	}
	for _, it := range items {
		if m.validFile(it.dest, it.size, it.sha) {
			continue
		}
		var before int64
		if s, err := os.Stat(it.dest + ".part"); err == nil {
			before = s.Size()
		}
		base := done
		m.mu.Lock()
		m.phase, m.step = PhaseDownloading, it.label
		m.progress = &download.Progress{Done: base + before, Total: total}
		m.mu.Unlock()
		m.changed()
		err := download.File(ctx, it.url, it.dest, it.size, it.sha, func(p download.Progress) {
			m.mu.Lock()
			m.progress = &download.Progress{Done: base + p.Done, Total: total, BytesPerSec: p.BytesPerSec}
			m.mu.Unlock()
			m.changed()
		})
		if err != nil {
			return fmt.Errorf("%s: %w", it.label, err)
		}
		done = base + it.size
	}
	if needORT {
		m.set(PhaseInstalling, "Unpacking ONNX Runtime", nil)
		_ = os.RemoveAll(ortDir())
		keep := func(rel string) bool {
			// Only the runtime libraries: skip headers, symbols (a 430 MB .pdb) and test data.
			if !strings.HasPrefix(rel, "lib/") || strings.Contains(rel, ".dSYM") {
				return false
			}
			return strings.HasSuffix(rel, ".dll") || strings.HasSuffix(rel, ".dylib") || strings.Contains(rel, ".so")
		}
		if err := download.ExtractFiltered(archive, ortDir(), download.CommonPrefixDepth(archive), keep); err != nil {
			return fmt.Errorf("unpack ONNX Runtime: %w", err)
		}
		if runtime.GOOS == "darwin" {
			trustMac(ortDir())
		}
		if !okFileAny(ortLibPath()) {
			return errors.New("ONNX Runtime library missing from the archive")
		}
		_ = os.Remove(archive)
	}
	return nil
}

func okFileAny(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// Load creates the ONNX Runtime sessions (about 2 GB of memory).
func (m *Manager) Load() error {
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	return m.load()
}

// load requires evalMu so sessions cannot be replaced or released during use.
func (m *Manager) load() error {
	if !m.Installed() {
		return ErrNotReady
	}
	m.mu.Lock()
	if m.eng != nil {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	m.set(PhaseLoading, "Loading graphs", nil)
	threads := m.store.Get().Decision.Threads
	eng, err := loadEngine(modelDir(), ortLibPath(), threads)
	if err != nil {
		m.set(PhaseError, "", err)
		return err
	}
	m.mu.Lock()
	m.eng = eng
	m.mu.Unlock()
	m.set(PhaseReady, "", nil)
	logx.Printf("decision model ready (ONNX Runtime %s)", eng.ort.version)
	return nil
}

// Unload releases the sessions (the runtime library stays mapped).
func (m *Manager) Unload() {
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	m.unload()
}

// unload requires evalMu.
func (m *Manager) unload() {
	m.mu.Lock()
	eng := m.eng
	m.eng = nil
	if m.phase == PhaseReady {
		m.phase = PhaseIdle
	}
	m.mu.Unlock()
	if eng != nil {
		eng.close()
	}
	m.changed()
}

// Remove deletes the model files.
func (m *Manager) Remove() error {
	m.Cancel()
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	m.unload()
	if err := os.RemoveAll(modelDir()); err != nil {
		return err
	}
	_, _ = m.store.Update(func(s *settings.Settings) { s.Decision.Enabled = false })
	m.set(PhaseIdle, "", nil)
	return nil
}

// engine requires evalMu to keep the returned sessions alive for the caller.
func (m *Manager) engine() (*engine, error) {
	m.mu.Lock()
	eng := m.eng
	m.mu.Unlock()
	if eng != nil {
		return eng, nil
	}
	if !m.Installed() {
		return nil, ErrNotReady
	}
	if err := m.load(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.eng == nil {
		return nil, ErrNotReady
	}
	return m.eng, nil
}

// EvaluateJSON answers one {state, images, questions} request.
func (m *Manager) EvaluateJSON(ctx context.Context, body []byte) (any, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, err
	}
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	eng, err := m.engine()
	if err != nil {
		return nil, err
	}
	start := time.Now()
	res, err := eng.evaluate(ctx, req, ModelName)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.requests++
	m.latency = float64(time.Since(start).Microseconds()) / 1000
	m.mu.Unlock()
	m.changed()
	return res, nil
}

// SelfTest runs a small text-only decision.
func (m *Manager) SelfTest(ctx context.Context) (any, error) {
	body, _ := json.Marshal(map[string]any{
		"state": "Checkout complete. Order #1042 is confirmed and a receipt was sent to your email.",
		"questions": json.RawMessage(`{"completion":{"type":"choice","instructions":"Judge only the visible evidence: did the shopping task finish?",` +
			`"criteria":{"completed":"An explicit confirmation shows the order was placed.","not_completed":"The page shows an error or an unfinished checkout.","unknown":"The evidence does not establish the outcome."}}}`),
	})
	return m.EvaluateJSON(ctx, body)
}

func trustMac(dir string) {
	if runtime.GOOS != "darwin" {
		return
	}
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(p, ".dylib") {
			_ = execQuiet("/usr/bin/xattr", "-c", p)
			_ = execQuiet("/usr/bin/codesign", "-s", "-", "--force", "--timestamp=none", p)
		}
		return nil
	})
}
