package download

import (
	"os"
	"sync"
	"time"
)

type verifiedFile struct {
	size    int64
	modTime time.Time
	sha     string
}

// Verifier checks a pinned file's SHA-256 once per unchanged file in a
// process. Status snapshots can then check multi-gigabyte models cheaply.
type Verifier struct {
	mu    sync.Mutex
	valid map[string]verifiedFile
}

func (v *Verifier) Valid(path string, size int64, sha string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() || (size > 0 && st.Size() != size) {
		delete(v.valid, path)
		return false
	}
	if sha == "" {
		return true
	}
	if cached, ok := v.valid[path]; ok && cached.size == st.Size() && cached.modTime.Equal(st.ModTime()) && cached.sha == sha {
		return true
	}
	delete(v.valid, path)
	if ok, _ := verify(path, sha); !ok {
		return false
	}
	after, err := os.Stat(path)
	if err != nil || !after.Mode().IsRegular() || after.Size() != st.Size() || !after.ModTime().Equal(st.ModTime()) {
		return false
	}
	if v.valid == nil {
		v.valid = make(map[string]verifiedFile)
	}
	v.valid[path] = verifiedFile{size: st.Size(), modTime: st.ModTime(), sha: sha}
	return true
}
