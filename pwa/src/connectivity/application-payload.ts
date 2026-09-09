import {
  applicationPayloadVersion,
  chatTextKind,
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
}): Uint8Array {
  const body = textEncoder.encode(options.body);
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
