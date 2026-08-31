export const protocolID = "branch/connectivity/0" as const;
export const maxDraftEnvelopeBytes = 64 * 1024;
export const maxDraftStringBytes = 1024;
export const maxDraftTimestamp = Number.MAX_SAFE_INTEGER;

const eventTypes = [
  "identity.announce",
  "bootstrap.beacon",
  "rendezvous.offer",
  "rendezvous.answer",
  "route.update",
  "relay.announce",
  "capability.grant",
  "capability.revoke"
] as const;

export type EventType = (typeof eventTypes)[number];
export type PayloadMode = "public" | "sealed";

export interface Sender {
  readonly key_alg: "ed25519";
  readonly public_key: string;
}

export interface DraftEnvelope {
  readonly protocol: typeof protocolID;
  readonly event_id: string;
  readonly type: EventType;
  readonly sender: Sender;
  readonly recipient_tag: string | undefined;
  readonly created_at: number;
  readonly expires_at: number;
  readonly payload_mode: PayloadMode;
  readonly payload: string;
  readonly signature_alg: "ed25519";
  readonly signature: string;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function isKnownEventType(value: string): value is EventType {
  return eventTypes.some((eventType) => eventType === value);
}

export function decodeDraftEnvelopeText(text: string): DraftEnvelope {
  if (new TextEncoder().encode(text).byteLength > maxDraftEnvelopeBytes) {
    throw new ProtocolError("oversized draft envelope");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid draft envelope");
  }
  return validateDraftEnvelope(decoded);
}

export function validateDraftEnvelope(value: unknown): DraftEnvelope {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid draft envelope");
  }
  rejectUnknownKeys(value, [
    "protocol",
    "event_id",
    "type",
    "sender",
    "recipient_tag",
    "created_at",
    "expires_at",
    "payload_mode",
    "payload",
    "signature_alg",
    "signature"
  ]);

  const envelope = {
    protocol: readLiteral(value, "protocol", protocolID),
    event_id: readBase64URLBytes(value, "event_id", 32),
    type: readEventType(value, "type"),
    sender: readSender(value, "sender"),
    recipient_tag: readOptionalRecipientTag(value, "recipient_tag"),
    created_at: readInteger(value, "created_at"),
    expires_at: readInteger(value, "expires_at"),
    payload_mode: readPayloadMode(value, "payload_mode"),
    payload: readBase64URLString(value, "payload"),
    signature_alg: readLiteral(value, "signature_alg", "ed25519"),
    signature: readBase64URLBytes(value, "signature", 64)
  } satisfies DraftEnvelope;

  if (envelope.expires_at <= envelope.created_at) {
    throw new ProtocolError("expiry must be after creation");
  }
  if (requiresRecipientTag(envelope.type) && envelope.recipient_tag === undefined) {
    throw new ProtocolError("missing recipient_tag");
  }
  if (!validPayloadMode(envelope.type, envelope.payload_mode)) {
    throw new ProtocolError("invalid payload_mode");
  }

  return envelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const known = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new ProtocolError(`unknown ${key}`);
    }
  }
}

function readLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  expected: T
): T {
  const value = readString(record, key);
  if (value !== expected) {
    throw new ProtocolError(`unsupported ${key}`);
  }
  return expected;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxDraftStringBytes
  ) {
    throw new ProtocolError(`missing ${key}`);
  }
  return value;
}

function readSender(record: Record<string, unknown>, key: string): Sender {
  const value = record[key];
  if (!isRecord(value)) {
    throw new ProtocolError(`missing ${key}`);
  }
  rejectUnknownKeys(value, ["key_alg", "public_key"]);
  return {
    key_alg: readLiteral(value, "key_alg", "ed25519"),
    public_key: readBase64URLBytes(value, "public_key", 32)
  };
}

function readOptionalRecipientTag(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  const text = readString(record, key);
  if (!validBase64URLSize(text, 16) && !validBase64URLSize(text, 32)) {
    throw new ProtocolError(`invalid ${key}`);
  }
  return text;
}

function readPayloadMode(record: Record<string, unknown>, key: string): PayloadMode {
  const value = readString(record, key);
  if (value !== "public" && value !== "sealed") {
    throw new ProtocolError(`invalid ${key}`);
  }
  return value;
}

function readBase64URLString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!validBase64URL(value)) {
    throw new ProtocolError(`invalid ${key}`);
  }
  return value;
}

function readBase64URLBytes(record: Record<string, unknown>, key: string, size: number): string {
  const value = readString(record, key);
  if (!validBase64URLSize(value, size)) {
    throw new ProtocolError(`invalid ${key}`);
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maxDraftTimestamp
  ) {
    throw new ProtocolError(`invalid ${key}`);
  }
  return value;
}

function readEventType(record: Record<string, unknown>, key: string): EventType {
  const value = readString(record, key);
  if (!isKnownEventType(value)) {
    throw new ProtocolError("unsupported event type");
  }
  return value;
}

function requiresRecipientTag(eventType: EventType): boolean {
  return (
    eventType === "rendezvous.offer" ||
    eventType === "rendezvous.answer" ||
    eventType === "route.update" ||
    eventType === "capability.grant" ||
    eventType === "capability.revoke"
  );
}

function validPayloadMode(eventType: EventType, mode: PayloadMode): boolean {
  if (eventType === "bootstrap.beacon" || eventType === "relay.announce") {
    return mode === "public";
  }
  if (eventType === "identity.announce") {
    return true;
  }
  return mode === "sealed";
}

function validBase64URL(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  return value.length % 4 !== 1;
}

function validBase64URLSize(value: string, size: number): boolean {
  const encodedLength = Math.ceil((size * 8) / 6);
  return validBase64URL(value) && value.length === encodedLength;
}
