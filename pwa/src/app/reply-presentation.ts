import type { LocalImageMessageProjection } from "./image-message.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";

const maximumReplyTextCharacters = 140;

/**
 * Resolves a reply exclusively against messages already projected on this
 * device. It never requests, copies, or transports source content.
 */
export type ReplyPreview =
  | { readonly kind: "text"; readonly body: string }
  | { readonly kind: "image"; readonly objectUrl: string | null; readonly loadObjectUrl?: () => Promise<string | null>; readonly caption?: string }
  | { readonly kind: "missing" };

export function resolveLocalReplyPreview(replyToMessageId: string, messages: readonly MessageSummary[], images: readonly LocalImageMessageProjection[]): ReplyPreview {
  const text = messages.find((message) => message.applicationMessageId === replyToMessageId);
  if (text !== undefined) return { kind: "text", body: compactReplyText(text.body) };
  const image = images.find((candidate) => candidate.messageId === replyToMessageId);
  if (image !== undefined) return {
    kind: "image",
    objectUrl: image.objectUrl ?? null,
    ...(image.loadObjectUrl === undefined ? {} : { loadObjectUrl: image.loadObjectUrl }),
    ...(image.caption === undefined ? {} : { caption: compactReplyText(image.caption) })
  };
  return { kind: "missing" };
}

/**
 * Opens only the endpoint-owned Blob projection retained by the local image
 * store. Reply previews never turn a message reference into a network fetch.
 */
export async function loadLocalReplyImagePreview(reply: ReplyPreview): Promise<string | null> {
  if (reply.kind !== "image" || reply.objectUrl !== null || reply.loadObjectUrl === undefined) return null;
  return reply.loadObjectUrl();
}

export function compactReplyText(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maximumReplyTextCharacters ? normalized : `${normalized.slice(0, maximumReplyTextCharacters - 1)}…`;
}
