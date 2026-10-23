//go:build darwin || linux

package d1

import "github.com/ebitengine/purego"

func openSymbol(lib, name string) (uintptr, error) {
	h, err := purego.Dlopen(lib, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return 0, err
	}
	return purego.Dlsym(h, name)
}
