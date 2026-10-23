// Package download fetches large files with resume, progress and SHA-256
// verification, and unpacks release archives.
package download

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Progress struct {
	Done        int64   `json:"done"`
	Total       int64   `json:"total"`
	BytesPerSec float64 `json:"bytes_per_sec"`
}

var client = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 60 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	},
}

const userAgent = "WebBrain-Companion/1 (+https://webbrain.one)"

// File downloads url to dest. A partial file from an earlier attempt is
// resumed. When sha is set the result is verified before it is moved into
// place; size, when known, lets progress report a total before headers arrive.
func File(ctx context.Context, url, dest string, size int64, sha string, onProgress func(Progress)) error {
	if st, err := os.Stat(dest); err == nil && (size <= 0 || st.Size() == size) {
		if sha == "" {
			return nil
		}
		if ok, _ := verify(dest, sha); ok {
			return nil
		}
		_ = os.Remove(dest)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	part := dest + ".part"
	var lastErr error
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * time.Second):
			}
		}
		err := fetch(ctx, url, part, size, onProgress)
		if err == nil {
			lastErr = nil
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		lastErr = err
		var perm *permanentError
		if errors.As(err, &perm) {
			return err
		}
	}
	if lastErr != nil {
		return lastErr
	}
	if sha != "" {
		ok, got := verify(part, sha)
		if !ok {
			_ = os.Remove(part)
			return fmt.Errorf("checksum mismatch for %s (got %s)", filepath.Base(dest), got)
		}
	}
	return os.Rename(part, dest)
}

type permanentError struct{ msg string }

func (e *permanentError) Error() string { return e.msg }

func fetch(ctx context.Context, url, part string, size int64, onProgress func(Progress)) error {
	var offset int64
	if st, err := os.Stat(part); err == nil {
		offset = st.Size()
		if size > 0 && offset >= size {
			return nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	switch {
	case resp.StatusCode == http.StatusPartialContent && offset > 0:
		flags |= os.O_APPEND
	case resp.StatusCode == http.StatusOK:
		offset = 0
		flags |= os.O_TRUNC
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		_ = os.Remove(part)
		return errors.New("server rejected resume; restarting download")
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized:
		return &permanentError{fmt.Sprintf("download failed: HTTP %d for %s", resp.StatusCode, url)}
	default:
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	total := size
	if total <= 0 && resp.ContentLength > 0 {
		total = offset + resp.ContentLength
	}
	f, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, 1<<20)
	done := offset
	start, lastReport := time.Now(), time.Time{}
	startDone := done
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			if onProgress != nil && time.Since(lastReport) > 250*time.Millisecond {
				lastReport = time.Now()
				el := time.Since(start).Seconds()
				bps := 0.0
				if el > 0 {
					bps = float64(done-startDone) / el
				}
				onProgress(Progress{Done: done, Total: total, BytesPerSec: bps})
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if onProgress != nil {
		onProgress(Progress{Done: done, Total: total})
	}
	if total > 0 && done < total {
		return fmt.Errorf("download ended early (%d of %d bytes)", done, total)
	}
	return nil
}

func verify(path, want string) (bool, string) {
	f, err := os.Open(path)
	if err != nil {
		return false, ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, ""
	}
	got := hex.EncodeToString(h.Sum(nil))
	return strings.EqualFold(got, want), got
}

// safeJoin rejects archive entries that would escape dst.
func safeJoin(dst, name string, strip int) (string, bool) {
	name = strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "./")
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) <= strip {
		return "", false
	}
	rel := filepath.FromSlash(strings.Join(parts[strip:], "/"))
	if rel == "" || rel == "." {
		return "", false
	}
	p := filepath.Join(dst, rel)
	if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
		return "", false
	}
	return p, true
}

// ExtractZip unpacks src into dst, dropping the first strip path components.
// keep, when set, filters entries by their path after stripping.
func ExtractZip(src, dst string, strip int, keep func(rel string) bool) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		p, ok := safeJoin(dst, f.Name, strip)
		if !ok || (keep != nil && !f.FileInfo().IsDir() && !keep(relTo(dst, p))) {
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		mode := f.Mode().Perm() | 0o600
		out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// ExtractTarGz unpacks a .tar.gz into dst, keeping modes and safe symlinks.
func ExtractTarGz(src, dst string, strip int, keep func(rel string) bool) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		p, ok := safeJoin(dst, h.Name, strip)
		if !ok || (keep != nil && h.Typeflag != tar.TypeDir && !keep(relTo(dst, p))) {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode).Perm()|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, tr)
			out.Close()
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			target := h.Linkname
			if filepath.IsAbs(target) {
				continue
			}
			resolved := filepath.Join(filepath.Dir(p), target)
			if !strings.HasPrefix(resolved, filepath.Clean(dst)+string(os.PathSeparator)) {
				continue
			}
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.Remove(p)
			if err := os.Symlink(target, p); err != nil {
				return err
			}
		}
	}
}

func relTo(dst, p string) string {
	r, err := filepath.Rel(dst, p)
	if err != nil {
		return p
	}
	return filepath.ToSlash(r)
}

// Extract picks the unpacker from the file name.
func Extract(src, dst string, strip int) error { return ExtractFiltered(src, dst, strip, nil) }

// ExtractFiltered unpacks only the entries keep accepts (nil keeps all).
func ExtractFiltered(src, dst string, strip int, keep func(rel string) bool) error {
	lower := strings.ToLower(src)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return ExtractZip(src, dst, strip, keep)
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return ExtractTarGz(src, dst, strip, keep)
	}
	return fmt.Errorf("unknown archive type: %s", filepath.Base(src))
}

// TopLevelDirs returns how many path components all entries share, so callers
// can strip a single wrapping directory when present.
func CommonPrefixDepth(src string) int {
	var names []string
	lower := strings.ToLower(src)
	if strings.HasSuffix(lower, ".zip") {
		r, err := zip.OpenReader(src)
		if err != nil {
			return 0
		}
		defer r.Close()
		for _, f := range r.File {
			names = append(names, f.Name)
		}
	} else {
		f, err := os.Open(src)
		if err != nil {
			return 0
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return 0
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err != nil {
				break
			}
			names = append(names, h.Name)
		}
	}
	first := ""
	for _, n := range names {
		n = strings.TrimPrefix(strings.ReplaceAll(n, "\\", "/"), "./")
		if strings.Trim(n, "/.") == "" {
			continue // the archive root ("./")
		}
		parts := strings.SplitN(strings.Trim(n, "/"), "/", 2)
		if len(parts) < 2 && !strings.HasSuffix(n, "/") {
			return 0 // a file at the top level
		}
		if first == "" {
			first = parts[0]
		} else if parts[0] != first {
			return 0
		}
	}
	if first == "" {
		return 0
	}
	return 1
}
