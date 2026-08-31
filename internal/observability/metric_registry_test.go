package observability

import (
	"errors"
	"testing"
)

func TestMetricRegistryRecordsCountersAndGauges(t *testing.T) {
	registry := NewMetricRegistry(MetricRegistryOptions{
		ProtocolVersions: []string{"branch/connectivity/0"},
		Capabilities:     []string{"forward"},
	})

	if err := registry.Add(
		MetricHandshakesTotal,
		1,
		LabelValue{Label: MetricLabelResult, Value: "success"},
		LabelValue{Label: MetricLabelProtocolVersion, Value: "branch/connectivity/0"},
	); err != nil {
		t.Fatalf("add counter: %v", err)
	}
	if err := registry.Set(
		MetricSessionsActive,
		2,
		LabelValue{Label: MetricLabelCapability, Value: "forward"},
	); err != nil {
		t.Fatalf("set gauge: %v", err)
	}

	snapshot := registry.Snapshot()
	if got := len(snapshot); got != 2 {
		t.Fatalf("snapshot samples = %d, want 2", got)
	}
	if snapshot[0].Name != MetricHandshakesTotal {
		t.Fatalf("first metric = %q", snapshot[0].Name)
	}
	if snapshot[1].Name != MetricSessionsActive {
		t.Fatalf("second metric = %q", snapshot[1].Name)
	}
}

func TestMetricRegistryRejectsForbiddenLabels(t *testing.T) {
	registry := NewMetricRegistry(MetricRegistryOptions{})

	err := registry.Add(MetricConnectionsTotal, 1, LabelValue{Label: MetricLabel("session_id"), Value: "s-1"})
	if !errors.Is(err, ErrInvalidMetricLabel) {
		t.Fatalf("err = %v, want ErrInvalidMetricLabel", err)
	}
}

func TestMetricRegistryRejectsURLAndAddressLikeRegisteredLabels(t *testing.T) {
	registry := NewMetricRegistry(MetricRegistryOptions{
		ProtocolVersions: []string{"branch/connectivity/0", "https://relay.example"},
		Capabilities:     []string{"forward", "192.0.2.10"},
	})

	if err := registry.Add(MetricHandshakesTotal, 1, LabelValue{Label: MetricLabelProtocolVersion, Value: "https://relay.example"}); !errors.Is(err, ErrInvalidMetricLabel) {
		t.Fatalf("url-like protocol label err = %v", err)
	}
	if err := registry.Set(MetricBuildInfo, 1, LabelValue{Label: MetricLabelCapability, Value: "192.0.2.10"}); !errors.Is(err, ErrInvalidMetricLabel) {
		t.Fatalf("address-like capability label err = %v", err)
	}
}

func TestMetricRegistryRejectsUnregisteredProtocolVersionAndCapability(t *testing.T) {
	registry := NewMetricRegistry(MetricRegistryOptions{
		ProtocolVersions: []string{"branch/connectivity/0"},
		Capabilities:     []string{"forward"},
	})

	if err := registry.Add(MetricHandshakesTotal, 1, LabelValue{Label: MetricLabelProtocolVersion, Value: "branch/unknown/0"}); !errors.Is(err, ErrInvalidMetricLabel) {
		t.Fatalf("protocol label err = %v", err)
	}
	if err := registry.Set(MetricBuildInfo, 1, LabelValue{Label: MetricLabelCapability, Value: "admin-everything"}); !errors.Is(err, ErrInvalidMetricLabel) {
		t.Fatalf("capability label err = %v", err)
	}
}

func TestMetricRegistryRejectsInvalidValues(t *testing.T) {
	registry := NewMetricRegistry(MetricRegistryOptions{})

	if err := registry.Add(MetricConnectionsTotal, -1); !errors.Is(err, ErrInvalidMetric) {
		t.Fatalf("negative counter err = %v", err)
	}
	if err := registry.Set(MetricConnectionsTotal, 1); !errors.Is(err, ErrInvalidMetric) {
		t.Fatalf("counter set err = %v", err)
	}
	if err := registry.Add(MetricSessionsActive, 1); !errors.Is(err, ErrInvalidMetric) {
		t.Fatalf("gauge add err = %v", err)
	}
}

func TestMetricRegistrySnapshotIsDetached(t *testing.T) {
	registry := NewMetricRegistry(MetricRegistryOptions{})
	if err := registry.Add(MetricQueueDroppedTotal, 1, LabelValue{Label: MetricLabelReason, Value: string(ReasonQueueOverflow)}); err != nil {
		t.Fatalf("add: %v", err)
	}

	snapshot := registry.Snapshot()
	snapshot[0].Labels[MetricLabelReason] = "mutated"

	next := registry.Snapshot()
	if next[0].Labels[MetricLabelReason] != string(ReasonQueueOverflow) {
		t.Fatal("snapshot mutation changed registry state")
	}
}
