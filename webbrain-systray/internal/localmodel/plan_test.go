package localmodel

import (
	"strings"
	"testing"

	"github.com/esokullu/webbrain-systray/internal/settings"
	"github.com/esokullu/webbrain-systray/internal/sysinfo"
)

const g = uint64(sysinfo.GiB)

func nvidia(name string, vram, free uint64, cuda string) *sysinfo.GPU {
	return &sysinfo.GPU{Vendor: "nvidia", Name: name, MemoryBytes: vram * g, FreeBytes: free * g, CUDA: cuda}
}

// The mmproj decision for typical machines: on the GPU when about 1 GB of GPU
// memory is left after the model, on the CPU when only system RAM has room
// (never on Apple Silicon, where it would compete for the same memory), else off.
func TestPlanVisionByMachine(t *testing.T) {
	cases := []struct {
		name    string
		info    sysinfo.Info
		backend string
		layers  string // full | partial | none
		vision  string
		fits    bool
	}{
		{"MacBook Air 8 GB", sysinfo.Info{OS: "darwin", Arch: "arm64", AppleSilicon: true, MemoryBytes: 8 * g, AvailableBytes: 5 * g}, "metal", "partial", "off", false},
		{"MacBook Pro 16 GB", sysinfo.Info{OS: "darwin", Arch: "arm64", AppleSilicon: true, MemoryBytes: 16 * g, AvailableBytes: 10 * g}, "metal", "full", "gpu", true},
		{"Mac Studio 64 GB", sysinfo.Info{OS: "darwin", Arch: "arm64", AppleSilicon: true, MemoryBytes: 64 * g, AvailableBytes: 40 * g}, "metal", "full", "gpu", true},
		{"RTX 4060 Laptop 8 GB", sysinfo.Info{OS: "windows", Arch: "amd64", MemoryBytes: 16 * g, AvailableBytes: 10 * g, GPU: nvidia("RTX 4060 Laptop GPU", 8, 7, "12.8")}, "cuda", "partial", "cpu", true},
		{"RTX 3060 12 GB", sysinfo.Info{OS: "windows", Arch: "amd64", MemoryBytes: 32 * g, AvailableBytes: 20 * g, GPU: nvidia("RTX 3060", 12, 11, "13.0")}, "cuda", "full", "gpu", true},
		{"RTX 4090 24 GB", sysinfo.Info{OS: "linux", Arch: "amd64", MemoryBytes: 64 * g, AvailableBytes: 50 * g, GPU: nvidia("RTX 4090", 24, 23, "13.0")}, "cuda", "full", "gpu", true},
		{"Radeon 8 GB (Vulkan)", sysinfo.Info{OS: "linux", Arch: "amd64", MemoryBytes: 32 * g, AvailableBytes: 24 * g, Vulkan: true, GPU: &sysinfo.GPU{Vendor: "amd", Name: "Radeon RX 7600", MemoryBytes: 8 * g}}, "vulkan", "partial", "cpu", true},
		{"CPU only, 16 GB", sysinfo.Info{OS: "windows", Arch: "amd64", MemoryBytes: 16 * g, AvailableBytes: 9 * g}, "cpu", "none", "cpu", true},
		{"CPU only, 8 GB", sysinfo.Info{OS: "windows", Arch: "amd64", MemoryBytes: 8 * g, AvailableBytes: 4 * g}, "cpu", "none", "off", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := MakePlan(c.info, settings.Local{}, "gguf")
			layers := "partial"
			switch {
			case p.GPULayers >= totalLayers:
				layers = "full"
			case p.GPULayers == 0:
				layers = "none"
			}
			if p.Backend != c.backend || layers != c.layers || p.Vision != c.vision || p.Fits != c.fits {
				t.Fatalf("got backend=%s layers=%s(%d) vision=%s fits=%v; want %s %s %s %v (%s)",
					p.Backend, layers, p.GPULayers, p.Vision, p.Fits, c.backend, c.layers, c.vision, c.fits, p.VisionReason)
			}
			if p.Context < 8192 || p.Context > 131072 {
				t.Fatalf("context %d out of range", p.Context)
			}
			if p.Vision != "off" && p.Backend != "cuda" && p.ImageMaxTokens != 1024 {
				t.Fatalf("image tokens not capped off CUDA: %d", p.ImageMaxTokens)
			}
			if len(p.Assets) == 0 {
				t.Fatal("no runtime assets")
			}
		})
	}
}

func TestPlanVisionOverrides(t *testing.T) {
	info := sysinfo.Info{OS: "windows", Arch: "amd64", MemoryBytes: 8 * g, AvailableBytes: 4 * g}
	for mode, want := range map[string]string{"off": "off", "gpu": "gpu", "cpu": "cpu", "auto": "off", "": "off"} {
		if got := MakePlan(info, settings.Local{Vision: mode}, "gguf").Vision; got != want {
			t.Errorf("mode %q: vision %s, want %s", mode, got, want)
		}
	}
}

func TestPlanRuntimeAssets(t *testing.T) {
	win := MakePlan(sysinfo.Info{OS: "windows", Arch: "amd64", MemoryBytes: 32 * g, GPU: nvidia("RTX 3060", 12, 11, "12.6")}, settings.Local{}, "gguf")
	if len(win.Assets) != 2 || !strings.Contains(win.Assets[0], "win-cuda-12.4-x64") || !strings.HasPrefix(win.Assets[1], "cudart-") {
		t.Errorf("windows CUDA 12.6 driver: %v", win.Assets)
	}
	old := MakePlan(sysinfo.Info{OS: "linux", Arch: "amd64", MemoryBytes: 32 * g, GPU: nvidia("GTX 1080", 8, 7, "11.8")}, settings.Local{}, "gguf")
	if old.Backend != "cpu" {
		t.Errorf("CUDA 11 driver should fall back to the CPU build, got %s", old.Backend)
	}
	for _, p := range [][]string{win.Assets, old.Assets} {
		for _, a := range p {
			if _, ok := llamaAssetSizes[a]; !ok {
				t.Errorf("asset %s has no pinned size", a)
			}
		}
	}
}

func TestPlanMLX(t *testing.T) {
	mac := MakePlan(sysinfo.Info{OS: "darwin", Arch: "arm64", AppleSilicon: true, MemoryBytes: 16 * g}, settings.Local{}, "mlx")
	if mac.Vision != "builtin" || !mac.Fits {
		t.Errorf("16 GB Apple Silicon MLX: vision=%s fits=%v (%s)", mac.Vision, mac.Fits, mac.Warning)
	}
	intel := MakePlan(sysinfo.Info{OS: "darwin", Arch: "amd64", MemoryBytes: 32 * g}, settings.Local{}, "mlx")
	if intel.Fits || intel.Warning == "" {
		t.Errorf("Intel Mac must not run MLX: fits=%v", intel.Fits)
	}
}
