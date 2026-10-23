package osutil

import (
	"context"
	"os/exec"
	"time"
)

// Command is exec.Command with the platform tweaks every child process of a
// tray app needs (no console window flashing up on Windows).
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	return cmd
}

// CommandContext is the context-aware variant of Command.
func CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	cmd.Cancel = func() error { return cancelProcessTree(cmd) }
	cmd.WaitDelay = 5 * time.Second
	return cmd
}
