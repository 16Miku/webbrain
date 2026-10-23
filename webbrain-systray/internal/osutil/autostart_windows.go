//go:build windows

package osutil

import "golang.org/x/sys/windows/registry"

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

func setRunKey(on bool, command string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		err := k.DeleteValue(autostartName)
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	return k.SetStringValue(autostartName, command)
}

func runKeyExists() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(autostartName)
	return err == nil
}
