import {
  applicationPayloadVersion,
  chatTextKind,
  decodeBase64URL,
  encodeApplicationPayload,
  type ApplicationPayloadEnvelope
} from "@code4bones/branch-core";

import { maxBetaPwaMessageBodyBytes } from "./message-payload.js";

const textEncoder = new TextEncoder();

// The PWA adapter's registered ordinary text descriptor has a strict UTF-8
// body. The envelope itself remains the shared protocol-core CBOR shape.
export function encodeChatTextApplicationPayload(options: {
  readonly messageId: string;
  readonly body: string;
  readonly replyToMessageId?: string;
}): Uint8Array {
  if (options.replyToMessageId !== undefined && !isApplicationMessageId(options.replyToMessageId)) {
    throw new Error("invalid generic chat reply");
  }
  const text = JSON.stringify({ body: options.body, ...(options.replyToMessageId === undefined ? {} : { reply_to_message_id: options.replyToMessageId }) });
  const body = textEncoder.encode(text);
  if (options.body.trim() === "" || body.byteLength > maxBetaPwaMessageBodyBytes) {
    throw new Error("invalid generic chat text");
  }
  const envelope: ApplicationPayloadEnvelope = {
    version: applicationPayloadVersion,
    kind: chatTextKind,
    messageId: options.messageId,
    body
  };
  return encodeApplicationPayload(envelope);
}

function isApplicationMessageId(value: string): boolean {
  try { return decodeBase64URL(value).byteLength === 16; } catch { return false; }
}
