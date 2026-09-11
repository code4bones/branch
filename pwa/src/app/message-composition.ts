import type { MessageSummary } from "../state/slices/conversations-slice.js";

export interface OutgoingTextComposition {
  readonly message: MessageSummary;
  // This endpoint-only identity is encoded inside the generic text envelope.
  // It is intentionally separate from both local UI and outer delivery IDs.
  readonly applicationMessageId: string;
}

// Compose a new user-authored text projection. Callers may use this for a
// normal composition or an explicit forward, but must provide only text: no
// original delivery state, timestamps, contact identity, or receipt metadata
// can enter the new message through this boundary.
export function composeOutgoingText(options: {
  readonly contactId: string;
  readonly body: string;
  readonly createdAt: number;
  readonly createId: () => string;
  readonly replyToMessageId?: string;
}): OutgoingTextComposition {
  const messageId = options.createId();
  const applicationMessageId = options.createId();
  if (messageId === "" || applicationMessageId === "" || messageId === applicationMessageId) {
    throw new Error("outgoing message identifiers must be fresh and distinct");
  }
  return {
    message: {
      messageId,
      contactId: options.contactId,
      direction: "outgoing",
      body: options.body,
      sentAt: options.createdAt,
      deliveryState: "pending",
      applicationMessageId,
      ...(options.replyToMessageId === undefined ? {} : { replyToMessageId: options.replyToMessageId })
    },
    applicationMessageId
  };
}
