package admin

import (
	"context"
	"fmt"
	"net/url"

	"github.com/code4bones/branch/internal/discovery"
	protocol "github.com/code4bones/branch/protocol/v0"
)

const (
	IdentityContactLookupPath = "/identity/lookup"

	maxIdentityLookupBranchIDBytes = 96
	maxIdentityLookupPreviewBytes  = 72
)

// IdentityContactLookupProvider supplies the protected operator view for exact
// BranchID lookup. Implementations must remain bounded and memory-only.
type IdentityContactLookupProvider interface {
	Lookup(context.Context, string) discovery.IdentityContactLookupResult
}

// IdentityContactLookupRequest is one exact BranchID lookup request.
type IdentityContactLookupRequest struct {
	BranchID string
}

// IdentityContactLookupResponse is the redacted operator trace for one exact
// BranchID lookup. It is not a user directory or presence proof.
type IdentityContactLookupResponse struct {
	BranchID    string                            `json:"branch_id"`
	Accepted    bool                              `json:"accepted"`
	Observation *IdentityContactLookupObservation `json:"observation,omitempty"`
	Trace       []IdentityContactLookupTrace      `json:"trace"`
}

// IdentityContactLookupObservation is a safe public-control-plane projection of
// one signed identity.announce source record.
type IdentityContactLookupObservation struct {
	BranchID           string                              `json:"branch_id"`
	Sequence           uint64                              `json:"sequence"`
	IssuedAtUnix       int64                               `json:"issued_at"`
	ExpiresAtUnix      int64                               `json:"expires_at"`
	LastObservedUnix   int64                               `json:"last_observed_at"`
	Source             string                              `json:"source"`
	WrapperPreview     string                              `json:"wrapper_preview"`
	WrapperBytes       int                                 `json:"wrapper_bytes"`
	ProtocolVersions   []string                            `json:"protocol_versions"`
	ProfileMultihashes []string                            `json:"profile_multihashes"`
	RouteHints         []protocol.IdentityContactRouteHint `json:"route_hints"`
}

// IdentityContactLookupTrace is one bounded source/candidate outcome.
type IdentityContactLookupTrace struct {
	Source    string `json:"source"`
	Step      string `json:"step"`
	Accepted  bool   `json:"accepted"`
	Reason    string `json:"reason"`
	Candidate int    `json:"candidate,omitempty"`
}

func ParseIdentityContactLookupRequest(values url.Values) (IdentityContactLookupRequest, error) {
	branchID := values.Get("branch_id")
	if branchID == "" {
		return IdentityContactLookupRequest{}, fmt.Errorf("missing branch_id")
	}
	if len([]byte(branchID)) > maxIdentityLookupBranchIDBytes {
		return IdentityContactLookupRequest{}, fmt.Errorf("branch_id too large")
	}
	if err := protocol.ParseBranchID(branchID); err != nil {
		return IdentityContactLookupRequest{}, fmt.Errorf("invalid branch_id")
	}
	return IdentityContactLookupRequest{BranchID: branchID}, nil
}

func identityContactLookupResponse(result discovery.IdentityContactLookupResult) IdentityContactLookupResponse {
	response := IdentityContactLookupResponse{
		BranchID: result.BranchID,
		Accepted: result.Observation != nil,
		Trace:    make([]IdentityContactLookupTrace, 0, len(result.Trace)),
	}
	for _, item := range result.Trace {
		response.Trace = append(response.Trace, IdentityContactLookupTrace{
			Source:    item.Source,
			Step:      item.Step,
			Accepted:  item.Accepted,
			Reason:    item.Reason,
			Candidate: item.Candidate,
		})
	}
	if result.Observation != nil {
		response.Observation = identityContactLookupObservation(*result.Observation)
	}
	return response
}

func identityContactLookupObservation(observation discovery.IdentityContactObservation) *IdentityContactLookupObservation {
	return &IdentityContactLookupObservation{
		BranchID:           observation.BranchID,
		Sequence:           observation.Sequence,
		IssuedAtUnix:       observation.IssuedAtUnix,
		ExpiresAtUnix:      observation.ExpiresAtUnix,
		LastObservedUnix:   observation.LastObservedUnix,
		Source:             observation.Source,
		WrapperPreview:     wrapperPreview(observation.Wrapper),
		WrapperBytes:       len([]byte(observation.Wrapper)),
		ProtocolVersions:   append([]string(nil), observation.ProtocolVersions...),
		ProfileMultihashes: append([]string(nil), observation.ProfileMultihashes...),
		RouteHints:         append([]protocol.IdentityContactRouteHint(nil), observation.RouteHints...),
	}
}

func wrapperPreview(wrapper string) string {
	if len([]byte(wrapper)) <= maxIdentityLookupPreviewBytes {
		return wrapper
	}
	bytes := []byte(wrapper)
	return string(bytes[:maxIdentityLookupPreviewBytes]) + "..."
}
