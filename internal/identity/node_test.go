package identity

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreatePersistsNodeIdentityWithPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "branch", "node-identity.json")

	first, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("load or create first identity: %v", err)
	}
	second, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("load second identity: %v", err)
	}
	if first.PublicKeyString() != second.PublicKeyString() {
		t.Fatalf("identity was not persisted")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat identity: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("identity permissions = %o, want 600", got)
	}
}

func TestLoadOrCreateRejectsMissingPath(t *testing.T) {
	if _, err := LoadOrCreate(""); err != ErrMissingPath {
		t.Fatalf("missing path error = %v", err)
	}
}
