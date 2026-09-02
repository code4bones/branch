export type DiagnosticMode = "off" | "operator" | "development" | "diagnostic";

export type DiagnosticEventName =
  | "application.started"
  | "discovery.started"
  | "beacon.validation.accepted"
  | "beacon.validation.rejected"
  | "relay.connection.completed"
  | "handshake.completed"
  | "handshake.failed"
  | "route.selected"
  | "route.migration.completed"
  | "queue.overflow"
  | "storage.migration.failed"
  | "service_worker.updated";

export type DiagnosticReasonCode =
  | "carrier_unavailable"
  | "carrier_timeout"
  | "beacon_expired"
  | "beacon_malformed"
  | "beacon_signature_invalid"
  | "peer_unreachable"
  | "handshake_timeout"
  | "handshake_protocol_error"
  | "route_no_candidate"
  | "route_degraded"
  | "relay_unavailable"
  | "queue_overflow"
  | "diagnostic_expired";

export interface DiagnosticEvent {
  readonly timestamp: number;
  readonly event: DiagnosticEventName;
  readonly mode: DiagnosticMode;
  readonly reason_code?: DiagnosticReasonCode;
  readonly attributes?: readonly DiagnosticAttribute[];
}

export interface DiagnosticAttribute {
  readonly key: DiagnosticAttributeKey;
  readonly value: string;
}

export type DiagnosticAttributeKey =
  | "carrier"
  | "transport"
  | "result"
  | "protocol_version"
  | "storage_area"
  | "service_worker_phase";

export interface DiagnosticJournalOptions {
  readonly maxEvents: number;
  readonly maxAgeMs: number;
  readonly now?: () => number;
}

export interface RedactedDiagnosticExport {
  readonly schema: "branch.diagnostics.export/0";
  readonly generated_at: number;
  readonly events: readonly DiagnosticEvent[];
}

const forbiddenValueMarkers = [
  "payload",
  "private_key",
  "capability_token",
  "identity_export",
  "authentication_secret",
  "contact_name",
  "indexeddb",
  "cookie",
  "authorization"
] as const;

export class DiagnosticJournal {
  readonly #maxEvents: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #events: DiagnosticEvent[] = [];

  constructor(options: DiagnosticJournalOptions) {
    if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0) {
      throw new Error("maxEvents must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs <= 0) {
      throw new Error("maxAgeMs must be a positive integer");
    }

    this.#maxEvents = options.maxEvents;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
  }

  record(input: Omit<DiagnosticEvent, "timestamp"> & { readonly timestamp?: number }): void {
    if (input.mode === "off") {
      return;
    }

    const timestamp = input.timestamp ?? this.#now();
    const event = buildEvent(
      timestamp,
      input.event,
      input.mode,
      input.reason_code,
      sanitizeAttributes(input.attributes ?? [])
    );

    this.#events.push(event);
    this.#trim(timestamp);
  }

  snapshot(): readonly DiagnosticEvent[] {
    this.#trim(this.#now());
    return this.#events.map(cloneEvent);
  }

  createManualExport(): RedactedDiagnosticExport {
    const generatedAt = this.#now();
    this.#trim(generatedAt);

    return {
      schema: "branch.diagnostics.export/0",
      generated_at: generatedAt,
      events: this.#events.map(cloneEvent)
    };
  }

  #trim(now: number): void {
    const oldest = now - this.#maxAgeMs;
    this.#events = this.#events.filter((event) => event.timestamp >= oldest);

    if (this.#events.length > this.#maxEvents) {
      this.#events = this.#events.slice(this.#events.length - this.#maxEvents);
    }
  }
}

function sanitizeAttributes(attributes: readonly DiagnosticAttribute[]): readonly DiagnosticAttribute[] {
  return attributes.map((attribute) => ({
    key: attribute.key,
    value: sanitizeValue(attribute.value)
  }));
}

function sanitizeValue(value: string): string {
  const lowered = value.toLowerCase();
  if (forbiddenValueMarkers.some((marker) => lowered.includes(marker))) {
    return "[redacted]";
  }

  if (looksLikeURL(value) || looksLikeIP(value)) {
    return "[redacted]";
  }

  return value.slice(0, 256);
}

function looksLikeURL(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function looksLikeIP(value: string): boolean {
  return /(?:^|\D)(?:\d{1,3}\.){3}\d{1,3}(?:\D|$)/u.test(value);
}

function cloneEvent(event: DiagnosticEvent): DiagnosticEvent {
  return buildEvent(
    event.timestamp,
    event.event,
    event.mode,
    event.reason_code,
    event.attributes?.map((attribute) => ({ ...attribute })) ?? []
  );
}

function buildEvent(
  timestamp: number,
  event: DiagnosticEventName,
  mode: DiagnosticMode,
  reasonCode: DiagnosticReasonCode | undefined,
  attributes: readonly DiagnosticAttribute[]
): DiagnosticEvent {
  const base = {
    timestamp,
    event,
    mode,
    attributes
  };

  if (reasonCode !== undefined) {
    return { ...base, reason_code: reasonCode };
  }

  return base;
}
