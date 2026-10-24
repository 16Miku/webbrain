//go:build windows

package i18n

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

func systemLocale() string {
	buf := make([]uint16, 85)
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultLocaleName")
	n, _, _ := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}
