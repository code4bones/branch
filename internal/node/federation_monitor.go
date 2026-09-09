package node

import (
	"time"

	"github.com/code4bones/branch/internal/admin"
	"github.com/code4bones/branch/internal/relay/wss"
)

type staticFederationMonitor struct {
	router interface {
		FederationSnapshot() []wss.FederationPeerObservation
	}
}

func (monitor staticFederationMonitor) FederationLinks() []admin.RelayMonitorFederationLink {
	if monitor.router == nil {
		return nil
	}
	snapshot := monitor.router.FederationSnapshot()
	links := make([]admin.RelayMonitorFederationLink, 0, len(snapshot))
	for _, observation := range snapshot {
		link := admin.RelayMonitorFederationLink{
			// PeerEndpoint is retained for the protected beta monitor wire shape,
			// but contains only the process-local peer reference, never a URL.
			PeerEndpoint: observation.PeerRef,
			State:        observation.State,
			LastLookupAt: nonZeroTimePtr(observation.LastLookupAt),
			LastReason:   observation.LastReason,
			LookupCount:  observation.LookupCount,
			BridgeCount:  observation.BridgeCount,
			FreshUntil:   nonZeroTimePtr(observation.FreshUntil),
		}
		links = append(links, link)
	}
	return links
}

func nonZeroTimePtr(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	utc := value.UTC()
	return &utc
}
