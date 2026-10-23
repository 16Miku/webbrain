//go:build !windows

package osutil

func setRunKey(bool, string) error { return nil }
func runKeyExists() bool           { return false }
