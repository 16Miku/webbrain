// Package sysinfo describes the machine well enough to size a local model:
// memory, the GPU and its memory, and which llama.cpp build fits.
package sysinfo

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/esokullu/webbrain-systray/internal/osutil"
)

const GiB = 1 << 30

type GPU struct {
	Vendor      string `json:"vendor"` // nvidia | apple | other
	Name        string `json:"name"`
	MemoryBytes uint64 `json:"memory_bytes"` // dedicated VRAM; for Apple, the GPU working-set budget
	FreeBytes   uint64 `json:"free_bytes,omitempty"`
	CUDA        string `json:"cuda,omitempty"` // driver-supported CUDA version, e.g. "13.0"
}

type Info struct {
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	CPU            string `json:"cpu"`
	Cores          int    `json:"cores"`
	MemoryBytes    uint64 `json:"memory_bytes"`
	AvailableBytes uint64 `json:"available_bytes,omitempty"`
	AppleSilicon   bool   `json:"apple_silicon"`
	Vulkan         bool   `json:"vulkan"`
	GPU            *GPU   `json:"gpu,omitempty"`
}

// MemoryGiB is total memory in whole GiB (as Bonsai's tiers count it).
func (i Info) MemoryGiB() int { return int(i.MemoryBytes / GiB) }

// Summary is a one-line human description, e.g. "Apple M4 Max · 64 GB unified".
func (i Info) Summary() string {
	mem := fmt.Sprintf("%d GB", (i.MemoryBytes+GiB/2)/GiB)
	if i.AppleSilicon {
		return fmt.Sprintf("%s with %s unified memory", strings.TrimSpace(i.CPU), mem)
	}
	if i.GPU != nil && i.GPU.Vendor == "nvidia" {
		return fmt.Sprintf("%s (%d GB) and %s RAM", i.GPU.Name, (i.GPU.MemoryBytes+GiB/2)/GiB, mem)
	}
	cpu := strings.TrimSpace(i.CPU)
	if cpu == "" {
		cpu = runtime.GOARCH + " CPU"
	}
	return fmt.Sprintf("%s with %s RAM", cpu, mem)
}

var (
	cacheMu sync.Mutex
	cached  *Info
	cacheAt time.Time
)

// Get returns machine info; GPU probing is cached for a few minutes.
func Get() Info {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if cached != nil && time.Since(cacheAt) < 3*time.Minute {
		c := *cached
		c.AvailableBytes = availableMemory()
		return c
	}
	info := Info{OS: runtime.GOOS, Arch: runtime.GOARCH, Cores: runtime.NumCPU()}
	info.MemoryBytes = totalMemory()
	info.AvailableBytes = availableMemory()
	info.CPU = cpuName()
	if runtime.GOOS == "darwin" && (runtime.GOARCH == "arm64" || rosetta()) {
		info.AppleSilicon = true
		info.Arch = "arm64"
		// Metal may use about three quarters of unified memory by default.
		info.GPU = &GPU{Vendor: "apple", Name: strings.TrimSpace(info.CPU) + " GPU", MemoryBytes: info.MemoryBytes * 3 / 4}
	} else if g := nvidia(); g != nil {
		info.GPU = g
	} else if g := otherGPU(); g != nil {
		info.GPU = g
	}
	if runtime.GOOS != "darwin" {
		info.Vulkan = hasVulkan()
	}
	cached = &info
	cacheAt = time.Now()
	return info
}

func run(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := osutil.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// FindExecutable looks in PATH and then in extra well-known locations.
func FindExecutable(name string, extra ...string) string {
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		name += ".exe"
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, dir := range extra {
		p := filepath.Join(os.ExpandEnv(dir), name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

var cudaRe = regexp.MustCompile(`CUDA(?:\s+UMD)?\s+Version:\s+(\d+)\.(\d+)`)

func nvidia() *GPU {
	smi := FindExecutable("nvidia-smi",
		`${SystemRoot}\System32`, `${ProgramFiles}\NVIDIA Corporation\NVSMI`, "/usr/bin", "/usr/local/bin", "/usr/lib/wsl/lib")
	if smi == "" {
		return nil
	}
	out, err := run(8*time.Second, smi, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits")
	if err != nil {
		return nil
	}
	var best *GPU
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		parts := strings.Split(sc.Text(), ",")
		if len(parts) < 3 {
			continue
		}
		total, err1 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		free, _ := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
		if err1 != nil {
			continue
		}
		g := &GPU{Vendor: "nvidia", Name: strings.TrimSpace(parts[0]),
			MemoryBytes: uint64(total * 1024 * 1024), FreeBytes: uint64(free * 1024 * 1024)}
		// Prefer the card with the most memory (a display-only card may be first).
		if best == nil || g.MemoryBytes > best.MemoryBytes {
			best = g
		}
	}
	if best == nil {
		return nil
	}
	if plain, err := run(8*time.Second, smi); err == nil {
		if m := cudaRe.FindStringSubmatch(plain); m != nil {
			best.CUDA = m[1] + "." + m[2]
		}
	}
	return best
}

// hasVulkan reports a usable Vulkan loader on a machine that also has a
// GPU device; a loader alone (common in containers and on servers) is not
// enough.
func hasVulkan() bool {
	switch runtime.GOOS {
	case "windows":
		if _, err := os.Stat(filepath.Join(os.Getenv("SystemRoot"), "System32", "vulkan-1.dll")); err != nil {
			return false
		}
		return true
	case "linux":
		nodes, _ := filepath.Glob("/dev/dri/renderD*")
		if len(nodes) == 0 {
			return false
		}
		if FindExecutable("vulkaninfo") != "" {
			return true
		}
		for _, p := range []string{"/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/usr/lib/aarch64-linux-gnu/libvulkan.so.1"} {
			if _, err := os.Stat(p); err == nil {
				return true
			}
		}
	}
	return false
}
