import {
  chatTextKind,
  classifyApplicationPayload,
  createApplicationPayloadRegistry
} from "@code4bones/branch-core";

import {
  betaPwaMessageType,
  betaPwaPresencePingType,
  decodeBetaPwaApplicationPayload,
  maxBetaPwaMessageBodyBytes,
  validatePeerID
} from "./message-payload.js";

export type IncomingMessageDisposition =
  | { readonly kind: "known_contact_message"; readonly body: string; readonly contactId: string; readonly applicationMessageId: string | null }
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
      : { kind: "known_contact_message", contactId: options.knownContactId, body, applicationMessageId: payload.envelope.messageId };
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

function decodeChatText(bytes: Uint8Array): string {
  const body = textDecoder.decode(bytes);
  if (body.trim() === "" || bytes.byteLength > maxBetaPwaMessageBodyBytes) {
    throw new Error("invalid generic chat text");
  }
  return body;
}
