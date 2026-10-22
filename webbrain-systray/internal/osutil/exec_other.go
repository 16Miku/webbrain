//go:build !windows

package osutil

import (
	"os/exec"
	"syscall"
)

// Child processes get their own process group so a whole server tree can be
// stopped together.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}
