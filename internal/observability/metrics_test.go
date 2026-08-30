package observability

import "testing"

func TestKnownMetricIncludesInitialRegistry(t *testing.T) {
	metrics := []MetricName{
		MetricBuildInfo,
		MetricProcessUptimeSeconds,
		MetricSessionsActive,
		MetricConnectionsTotal,
		MetricConnectionDurationSeconds,
		MetricHandshakesTotal,
		MetricHandshakeDurationSeconds,
		MetricRouteSelectionsTotal,
		MetricRouteMigrationsTotal,
		MetricFramesForwardedTotal,
		MetricFramesRejectedTotal,
		MetricQueueDepth,
		MetricQueueDroppedTotal,
		MetricCarrierQueriesTotal,
		MetricCarrierQueryDurationSecond,
		MetricBeaconsValidatedTotal,
		MetricGossipRecordsTotal,
		MetricProtocolErrorsTotal,
		MetricExporterDroppedTotal,
	}

	for _, metric := range metrics {
		if !KnownMetric(metric) {
			t.Fatalf("metric %q is not registered", metric)
		}
	}
}

func TestAllowedMetricLabelRejectsHighCardinalityLabels(t *testing.T) {
	for _, label := range []MetricLabel{"session_id", "peer_id", "ip_address", "relay_url", "error"} {
		if AllowedMetricLabel(label) {
			t.Fatalf("metric label %q must be forbidden", label)
		}
	}
}
