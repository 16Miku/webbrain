package core

import "testing"

func TestPickPortMaximum(t *testing.T) {
	const host = "127.0.0.1"
	const port = 65535
	if !portFree(host, port) {
		t.Skip("port 65535 is unavailable")
	}
	got, err := PickPort(host, port, false)
	if err != nil {
		t.Fatalf("PickPort(%q, %d, false): %v", host, port, err)
	}
	if got != port {
		t.Fatalf("PickPort returned %d, want %d", got, port)
	}
}
