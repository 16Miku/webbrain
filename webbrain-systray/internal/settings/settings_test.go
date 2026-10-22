package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPortMigration(t *testing.T) {
	cases := []struct {
		file string
		want int
	}{
		{``, DefaultPort},                   // fresh install
		{`{"port":8317}`, DefaultPort},      // 0.1.x default moves off CLIProxyAPI's port
		{`{"port":9000}`, 9000},             // a port the user chose stays
		{`{"version":2,"port":8317}`, 8317}, // chosen after the move: respected
	}
	for _, c := range cases {
		home := t.TempDir()
		t.Setenv("WBC_HOME", home)
		if c.file != "" {
			if err := os.WriteFile(filepath.Join(home, "companion.json"), []byte(c.file), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		st, err := Open()
		if err != nil {
			t.Fatal(err)
		}
		if got := st.Get(); got.Port != c.want || got.Version != settingsVersion {
			t.Errorf("%s: port %d version %d, want %d and %d", c.file, got.Port, got.Version, c.want, settingsVersion)
		}
	}
}

func TestFailedUpdateKeepsPublishedSettings(t *testing.T) {
	t.Setenv("WBC_HOME", t.TempDir())
	st, err := Open()
	if err != nil {
		t.Fatal(err)
	}
	before := st.Get()
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	st.path = filepath.Join(blocker, "settings.json")
	returned, err := st.Update(func(s *Settings) { s.APIKey = NewAPIKey() })
	if err == nil {
		t.Fatal("update unexpectedly persisted through a regular file")
	}
	if returned.APIKey != before.APIKey || st.Get().APIKey != before.APIKey {
		t.Fatal("failed update published an unpersisted API key")
	}
}
