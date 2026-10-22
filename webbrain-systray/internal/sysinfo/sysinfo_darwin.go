//go:build darwin

package sysinfo

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func totalMemory() uint64 {
	v, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return v
}

var vmStatRe = regexp.MustCompile(`Pages (free|inactive|speculative|purgeable):\s+(\d+)`)

func availableMemory() uint64 {
	out, err := run(3*time.Second, "/usr/bin/vm_stat")
	if err != nil {
		return 0
	}
	page := uint64(16384)
	if i := strings.Index(out, "page size of "); i >= 0 {
		rest := out[i+len("page size of "):]
		if j := strings.Index(rest, " "); j > 0 {
			if v, err := strconv.ParseUint(rest[:j], 10, 64); err == nil {
				page = v
			}
		}
	}
	var pages uint64
	for _, m := range vmStatRe.FindAllStringSubmatch(out, -1) {
		v, _ := strconv.ParseUint(m[2], 10, 64)
		pages += v
	}
	return pages * page
}

// rosetta reports an amd64 build running translated on Apple Silicon.
func rosetta() bool {
	v, err := unix.SysctlUint32("sysctl.proc_translated")
	return err == nil && v == 1
}

func cpuName() string {
	s, err := unix.Sysctl("machdep.cpu.brand_string")
	if err != nil {
		return ""
	}
	return s
}

func otherGPU() *GPU { return nil }
