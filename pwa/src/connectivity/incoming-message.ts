import {
  chatTextKind,
  classifyApplicationPayload,
  createApplicationPayloadRegistry,
  decodeBase64URL
} from "@code4bones/branch-core";

import {
  betaPwaMessageType,
  betaPwaPresencePingType,
  decodeBetaPwaApplicationPayload,
  maxBetaPwaMessageBodyBytes,
  validatePeerID
} from "./message-payload.js";

export type IncomingMessageDisposition =
  | { readonly kind: "known_contact_message"; readonly body: string; readonly contactId: string; readonly applicationMessageId: string | null; readonly replyToMessageId?: string }
  | { readonly kind: "known_contact_presence_ping"; readonly contactId: string; readonly pingId: string }
  | { readonly kind: "known_contact_presence_pong"; readonly contactId: string; readonly pingId: string }
  | { readonly kind: "message_request"; readonly body: string; readonly senderPeerId: string; readonly senderHpkePublicKey: string; readonly senderDisplayName: string }
  | { readonly kind: "drop_unknown_application" }
  | { readonly kind: "drop_unknown_legacy" }
  | { readonly kind: "drop_unknown_control" };

// This deterministic application boundary runs only after HPKE opening. A
// control ping/pong is actionable only for a known contact, preventing an
// unknown sender from eliciting automatic traffic or creating a request.
export function classifyIncomingMessage(options: {
  readonly plaintext: Uint8Array | string;
  readonly senderPeerId: string;
  readonly knownContactId: string | null;
}): IncomingMessageDisposition {
  validatePeerID(options.senderPeerId);
  const plaintext = typeof options.plaintext === "string" ? textEncoder.encode(options.plaintext) : options.plaintext;
  try {
    const payload = classifyApplicationPayload(plaintext, applicationPayloadRegistry);
    if (payload.status === "unknown_kind") {
      return { kind: "drop_unknown_application" };
    }
    if (payload.envelope.kind !== chatTextKind) {
      return { kind: "drop_unknown_application" };
    }
    const body = decodeChatText(payload.envelope.body);
    return options.knownContactId === null
      ? { kind: "drop_unknown_application" }
      : { kind: "known_contact_message", contactId: options.knownContactId, body: body.body, applicationMessageId: payload.envelope.messageId, ...(body.replyToMessageId === undefined ? {} : { replyToMessageId: body.replyToMessageId }) };
  } catch {
    // Only a non-application payload may fall through to the explicit beta
    // compatibility grammar. Canonical CBOR maps are not valid strict UTF-8.
  }
  let legacyPlaintext = "";
  try {
    legacyPlaintext = textDecoder.decode(plaintext);
    const payload = decodeBetaPwaApplicationPayload(legacyPlaintext);
    if (payload.type === betaPwaMessageType) {
      if (options.knownContactId !== null) {
        return { kind: "known_contact_message", contactId: options.knownContactId, body: payload.body, applicationMessageId: null };
      }
      return {
        kind: "message_request",
        senderPeerId: options.senderPeerId,
        senderHpkePublicKey: payload.replyHpkePublicKey,
        senderDisplayName: payload.senderDisplayName,
        body: payload.body
      };
    }
    if (options.knownContactId === null) {
      return { kind: "drop_unknown_control" };
    }
    if (payload.type === betaPwaPresencePingType) {
      return { kind: "known_contact_presence_ping", contactId: options.knownContactId, pingId: payload.pingId };
    }
    return { kind: "known_contact_presence_pong", contactId: options.knownContactId, pingId: payload.pingId };
  } catch {
    if (options.knownContactId === null) {
      return { kind: "drop_unknown_legacy" };
    }
    if (legacyPlaintext === "") {
      return { kind: "drop_unknown_legacy" };
    }
    return { kind: "known_contact_message", contactId: options.knownContactId, body: legacyPlaintext, applicationMessageId: null };
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const applicationPayloadRegistry = createApplicationPayloadRegistry([{
  kind: chatTextKind,
  maximumBodyBytes: maxBetaPwaMessageBodyBytes,
  requiredCapability: chatTextKind
}]);

function decodeChatText(bytes: Uint8Array): { readonly body: string; readonly replyToMessageId?: string } {
  const raw = textDecoder.decode(bytes);
  if (raw.trim() === "" || bytes.byteLength > maxBetaPwaMessageBodyBytes) {
    throw new Error("invalid generic chat text");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).body === "string") {
      const record = value as Record<string, unknown>;
      const textBody = record.body;
      if (typeof textBody !== "string" || !Object.keys(record).every((key) => key === "body" || key === "reply_to_message_id") || textBody.trim() === "") throw new Error("invalid generic chat text");
      if (record.reply_to_message_id === undefined) return { body: textBody };
      if (typeof record.reply_to_message_id !== "string" || !isMessageId(record.reply_to_message_id)) throw new Error("invalid generic chat reply");
      return { body: textBody, replyToMessageId: record.reply_to_message_id };
    }
  } catch (cause) { if (cause instanceof Error && cause.message.startsWith("invalid")) throw cause; }
  return { body: raw };
}

function isMessageId(value: string): boolean { try { return decodeBase64URL(value).byteLength === 16; } catch { return false; } }
