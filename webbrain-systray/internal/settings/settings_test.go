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
