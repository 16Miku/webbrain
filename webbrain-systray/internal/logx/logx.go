// Package logx sends everything the process prints (our logs, the embedded
// proxy's logrus output, stray fmt.Println calls) to a size-capped file, so a
// GUI build without a console still leaves a readable trail.
package logx

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const maxSize = 8 << 20 // rotate at 8 MiB, keep one previous file

type rotating struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

func (r *rotating) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		if err := r.open(); err != nil {
			return len(p), nil // logging must never break the app
		}
	}
	if r.size+int64(len(p)) > maxSize {
		_ = r.f.Close()
		r.f = nil
		_ = os.Remove(r.path + ".1")
		_ = os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			return len(p), nil
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	if err != nil {
		_ = r.f.Close()
		r.f = nil // retry opening on the next write; keep draining stdout
		return len(p), nil
	}
	return n, nil
}

func (r *rotating) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	r.f = f
	if st != nil {
		r.size = st.Size()
	}
	return nil
}

var (
	file   *rotating
	logger = log.New(os.Stderr, "", log.LstdFlags)
)

// Path is the current log file (empty before Init).
func Path() string {
	if file == nil {
		return ""
	}
	return file.path
}

// Init routes logs to dir/companion.log. When alsoConsole is true (a terminal is
// attached) lines are mirrored to the original stderr.
func Init(dir string, alsoConsole bool) {
	_ = os.MkdirAll(dir, 0o700)
	file = &rotating{path: filepath.Join(dir, "companion.log")}
	var w io.Writer = file
	if alsoConsole {
		w = io.MultiWriter(file, os.Stderr)
	}
	logger = log.New(w, "", log.LstdFlags)
	logrus.SetOutput(w)
	logrus.SetFormatter(&logrus.TextFormatter{DisableColors: true, FullTimestamp: true})
	if !alsoConsole {
		// The embedded proxy prints a few progress lines with fmt.Println.
		// Send those writes through the rotating writer too, so they cannot
		// keep appending to the old file after it has been renamed.
		if reader, writer, err := os.Pipe(); err == nil {
			os.Stdout = writer
			os.Stderr = writer
			go func() {
				_, _ = io.Copy(file, reader)
				_ = reader.Close()
			}()
		}
	}
	fmt.Fprintf(w, "\n==== WebBrain Companion started %s ====\n", time.Now().Format(time.RFC3339))
}

func Printf(format string, args ...any) { logger.Printf(format, args...) }

// Writer returns a writer that appends to the companion log with a prefix,
// for child process output.
func Writer(prefix string) io.Writer {
	return &prefixWriter{prefix: prefix}
}

type prefixWriter struct {
	prefix string
	mu     sync.Mutex
	buf    []byte
}

func (p *prefixWriter) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf = append(p.buf, b...)
	for {
		i := -1
		for j, c := range p.buf {
			if c == '\n' {
				i = j
				break
			}
		}
		if i < 0 {
			break
		}
		line := string(p.buf[:i])
		p.buf = p.buf[i+1:]
		logger.Printf("%s %s", p.prefix, line)
	}
	if len(p.buf) > 64<<10 { // a runaway line without newline
		logger.Printf("%s %s", p.prefix, string(p.buf))
		p.buf = p.buf[:0]
	}
	return len(b), nil
}
