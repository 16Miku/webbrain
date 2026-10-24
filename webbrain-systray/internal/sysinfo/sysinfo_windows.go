//go:build windows

package sysinfo

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

func memStatus() memoryStatusEx {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	_, _, _ = procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	return m
}

func totalMemory() uint64     { return memStatus().TotalPhys }
func availableMemory() uint64 { return memStatus().AvailPhys }
func rosetta() bool           { return false }

func cpuName() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	s, _, err := k.GetStringValue("ProcessorNameString")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

// otherGPU finds the display adapter with the most dedicated memory from the
// registry (qwMemorySize is exact above 4 GB, unlike WMI's AdapterRAM).
// Integrated adapters report little or no dedicated memory and are skipped.
func otherGPU() *GPU {
	const class = `SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, class, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil
	}
	defer k.Close()
	subs, _ := k.ReadSubKeyNames(-1)
	var best *GPU
	for _, s := range subs {
		sk, err := registry.OpenKey(registry.LOCAL_MACHINE, class+`\`+s, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		mem, _, err := sk.GetIntegerValue("HardwareInformation.qwMemorySize")
		name, _, _ := sk.GetStringValue("DriverDesc")
		sk.Close()
		if err != nil || mem < 6<<30 {
			continue
		}
		vendor := "other"
		lower := strings.ToLower(name)
		switch {
		case strings.Contains(lower, "nvidia"):
			vendor = "nvidia"
		case strings.Contains(lower, "amd") || strings.Contains(lower, "radeon"):
			vendor = "amd"
		case strings.Contains(lower, "intel"):
			vendor = "intel"
		}
		if best == nil || mem > best.MemoryBytes {
			best = &GPU{Vendor: vendor, Name: name, MemoryBytes: mem}
		}
	}
	return best
}
