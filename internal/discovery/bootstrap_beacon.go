package discovery

import "context"

// BootstrapBeaconCandidate is one untrusted public-carrier observation. Its
// wrapper must be validated by protocol-core before it can become a relay
// candidate; Source is diagnostic provenance only.
type BootstrapBeaconCandidate struct {
	Wrapper string
	Source  string
}

// BootstrapBeaconLookupSource performs one bounded public-carrier lookup for
// bootstrap.beacon wrappers. It is deliberately a lookup port, not a relay
// directory, cache, or background subscription.
type BootstrapBeaconLookupSource interface {
	LookupBootstrapBeacons(context.Context) ([]BootstrapBeaconCandidate, error)
}
