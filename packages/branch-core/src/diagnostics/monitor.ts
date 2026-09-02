import type { DiagnosticEvent, DiagnosticEventName, DiagnosticReasonCode, RedactedDiagnosticExport } from "./journal.js";

export interface DiagnosticMonitorSnapshot {
  readonly generated_at: number;
  readonly total_events: number;
  readonly newest_event_at?: number;
  readonly events_by_name: readonly DiagnosticEventCount[];
  readonly reasons: readonly DiagnosticReasonCount[];
  readonly recent_events: readonly DiagnosticEvent[];
  readonly export_preview: DiagnosticExportPreview;
}

export interface DiagnosticEventCount {
  readonly event: DiagnosticEventName;
  readonly count: number;
}

export interface DiagnosticReasonCount {
  readonly reason: DiagnosticReasonCode;
  readonly count: number;
}

export interface DiagnosticExportPreview {
  readonly event_count: number;
  readonly categories: readonly string[];
  readonly includes_sensitive_material: false;
}

export function buildDiagnosticMonitorSnapshot(
  events: readonly DiagnosticEvent[],
  now: number
): DiagnosticMonitorSnapshot {
  const copiedEvents = events.map(cloneEvent);
  const newest = newestTimestamp(copiedEvents);

  const snapshot: DiagnosticMonitorSnapshot = {
    generated_at: now,
    total_events: copiedEvents.length,
    events_by_name: countEvents(copiedEvents),
    reasons: countReasons(copiedEvents),
    recent_events: copiedEvents,
    export_preview: buildExportPreview(copiedEvents)
  };
  if (newest !== undefined) {
    return { ...snapshot, newest_event_at: newest };
  }
  return snapshot;
}

export function previewDiagnosticExport(exported: RedactedDiagnosticExport): DiagnosticExportPreview {
  return buildExportPreview(exported.events);
}

function countEvents(events: readonly DiagnosticEvent[]): readonly DiagnosticEventCount[] {
  const counts = new Map<DiagnosticEventName, number>();
  for (const event of events) {
    counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([event, count]) => ({ event, count }));
}

function countReasons(events: readonly DiagnosticEvent[]): readonly DiagnosticReasonCount[] {
  const counts = new Map<DiagnosticReasonCode, number>();
  for (const event of events) {
    if (event.reason_code !== undefined) {
      counts.set(event.reason_code, (counts.get(event.reason_code) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
}

function newestTimestamp(events: readonly DiagnosticEvent[]): number | undefined {
  let newest: number | undefined;
  for (const event of events) {
    if (newest === undefined || event.timestamp > newest) {
      newest = event.timestamp;
    }
  }
  return newest;
}

function buildExportPreview(events: readonly DiagnosticEvent[]): DiagnosticExportPreview {
  return {
    event_count: events.length,
    categories: [...new Set(events.map((event) => categoryFor(event.event)))].sort(),
    includes_sensitive_material: false
  };
}

function categoryFor(event: DiagnosticEventName): string {
  const separator = event.indexOf(".");
  if (separator === -1) {
    return event;
  }
  return event.slice(0, separator);
}

function cloneEvent(event: DiagnosticEvent): DiagnosticEvent {
  const cloned: DiagnosticEvent = {
    timestamp: event.timestamp,
    event: event.event,
    mode: event.mode
  };
  if (event.reason_code !== undefined) {
    const clonedWithReason: DiagnosticEvent = {
      ...cloned,
      reason_code: event.reason_code
    };
    if (event.attributes !== undefined) {
      return {
        ...clonedWithReason,
        attributes: event.attributes.map((attribute) => ({ ...attribute }))
      };
    }
    return clonedWithReason;
  }
  if (event.attributes !== undefined) {
    return {
      ...cloned,
      attributes: event.attributes.map((attribute) => ({ ...attribute }))
    };
  }
  return cloned;
}
