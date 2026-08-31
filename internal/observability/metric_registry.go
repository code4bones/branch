package observability

import (
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const (
	MaxMetricLabels          = 8
	MaxMetricLabelValueBytes = 64
)

var (
	ErrInvalidMetric      = errors.New("invalid observability metric")
	ErrInvalidMetricLabel = errors.New("invalid observability metric label")
)

// LabelValue is one bounded-cardinality metric label.
type LabelValue struct {
	Label MetricLabel
	Value string
}

// MetricRegistry stores aggregate metrics for protected admin exposure.
type MetricRegistry struct {
	mu       sync.Mutex
	series   map[string]MetricSeries
	versions map[string]struct{}
	caps     map[string]struct{}
}

// MetricRegistryOptions configures version and capability label allowlists.
type MetricRegistryOptions struct {
	ProtocolVersions []string
	Capabilities     []string
}

// MetricSeries is a detached metric sample returned by Snapshot.
type MetricSeries struct {
	Name   MetricName             `json:"name"`
	Labels map[MetricLabel]string `json:"labels,omitempty"`
	Value  float64                `json:"value"`
}

// NewMetricRegistry creates an in-memory metric registry with bounded labels.
func NewMetricRegistry(options MetricRegistryOptions) *MetricRegistry {
	return &MetricRegistry{
		series:   make(map[string]MetricSeries),
		versions: stringSet(options.ProtocolVersions),
		caps:     stringSet(options.Capabilities),
	}
}

// Add increments a counter metric by a non-negative finite value.
func (registry *MetricRegistry) Add(name MetricName, delta float64, labels ...LabelValue) error {
	if !counterMetric(name) || !finiteNonNegative(delta) {
		return ErrInvalidMetric
	}
	return registry.update(name, labels, func(current float64) float64 {
		return current + delta
	})
}

// Set records a gauge metric as a finite non-negative value.
func (registry *MetricRegistry) Set(name MetricName, value float64, labels ...LabelValue) error {
	if !gaugeMetric(name) || !finiteNonNegative(value) {
		return ErrInvalidMetric
	}
	return registry.update(name, labels, func(float64) float64 {
		return value
	})
}

// Snapshot returns detached metric samples sorted by name and label set.
func (registry *MetricRegistry) Snapshot() []MetricSeries {
	registry.mu.Lock()
	defer registry.mu.Unlock()

	samples := make([]MetricSeries, 0, len(registry.series))
	for _, sample := range registry.series {
		samples = append(samples, MetricSeries{
			Name:   sample.Name,
			Labels: cloneMetricLabels(sample.Labels),
			Value:  sample.Value,
		})
	}
	sort.Slice(samples, func(left, right int) bool {
		return metricKey(samples[left].Name, samples[left].Labels) < metricKey(samples[right].Name, samples[right].Labels)
	})
	return samples
}

// MetricsSnapshot returns Snapshot and satisfies admin metrics providers.
func (registry *MetricRegistry) MetricsSnapshot() []MetricSeries {
	return registry.Snapshot()
}

// PrometheusText renders samples in the Prometheus text exposition format.
func PrometheusText(samples []MetricSeries) string {
	var builder strings.Builder
	for _, sample := range samples {
		builder.WriteString(string(sample.Name))
		if len(sample.Labels) > 0 {
			builder.WriteByte('{')
			labels := sortedMetricLabels(sample.Labels)
			for index, label := range labels {
				if index > 0 {
					builder.WriteByte(',')
				}
				builder.WriteString(string(label.Label))
				builder.WriteString(`="`)
				builder.WriteString(escapePrometheusLabel(label.Value))
				builder.WriteByte('"')
			}
			builder.WriteByte('}')
		}
		builder.WriteByte(' ')
		builder.WriteString(strconv.FormatFloat(sample.Value, 'g', -1, 64))
		builder.WriteByte('\n')
	}
	return builder.String()
}

func (registry *MetricRegistry) update(name MetricName, labels []LabelValue, apply func(float64) float64) error {
	validated, err := registry.validateLabels(labels)
	if err != nil {
		return err
	}
	key := metricKey(name, validated)

	registry.mu.Lock()
	defer registry.mu.Unlock()

	current := registry.series[key]
	current.Name = name
	current.Labels = cloneMetricLabels(validated)
	current.Value = apply(current.Value)
	registry.series[key] = current
	return nil
}

func (registry *MetricRegistry) validateLabels(labels []LabelValue) (map[MetricLabel]string, error) {
	if len(labels) > MaxMetricLabels {
		return nil, ErrInvalidMetricLabel
	}

	validated := make(map[MetricLabel]string, len(labels))
	for _, label := range labels {
		if !AllowedMetricLabel(label.Label) {
			return nil, ErrInvalidMetricLabel
		}
		value := sanitizeMetricLabelValue(label.Value)
		if !registry.allowedMetricLabelValue(label.Label, value) {
			return nil, ErrInvalidMetricLabel
		}
		validated[label.Label] = value
	}
	return validated, nil
}

func (registry *MetricRegistry) allowedMetricLabelValue(label MetricLabel, value string) bool {
	if value == "" || forbiddenValue(value) || len(value) > MaxMetricLabelValueBytes || looksLikeMetricAddress(value) || looksLikeMetricURL(value) {
		return false
	}

	switch label {
	case MetricLabelTransport:
		return stringIn(value, "direct_ipv6", "ice_udp", "ice_tcp", "relay_wss")
	case MetricLabelCarrier:
		return stringIn(value, "github", "npm", "crates", "git", "image", "manual", "nostr", "local")
	case MetricLabelDirection:
		return stringIn(value, "inbound", "outbound")
	case MetricLabelResult:
		return stringIn(value, "success", "rejected", "timeout", "unavailable", "degraded", "dropped")
	case MetricLabelReason:
		return KnownReason(ReasonCode(value))
	case MetricLabelProtocolVersion:
		_, ok := registry.versions[value]
		return ok
	case MetricLabelCapability:
		_, ok := registry.caps[value]
		return ok
	default:
		return false
	}
}

func looksLikeMetricAddress(value string) bool {
	return net.ParseIP(value) != nil
}

func looksLikeMetricURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme != "" && parsed.Host != ""
}

func counterMetric(name MetricName) bool {
	switch name {
	case MetricConnectionsTotal,
		MetricHandshakesTotal,
		MetricRouteSelectionsTotal,
		MetricRouteMigrationsTotal,
		MetricFramesForwardedTotal,
		MetricFramesRejectedTotal,
		MetricQueueDroppedTotal,
		MetricCarrierQueriesTotal,
		MetricBeaconsValidatedTotal,
		MetricGossipRecordsTotal,
		MetricProtocolErrorsTotal,
		MetricExporterDroppedTotal:
		return true
	default:
		return false
	}
}

func gaugeMetric(name MetricName) bool {
	switch name {
	case MetricBuildInfo,
		MetricProcessUptimeSeconds,
		MetricSessionsActive,
		MetricConnectionDurationSeconds,
		MetricHandshakeDurationSeconds,
		MetricQueueDepth,
		MetricCarrierQueryDurationSecond:
		return true
	default:
		return false
	}
}

func finiteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func sanitizeMetricLabelValue(value string) string {
	return sanitizeValue(value)
}

func stringSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = sanitizeMetricLabelValue(value)
		if value != "" && !forbiddenValue(value) {
			set[value] = struct{}{}
		}
	}
	return set
}

func stringIn(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func metricKey(name MetricName, labels map[MetricLabel]string) string {
	parts := []string{string(name)}
	for _, label := range sortedMetricLabels(labels) {
		parts = append(parts, fmt.Sprintf("%s=%s", label.Label, label.Value))
	}
	return strings.Join(parts, "\x00")
}

func sortedMetricLabels(labels map[MetricLabel]string) []LabelValue {
	keys := make([]MetricLabel, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(left, right int) bool {
		return keys[left] < keys[right]
	})

	result := make([]LabelValue, 0, len(keys))
	for _, key := range keys {
		result = append(result, LabelValue{Label: key, Value: labels[key]})
	}
	return result
}

func cloneMetricLabels(labels map[MetricLabel]string) map[MetricLabel]string {
	if len(labels) == 0 {
		return nil
	}
	copied := make(map[MetricLabel]string, len(labels))
	for key, value := range labels {
		copied[key] = value
	}
	return copied
}

func escapePrometheusLabel(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return value
}
