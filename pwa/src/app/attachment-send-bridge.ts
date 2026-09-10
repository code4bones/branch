import type { AppStoreApi } from "../state/store.js";
import type { AttachmentControllerEvent } from "../connectivity/attachment-transfer.js";

/** Local presentation gate; the controller repeats all admission checks. */
export type AttachmentSendAdmission =
  | { readonly status: "ready" }
  | { readonly status: "unavailable" | "unsupported" | "busy" };

export type AttachmentSendResult =
  | { readonly status: "offered"; readonly transferId: string }
  | { readonly status: "rejected"; readonly reason: "unknown_peer" | "unsupported" | "busy" | "unavailable" | "send_failed" };

export interface AttachmentSendBridge {
  /** Checks the current volatile known-contact/capability/live-route admission. */
  readonly canSelect: (peerId: string) => AttachmentSendAdmission;
  /** The existing controller remains the sole owner of File and chunk state. */
  readonly offer: (peerId: string, file: File) => Promise<AttachmentSendResult>;
}

// The bridge is tab-local and never enters React state, Zustand or storage.
const bridgesByStore = new WeakMap<AppStoreApi, AttachmentSendBridge>();
const progressListenersByStore = new WeakMap<AppStoreApi, Set<(event: AttachmentControllerEvent) => void>>();

/** Called by the connectivity composition root after it builds the controller. */
export function installAttachmentSendBridge(storeApi: AppStoreApi, bridge: AttachmentSendBridge): () => void {
  bridgesByStore.set(storeApi, bridge);
  return () => {
    if (bridgesByStore.get(storeApi) === bridge) {
      bridgesByStore.delete(storeApi);
    }
  };
}

export function attachmentSendAdmission(storeApi: AppStoreApi, peerId: string): AttachmentSendAdmission {
  return bridgesByStore.get(storeApi)?.canSelect(peerId) ?? { status: "unavailable" };
}

export async function offerSelectedAttachment(storeApi: AppStoreApi, peerId: string, file: File): Promise<AttachmentSendResult> {
  const bridge = bridgesByStore.get(storeApi);
  if (bridge === undefined) {
    return { status: "rejected", reason: "unavailable" };
  }
  return await bridge.offer(peerId, file);
}

// Progress is an in-tab UI observation of an already-running live transfer.
// It is never persisted, replayed, or used to affect controller state.
export function subscribeAttachmentSendProgress(storeApi: AppStoreApi, listener: (event: AttachmentControllerEvent) => void): () => void {
  let listeners = progressListenersByStore.get(storeApi);
  if (listeners === undefined) {
    listeners = new Set();
    progressListenersByStore.set(storeApi, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) progressListenersByStore.delete(storeApi);
  };
}

export function notifyAttachmentSendProgress(storeApi: AppStoreApi, event: AttachmentControllerEvent): void {
  for (const listener of progressListenersByStore.get(storeApi) ?? []) {
    try { listener(event); } catch { /* Presentation observers never affect transit. */ }
  }
}
