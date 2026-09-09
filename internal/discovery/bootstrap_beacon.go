package discovery

import (
	"context"
	"errors"
)

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

// BootstrapBeaconSourceID is an optional safe carrier label for operator
// diagnostics. It is not carrier authority or protocol metadata.
type BootstrapBeaconSourceID interface {
	ID() string
}

// BootstrapBeaconLookupFailure lets an adapter expose a bounded safe failure
// class without leaking remote response bodies, URLs, credentials, or errors
// into an observation surface.
type BootstrapBeaconLookupFailure struct {
	Reason string
	cause  error
}

func (failure *BootstrapBeaconLookupFailure) Error() string {
	return "bootstrap beacon lookup failed: " + failure.Reason
}

func (failure *BootstrapBeaconLookupFailure) Unwrap() error {
	return failure.cause
}

// NewBootstrapBeaconLookupFailure wraps an adapter error with a pre-approved
// low-cardinality reason suitable for operator diagnostics.
func NewBootstrapBeaconLookupFailure(reason string, cause error) error {
	return &BootstrapBeaconLookupFailure{Reason: reason, cause: cause}
}

// BootstrapBeaconLookupFailureReason returns the adapter-approved diagnostic
// reason, if present. Callers must use their own generic fallback otherwise.
func BootstrapBeaconLookupFailureReason(err error) (string, bool) {
	var failure *BootstrapBeaconLookupFailure
	if !errors.As(err, &failure) || failure.Reason == "" {
		return "", false
	}
	return failure.Reason, true
}
