package v0

import (
	"crypto/sha256"
	"encoding/base64"
)

const (
	// ProfileHashAlgorithm names the draft profile hash algorithm.
	ProfileHashAlgorithm = "multihash.sha2-256"

	// DevelopmentProfileMultihash is the current exact-byte draft profile hash.
	// It changes whenever spec/connectivity-profile-v0.draft.json changes and
	// must not be treated as published v0 conformance.
	DevelopmentProfileMultihash = "uEiCaVLmVxHgth49YdSwXKM201oM4W6PHc61z_1rz-J_xVw"
)

// DraftProfileMultihash returns a multibase base64url-encoded SHA-256
// multihash for exact draft profile bytes.
func DraftProfileMultihash(profile []byte) string {
	digest := sha256.Sum256(profile)
	multihash := make([]byte, 0, 2+len(digest))
	multihash = append(multihash, 0x12, 0x20)
	multihash = append(multihash, digest[:]...)
	return "u" + base64.RawURLEncoding.EncodeToString(multihash)
}
