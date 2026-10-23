//go:build linux

package sysinfo

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func meminfo(key string) uint64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, key+":") {
			fields := strings.Fields(line[len(key)+1:])
			if len(fields) > 0 {
				kb, _ := strconv.ParseUint(fields[0], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}

func totalMemory() uint64     { return meminfo("MemTotal") }
func availableMemory() uint64 { return meminfo("MemAvailable") }
func rosetta() bool           { return false }

func cpuName() string {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "model name") || strings.HasPrefix(line, "Model") {
			if i := strings.Index(line, ":"); i >= 0 {
				return strings.TrimSpace(line[i+1:])
			}
		}
	}
	return ""
}

// otherGPU reads AMD dedicated VRAM from sysfs (amdgpu exposes it).
func otherGPU() *GPU {
	cards, _ := filepath.Glob("/sys/class/drm/card*/device/mem_info_vram_total")
	var best *GPU
	for _, c := range cards {
		data, err := os.ReadFile(c)
		if err != nil {
			continue
		}
		v, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if err != nil || v < 2<<30 {
			continue
		}
		name := "AMD GPU"
		if b, err := os.ReadFile(filepath.Join(filepath.Dir(c), "product_name")); err == nil && len(strings.TrimSpace(string(b))) > 0 {
			name = strings.TrimSpace(string(b))
		}
		if best == nil || v > best.MemoryBytes {
			best = &GPU{Vendor: "amd", Name: name, MemoryBytes: v}
		}
	}
	return best
}
