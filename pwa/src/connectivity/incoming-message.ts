import {
  betaPwaMessageType,
  betaPwaPresencePingType,
  decodeBetaPwaApplicationPayload,
  validatePeerID
} from "./message-payload.js";

export type IncomingMessageDisposition =
  | { readonly kind: "known_contact_message"; readonly body: string; readonly contactId: string }
  | { readonly kind: "known_contact_presence_ping"; readonly contactId: string; readonly pingId: string }
  | { readonly kind: "known_contact_presence_pong"; readonly contactId: string; readonly pingId: string }
  | { readonly kind: "message_request"; readonly body: string; readonly senderPeerId: string; readonly senderHpkePublicKey: string; readonly senderDisplayName: string }
  | { readonly kind: "drop_unknown_legacy" }
  | { readonly kind: "drop_unknown_control" };

// This deterministic application boundary runs only after HPKE opening. A
// control ping/pong is actionable only for a known contact, preventing an
// unknown sender from eliciting automatic traffic or creating a request.
export function classifyIncomingMessage(options: {
  readonly plaintext: string;
  readonly senderPeerId: string;
  readonly knownContactId: string | null;
}): IncomingMessageDisposition {
  validatePeerID(options.senderPeerId);
  try {
    const payload = decodeBetaPwaApplicationPayload(options.plaintext);
    if (payload.type === betaPwaMessageType) {
      if (options.knownContactId !== null) {
        return { kind: "known_contact_message", contactId: options.knownContactId, body: payload.body };
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
    return { kind: "known_contact_message", contactId: options.knownContactId, body: options.plaintext };
  }
}
