export const protocolID = "branch/0" as const;
export const maxDraftEnvelopeBytes = 64 * 1024;

const eventTypes = [
  "identity.announce",
  "rendezvous.offer",
  "rendezvous.answer",
  "route.update",
  "relay.announce",
  "capability.grant",
  "capability.revoke"
] as const;

export type EventType = (typeof eventTypes)[number];

export interface DraftEnvelope {
  readonly protocol: typeof protocolID;
  readonly id: string;
  readonly type: EventType;
  readonly sender: string;
  readonly recipient_tag: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly nonce: string;
  readonly payload: string;
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

  const decoded: unknown = JSON.parse(text);
  return validateDraftEnvelope(decoded);
}

export function validateDraftEnvelope(value: unknown): DraftEnvelope {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid draft envelope");
  }
  rejectUnknownKeys(value, [
    "protocol",
    "id",
    "type",
    "sender",
    "recipient_tag",
    "created_at",
    "expires_at",
    "nonce",
    "payload",
    "signature"
  ]);

  const envelope = {
    protocol: readLiteral(value, "protocol", protocolID),
    id: readString(value, "id"),
    type: readEventType(value, "type"),
    sender: readString(value, "sender"),
    recipient_tag: readString(value, "recipient_tag"),
    created_at: readInteger(value, "created_at"),
    expires_at: readInteger(value, "expires_at"),
    nonce: readString(value, "nonce"),
    payload: readString(value, "payload"),
    signature: readString(value, "signature")
  } satisfies DraftEnvelope;

  if (envelope.expires_at <= envelope.created_at) {
    throw new ProtocolError("expiry must be after creation");
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
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(`missing ${key}`);
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
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
