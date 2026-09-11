import type { AppStoreApi } from "../state/store.js";
import type { ImageMessageProjection } from "../state/slices/image-message-projections-slice.js";
import { imageMessageMediaStore, type ImageMessageMediaStorePort, type StoreVerifiedImageMessageResult } from "../storage/image-media-store.js";

/** Input accepted only after the protocol/transfer layer has verified it. */
export interface VerifiedImageMessage {
  readonly projection: ImageMessageProjection;
  readonly bytes: Uint8Array;
}

export type StageVerifiedImageMessageResult = StoreVerifiedImageMessageResult | "projection_rejected";

/**
 * Commits verified bytes and their serializable presentation projection before
 * any UI adapter observes it. This has no relay, transport, logging or Blob-URL
 * responsibility; those boundaries remain callers' concerns.
 */
export async function stageVerifiedImageMessage(
  storeApi: AppStoreApi,
  image: VerifiedImageMessage,
  mediaStore: ImageMessageMediaStorePort = imageMessageMediaStore
): Promise<StageVerifiedImageMessageResult> {
  const result = await mediaStore.storeVerified(image.projection, image.bytes);
  if (result !== "stored" && result !== "already_stored") return result;
  return storeApi.getState().stageImageMessageProjection(image.projection) ? result : "projection_rejected";
}
