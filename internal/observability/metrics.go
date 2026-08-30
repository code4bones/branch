package observability

type MetricName string

const (
	MetricBuildInfo                  MetricName = "branch_build_info"
	MetricProcessUptimeSeconds       MetricName = "branch_process_uptime_seconds"
	MetricSessionsActive             MetricName = "branch_sessions_active"
	MetricConnectionsTotal           MetricName = "branch_connections_total"
	MetricConnectionDurationSeconds  MetricName = "branch_connection_duration_seconds"
	MetricHandshakesTotal            MetricName = "branch_handshakes_total"
	MetricHandshakeDurationSeconds   MetricName = "branch_handshake_duration_seconds"
	MetricRouteSelectionsTotal       MetricName = "branch_route_selections_total"
	MetricRouteMigrationsTotal       MetricName = "branch_route_migrations_total"
	MetricFramesForwardedTotal       MetricName = "branch_frames_forwarded_total"
	MetricFramesRejectedTotal        MetricName = "branch_frames_rejected_total"
	MetricQueueDepth                 MetricName = "branch_queue_depth"
	MetricQueueDroppedTotal          MetricName = "branch_queue_dropped_total"
	MetricCarrierQueriesTotal        MetricName = "branch_carrier_queries_total"
	MetricCarrierQueryDurationSecond MetricName = "branch_carrier_query_duration_seconds"
	MetricBeaconsValidatedTotal      MetricName = "branch_beacons_validated_total"
	MetricGossipRecordsTotal         MetricName = "branch_gossip_records_total"
	MetricProtocolErrorsTotal        MetricName = "branch_protocol_errors_total"
	MetricExporterDroppedTotal       MetricName = "branch_exporter_dropped_total"
)

type MetricLabel string

const (
	MetricLabelTransport       MetricLabel = "transport"
	MetricLabelCarrier         MetricLabel = "carrier"
	MetricLabelDirection       MetricLabel = "direction"
	MetricLabelResult          MetricLabel = "result"
	MetricLabelReason          MetricLabel = "reason"
	MetricLabelProtocolVersion MetricLabel = "protocol_version"
	MetricLabelCapability      MetricLabel = "capability"
)

var forbiddenMetricLabels = map[string]struct{}{
	"user_id":              {},
	"public_key":           {},
	"identity_fingerprint": {},
	"session_id":           {},
	"message_id":           {},
	"ip_address":           {},
	"hostname":             {},
	"repository_url":       {},
	"relay_url":            {},
	"error":                {},
	"user_agent":           {},
}

func KnownMetric(name MetricName) bool {
	switch name {
	case MetricBuildInfo,
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
		MetricExporterDroppedTotal:
		return true
	default:
		return false
	}
}

func AllowedMetricLabel(label MetricLabel) bool {
	if _, forbidden := forbiddenMetricLabels[string(label)]; forbidden {
		return false
	}

	switch label {
	case MetricLabelTransport,
		MetricLabelCarrier,
		MetricLabelDirection,
		MetricLabelResult,
		MetricLabelReason,
		MetricLabelProtocolVersion,
		MetricLabelCapability:
		return true
	default:
		return false
	}
}
