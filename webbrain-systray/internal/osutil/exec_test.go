package osutil

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProcessTreeHelper(t *testing.T) {
	if os.Getenv("WBC_TREE_CHILD") == "1" {
		for i := 0; i < 600; i++ {
			f, err := os.OpenFile(os.Getenv("WBC_TREE_HEARTBEAT"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				os.Exit(2)
			}
			_, _ = f.WriteString("x")
			_ = f.Close()
			time.Sleep(50 * time.Millisecond)
		}
		return
	}
	if os.Getenv("WBC_TREE_PARENT") == "1" {
		child := exec.Command(os.Args[0], "-test.run=^TestProcessTreeHelper$")
		child.Env = append(os.Environ(), "WBC_TREE_CHILD=1")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		_ = os.WriteFile(os.Getenv("WBC_TREE_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0o600)
		_ = child.Wait()
	}
}

func TestCommandContextKillsDescendants(t *testing.T) {
	dir := t.TempDir()
	heartbeat, pidFile := filepath.Join(dir, "heartbeat"), filepath.Join(dir, "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := CommandContext(ctx, os.Args[0], "-test.run=^TestProcessTreeHelper$")
	cmd.Env = append(os.Environ(), "WBC_TREE_PARENT=1", "WBC_TREE_HEARTBEAT="+heartbeat, "WBC_TREE_PID="+pidFile)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	cleanupChild := true
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		if data, err := os.ReadFile(pidFile); cleanupChild && err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
				if child, err := os.FindProcess(pid); err == nil {
					_ = child.Kill()
				}
			}
		}
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(heartbeat); err == nil && len(data) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child process never began writing")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("parent process did not stop after cancellation")
	}
	before, err := os.ReadFile(heartbeat)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	after, err := os.ReadFile(heartbeat)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("child process kept running after cancellation: %d -> %d bytes", len(before), len(after))
	}
	cleanupChild = false
}
