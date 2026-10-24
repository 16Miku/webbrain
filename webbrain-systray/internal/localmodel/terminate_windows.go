//go:build windows

package localmodel

import "os/exec"

// terminate kills the server; llama-server holds no state worth flushing.
func terminate(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
