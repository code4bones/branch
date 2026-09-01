package identity

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

var (
	ErrInvalidIdentity = errors.New("invalid node identity")
	ErrMissingPath     = errors.New("missing node identity path")
)

// NodeIdentity owns the relay node signing key used to prove possession of the
// BootstrapBeacon sender identity.
type NodeIdentity struct {
	publicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

type diskIdentity struct {
	Schema     string `json:"schema"`
	KeyAlg     string `json:"key_alg"`
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
}

// Generate creates an in-memory node identity.
func Generate() (*NodeIdentity, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate node identity: %w", err)
	}
	return &NodeIdentity{publicKey: publicKey, privateKey: privateKey}, nil
}

// LoadOrCreate reads a node identity from path, or creates it with 0600
// permissions when absent. The file is operator-owned relay identity material.
func LoadOrCreate(path string) (*NodeIdentity, error) {
	if path == "" {
		return nil, ErrMissingPath
	}
	data, err := os.ReadFile(path)
	if err == nil {
		return decode(data)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read node identity: %w", err)
	}

	identity, err := Generate()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create node identity directory: %w", err)
	}
	if err := os.WriteFile(path, encode(identity), 0o600); err != nil {
		return nil, fmt.Errorf("write node identity: %w", err)
	}
	return identity, nil
}

// PublicKey returns a detached copy of the Ed25519 public key.
func (identity *NodeIdentity) PublicKey() ed25519.PublicKey {
	return append(ed25519.PublicKey(nil), identity.publicKey...)
}

// PublicKeyString returns the unpadded base64url public key used by diagnostic
// fixtures and BootstrapBeacon JSON tooling.
func (identity *NodeIdentity) PublicKeyString() string {
	return base64.RawURLEncoding.EncodeToString(identity.publicKey)
}

// Sign signs domain-separated protocol bytes with the node identity key.
func (identity *NodeIdentity) Sign(message []byte) []byte {
	return ed25519.Sign(identity.privateKey, message)
}

func decode(data []byte) (*NodeIdentity, error) {
	var file diskIdentity
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidIdentity, err)
	}
	if file.Schema != "branch.node-identity/0" || file.KeyAlg != "ed25519" {
		return nil, ErrInvalidIdentity
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(file.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return nil, ErrInvalidIdentity
	}
	privateKey, err := base64.RawURLEncoding.DecodeString(file.PrivateKey)
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return nil, ErrInvalidIdentity
	}
	if !bytes.Equal(ed25519.PrivateKey(privateKey).Public().(ed25519.PublicKey), publicKey) {
		return nil, ErrInvalidIdentity
	}
	return &NodeIdentity{
		publicKey:  append(ed25519.PublicKey(nil), publicKey...),
		privateKey: append(ed25519.PrivateKey(nil), privateKey...),
	}, nil
}

func encode(identity *NodeIdentity) []byte {
	data, _ := json.MarshalIndent(diskIdentity{
		Schema:     "branch.node-identity/0",
		KeyAlg:     "ed25519",
		PublicKey:  identity.PublicKeyString(),
		PrivateKey: base64.RawURLEncoding.EncodeToString(identity.privateKey),
	}, "", "  ")
	return append(data, '\n')
}
