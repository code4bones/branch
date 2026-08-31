import type { DiagnosticMonitorSnapshot } from "./monitor.js";

export type RelayReadiness = "ready" | "degraded" | "not_ready";

export interface RelayStatusSnapshot {
  readonly service_name: string;
  readonly service_version: string;
  readonly readiness: RelayReadiness;
  readonly protocol_versions: readonly string[];
  readonly capabilities: readonly string[];
  readonly sessions_active: number;
  readonly queue_depth: number;
  readonly exporter_available: boolean;
}

export interface RelayMetricSeries {
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface RelayObservationInput {
  readonly status: RelayStatusSnapshot;
  readonly diagnostics: DiagnosticMonitorSnapshot;
  readonly metrics: readonly RelayMetricSeries[];
}

export interface ObservationFrontState {
  readonly generated_at: number;
  readonly service_label: string;
  readonly readiness: RelayReadiness;
  readonly protocol_versions: readonly string[];
  readonly capabilities: readonly string[];
  readonly sessions_active: number;
  readonly queue_depth: number;
  readonly exporter_available: boolean;
  readonly diagnostic_events: number;
  readonly latest_diagnostic_at?: number;
  readonly metric_count: number;
  readonly warning_count: number;
}

export function buildObservationFrontState(input: RelayObservationInput, now: number): ObservationFrontState {
  const base: ObservationFrontState = {
    generated_at: now,
    service_label: `${input.status.service_name} ${input.status.service_version}`.trim(),
    readiness: input.status.readiness,
    protocol_versions: [...input.status.protocol_versions].sort(),
    capabilities: [...input.status.capabilities].sort(),
    sessions_active: input.status.sessions_active,
    queue_depth: input.status.queue_depth,
    exporter_available: input.status.exporter_available,
    diagnostic_events: input.diagnostics.total_events,
    metric_count: input.metrics.length,
    warning_count: warningCount(input)
  };

  if (input.diagnostics.newest_event_at !== undefined) {
    return { ...base, latest_diagnostic_at: input.diagnostics.newest_event_at };
  }
  return base;
}

function warningCount(input: RelayObservationInput): number {
  let count = 0;
  if (input.status.readiness !== "ready") {
    count += 1;
  }
  if (input.status.queue_depth > 0) {
    count += 1;
  }
  if (!input.status.exporter_available) {
    count += 1;
  }
  for (const reason of input.diagnostics.reasons) {
    count += reason.count;
  }
  return count;
}
