//go:build !windows

package localmodel

import (
	"os/exec"
	"syscall"
)

// terminate asks the server's process group to exit cleanly.
func terminate(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
}
