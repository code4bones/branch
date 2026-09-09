import { decodeBase64URL } from "@code4bones/branch-core";

export const betaPwaMessageType = "branch.pwa.message/0.draft" as const;
export const betaPwaPresencePingType = "branch.pwa.presence.ping/0.draft" as const;
export const betaPwaPresencePongType = "branch.pwa.presence.pong/0.draft" as const;
export const maxBetaPwaMessageBodyBytes = 3_000;
export const maxBetaPwaDisplayNameBytes = 80;

export interface BetaPwaMessagePayload {
  readonly type: typeof betaPwaMessageType;
  readonly body: string;
  readonly replyHpkePublicKey: string;
  readonly senderDisplayName: string;
}

export interface BetaPwaPresencePingPayload {
  readonly type: typeof betaPwaPresencePingType;
  readonly pingId: string;
}

export interface BetaPwaPresencePongPayload {
  readonly type: typeof betaPwaPresencePongType;
  readonly pingId: string;
}

export type BetaPwaApplicationPayload = BetaPwaMessagePayload | BetaPwaPresencePingPayload | BetaPwaPresencePongPayload;

const textEncoder = new TextEncoder();

// This is application plaintext inside the existing HPKE envelope, not a new
// relay frame. Control variants have no body, identity metadata, or routing
// material: they are only a bounded end-to-end liveness correlation token.
export function encodeBetaPwaMessagePayload(options: Omit<BetaPwaMessagePayload, "type">): string {
  validateBody(options.body);
  validateHpkePublicKey(options.replyHpkePublicKey);
  validateDisplayName(options.senderDisplayName);
  return JSON.stringify({
    type: betaPwaMessageType,
    body: options.body,
    reply_hpke_public_key: options.replyHpkePublicKey,
    sender_display_name: options.senderDisplayName
  });
}

export function encodeBetaPwaPresencePing(pingId: string): string {
  validatePresencePingID(pingId);
  return JSON.stringify({ type: betaPwaPresencePingType, ping_id: pingId });
}

export function encodeBetaPwaPresencePong(pingId: string): string {
  validatePresencePingID(pingId);
  return JSON.stringify({ type: betaPwaPresencePongType, ping_id: pingId });
}

export function decodeBetaPwaMessagePayload(value: string): BetaPwaMessagePayload {
  const payload = decodeBetaPwaApplicationPayload(value);
  if (payload.type !== betaPwaMessageType) {
    throw new Error("invalid beta message payload");
  }
  return payload;
}

export function decodeBetaPwaApplicationPayload(value: string): BetaPwaApplicationPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid beta application payload");
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
    throw new Error("invalid beta application payload");
  }
  switch (parsed["type"]) {
    case betaPwaMessageType:
      if (!hasExactKeys(parsed, ["type", "body", "reply_hpke_public_key", "sender_display_name"]) || typeof parsed["body"] !== "string" || typeof parsed["reply_hpke_public_key"] !== "string" || typeof parsed["sender_display_name"] !== "string") {
        throw new Error("invalid beta message payload");
      }
      validateBody(parsed["body"]);
      validateHpkePublicKey(parsed["reply_hpke_public_key"]);
      validateDisplayName(parsed["sender_display_name"]);
      return {
        type: betaPwaMessageType,
        body: parsed["body"],
        replyHpkePublicKey: parsed["reply_hpke_public_key"],
        senderDisplayName: parsed["sender_display_name"]
      };
    case betaPwaPresencePingType:
    case betaPwaPresencePongType:
      if (!hasExactKeys(parsed, ["type", "ping_id"]) || typeof parsed["ping_id"] !== "string") {
        throw new Error("invalid beta presence payload");
      }
      validatePresencePingID(parsed["ping_id"]);
      return parsed["type"] === betaPwaPresencePingType
        ? { type: betaPwaPresencePingType, pingId: parsed["ping_id"] }
        : { type: betaPwaPresencePongType, pingId: parsed["ping_id"] };
    default:
      throw new Error("unknown beta application payload");
  }
}

export function validatePeerID(peerId: string): void {
  if (decodeBase64URL(peerId).byteLength !== 32) {
    throw new Error("invalid peer id");
  }
}

export function validateHpkePublicKey(publicKey: string): void {
  if (decodeBase64URL(publicKey).byteLength !== 32) {
    throw new Error("invalid HPKE public key");
  }
}

export function validateDisplayName(displayName: string): void {
  if (displayName.trim() === "" || textEncoder.encode(displayName).byteLength > maxBetaPwaDisplayNameBytes) {
    throw new Error("invalid display name");
  }
}

function validateBody(body: string): void {
  if (body.trim() === "" || textEncoder.encode(body).byteLength > maxBetaPwaMessageBodyBytes) {
    throw new Error("invalid beta message body");
  }
}

function validatePresencePingID(pingId: string): void {
  if (decodeBase64URL(pingId).byteLength !== 16) {
    throw new Error("invalid presence ping id");
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
