package localmodel

import (
	"fmt"
	"math"

	"github.com/esokullu/webbrain-systray/internal/settings"
	"github.com/esokullu/webbrain-systray/internal/sysinfo"
)

const totalLayers = 64

// Plan is what the companion will run on this machine and why.
type Plan struct {
	Format         string   `json:"format"`
	Backend        string   `json:"backend"` // metal | cuda | vulkan | cpu | mlx
	BackendLabel   string   `json:"backend_label"`
	Assets         []string `json:"-"`
	GPULayers      int      `json:"gpu_layers"`
	Context        int      `json:"context"`
	Vision         string   `json:"vision"` // gpu | cpu | off | builtin
	VisionReason   string   `json:"vision_reason"`
	Fits           bool     `json:"fits"`
	Warning        string   `json:"warning,omitempty"`
	NeedBytes      int64    `json:"need_bytes"`
	BudgetBytes    int64    `json:"budget_bytes"`
	ImageMaxTokens int      `json:"image_max_tokens,omitempty"`
}

func gb(b int64) string { return fmt.Sprintf("%.1f GB", float64(b)/1e9) }

// contextForRAM mirrors Bonsai-demo's RAM-tiered default context.
func contextForRAM(totalGiB int) int {
	switch {
	case totalGiB <= 11:
		return 8192
	case totalGiB <= 23:
		return 16384
	case totalGiB <= 35:
		return 32768
	case totalGiB <= 71:
		return 65536
	default:
		return 131072
	}
}

// backendFor picks the PrismML llama.cpp build for this machine.
func backendFor(info sysinfo.Info) (backend, label string, assets []string, ngl int, budget int64) {
	ram := int64(info.MemoryBytes)
	avail := int64(info.AvailableBytes)
	if avail <= 0 || avail > ram {
		avail = ram * 7 / 10
	}
	cpuBudget := avail - int64(1536<<20)
	switch info.OS {
	case "darwin":
		if info.AppleSilicon {
			b := ram * 2 / 3
			if ram > 36*gib {
				b = ram * 3 / 4
			}
			return "metal", "Metal on the Apple GPU", []string{"llama-" + llamaTag + "-bin-macos-arm64.tar.gz"}, 99, b
		}
		return "cpu", "CPU (Intel Mac)", []string{"llama-" + llamaTag + "-bin-macos-x64.tar.gz"}, 0, cpuBudget
	case "linux":
		arch := "x64"
		if info.Arch == "arm64" {
			arch = "arm64"
		}
		if g := info.GPU; g != nil && g.Vendor == "nvidia" && arch == "x64" && g.CUDA != "" {
			var maj, min int
			fmt.Sscanf(g.CUDA, "%d.%d", &maj, &min)
			tag := ""
			switch {
			case maj > 13 || (maj == 13 && min >= 3):
				tag = "13.3"
			case maj == 13 || (maj == 12 && min >= 8):
				tag = "12.8"
			case maj == 12:
				tag = "12.4"
			}
			if tag != "" {
				return "cuda", "CUDA " + tag + " on " + g.Name, []string{"llama-" + llamaTag + "-bin-linux-cuda-" + tag + "-x64.tar.gz"}, 99, vram(g)
			}
		}
		if g := info.GPU; info.Vulkan && g != nil && g.MemoryBytes >= 6*uint64(gib) {
			return "vulkan", "Vulkan on " + g.Name, []string{"llama-" + llamaTag + "-bin-ubuntu-vulkan-" + arch + ".tar.gz"}, 99, vram(g)
		}
		return "cpu", "CPU", []string{"llama-" + llamaTag + "-bin-ubuntu-" + arch + ".tar.gz"}, 0, cpuBudget
	case "windows":
		if info.Arch == "arm64" {
			return "cpu", "CPU (Arm64)", []string{"llama-" + llamaTag + "-bin-win-cpu-arm64.zip"}, 0, cpuBudget
		}
		if g := info.GPU; g != nil && g.Vendor == "nvidia" && g.CUDA != "" {
			var maj, min int
			fmt.Sscanf(g.CUDA, "%d.%d", &maj, &min)
			tag := ""
			switch {
			case maj > 13 || (maj == 13 && min >= 3):
				tag = "13.3"
			case maj > 12 || (maj == 12 && min >= 4):
				tag = "12.4"
			}
			if tag != "" {
				return "cuda", "CUDA " + tag + " on " + g.Name,
					[]string{"llama-" + llamaTag + "-bin-win-cuda-" + tag + "-x64.zip", "cudart-llama-bin-win-cuda-" + tag + "-x64.zip"}, 99, vram(g)
			}
		}
		if g := info.GPU; info.Vulkan && g != nil && g.MemoryBytes >= 6*uint64(gib) {
			return "vulkan", "Vulkan on " + g.Name,
				[]string{"llama-" + llamaTag + "-bin-win-cpu-x64.zip", "llama-" + llamaTag + "-bin-win-vulkan-x64.zip"}, 99, vram(g)
		}
		return "cpu", "CPU", []string{"llama-" + llamaTag + "-bin-win-cpu-x64.zip"}, 0, cpuBudget
	}
	return "cpu", "CPU", nil, 0, cpuBudget
}

// vram is the usable dedicated memory: what is free now (other programs may
// hold some), less a small reserve for the driver and display.
func vram(g *sysinfo.GPU) int64 {
	if g.FreeBytes > 0 {
		return int64(g.FreeBytes) - 400<<20
	}
	return int64(g.MemoryBytes) - 1*gib
}

// MakePlan decides backend, context and — the user's ask — whether the
// vision projector (mmproj) is worth loading on this machine.
func MakePlan(info sysinfo.Info, s settings.Local, format string) Plan {
	ram := int64(info.MemoryBytes)
	if format == "mlx" {
		p := Plan{Format: "mlx", Backend: "mlx", BackendLabel: "MLX on the Apple GPU", GPULayers: 99, Vision: "builtin"}
		p.VisionReason = "The MLX pack ships its vision tower; image input is always on."
		p.Context = s.Context
		if p.Context == 0 {
			p.Context = contextForRAM(info.MemoryGiB())
		}
		weights := mlxPack.Files[0].Size
		p.BudgetBytes = ram * 2 / 3
		if ram > 36*gib {
			p.BudgetBytes = ram * 3 / 4
		}
		p.NeedBytes = weights + int64(p.Context)*kvBytesPerToken + computeBytes + stateBytes
		p.Fits = info.AppleSilicon && p.NeedBytes <= p.BudgetBytes
		if !info.AppleSilicon {
			p.Warning = "MLX needs a Mac with Apple Silicon."
		} else if !p.Fits {
			p.Warning = fmt.Sprintf("Needs about %s of GPU memory; this Mac offers %s. Use GGUF instead.", gb(p.NeedBytes), gb(p.BudgetBytes))
		}
		return p
	}

	backend, label, assets, ngl, budget := backendFor(info)
	p := Plan{Format: "gguf", Backend: backend, BackendLabel: label, Assets: assets, GPULayers: ngl, BudgetBytes: budget}
	weights := gguf.Model.Size
	ctx := s.Context
	auto := ctx == 0
	if auto {
		ctx = contextForRAM(info.MemoryGiB())
	}
	need := func(c int) int64 { return weights + int64(c)*kvBytesPerToken + computeBytes + stateBytes }
	if auto {
		for need(ctx) > budget && ctx > 8192 {
			ctx /= 2
		}
	}
	p.Context = ctx
	p.NeedBytes = need(ctx)

	// Whatever does not fit on the GPU stays in system RAM.
	if ngl > 0 && p.NeedBytes > budget {
		free := budget - int64(ctx)*kvBytesPerToken - computeBytes - stateBytes
		layers := int(math.Floor(float64(totalLayers) * float64(free) / float64(weights)))
		if layers < 4 {
			p.GPULayers = 0
			p.Warning = fmt.Sprintf("The GPU has %s free; the model needs %s, so it runs on the CPU.", gb(budget), gb(p.NeedBytes))
		} else {
			p.GPULayers = layers
			p.Warning = fmt.Sprintf("Only %d of %d layers fit in %s of GPU memory; the rest run on the CPU (slower).", layers, totalLayers, gb(budget))
		}
	}
	cpuShare := weights
	if p.GPULayers >= totalLayers || (p.GPULayers == 99) {
		cpuShare = 0
	} else if p.GPULayers > 0 {
		cpuShare = weights * int64(totalLayers-p.GPULayers) / totalLayers
	}
	ramFree := int64(info.AvailableBytes)
	if ramFree <= 0 || ramFree > ram {
		ramFree = ram * 7 / 10
	}
	if backend == "metal" {
		p.Fits = p.NeedBytes <= budget
		if !p.Fits {
			p.Warning = fmt.Sprintf("Needs about %s of GPU memory but this Mac offers %s; expect swapping.", gb(p.NeedBytes), gb(budget))
		}
	} else {
		p.Fits = ram >= weights+2*gib && (cpuShare == 0 || cpuShare+int64(ctx)*kvBytesPerToken <= ramFree)
		if !p.Fits && p.Warning == "" {
			p.Warning = fmt.Sprintf("Needs about %s of memory; %s is available.", gb(p.NeedBytes), gb(ramFree))
		}
	}

	// Vision projector decision.
	mode := s.Vision
	if mode == "" {
		mode = "auto"
	}
	gpuFull := p.GPULayers > 0 && p.NeedBytes <= budget
	ramHeadroom := ramFree - cpuShare
	switch mode {
	case "off":
		p.Vision, p.VisionReason = "off", "Turned off in settings."
	case "gpu":
		p.Vision, p.VisionReason = "gpu", "Forced on in settings."
	case "cpu":
		p.Vision, p.VisionReason = "cpu", "Projector kept in system RAM (settings)."
	default:
		switch {
		case gpuFull && p.NeedBytes+visionGPUBytes <= budget*95/100:
			p.Vision = "gpu"
			p.VisionReason = fmt.Sprintf("On: %s of %s GPU memory leaves room for the projector.", gb(p.NeedBytes+visionGPUBytes), gb(budget))
		case backend != "metal" && ramHeadroom >= visionCPUBytes+gib:
			p.Vision = "cpu"
			if gpuFull {
				p.VisionReason = "On, encoded on the CPU: GPU memory is too tight for the projector."
			} else {
				p.VisionReason = "On, encoded on the CPU from system RAM."
			}
		default:
			p.Vision = "off"
			p.VisionReason = "Off: not enough memory left for image input on this machine."
		}
	}
	if p.Vision != "off" && backend != "cuda" {
		p.ImageMaxTokens = 1024 // Bonsai-demo caps images off CUDA for latency
	}
	return p
}
