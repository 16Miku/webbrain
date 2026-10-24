// Package instance keeps one companion process per user data directory.
package instance

import (
	"errors"
	"os"
)

// ErrHeld means another process owns the lock. The file itself is left in
// place: the operating system releases the lock if that process exits.
var ErrHeld = errors.New("another companion instance holds the lock")

type Lock struct {
	file *os.File
}

// TryAcquire takes an exclusive, non-blocking OS lock on a persistent file.
func TryAcquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	held, err := lock(f)
	if err != nil || !held {
		_ = f.Close()
		if err != nil {
			return nil, err
		}
		return nil, ErrHeld
	}
	return &Lock{file: f}, nil
}

func (l *Lock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := unlock(l.file)
	closeErr := l.file.Close()
	l.file = nil
	if err != nil {
		return err
	}
	return closeErr
}
