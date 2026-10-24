//go:build windows

package d1

import "golang.org/x/sys/windows"

func openSymbol(lib, name string) (uintptr, error) {
	// Load by full path, resolving its dependencies next to it, so the older
	// onnxruntime.dll that Windows ships in System32 is never picked up.
	h, err := windows.LoadLibraryEx(lib, 0, windows.LOAD_WITH_ALTERED_SEARCH_PATH)
	if err != nil {
		return 0, err
	}
	return windows.GetProcAddress(h, name)
}
