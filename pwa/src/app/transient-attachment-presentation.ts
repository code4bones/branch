import { maxRelayAttachmentBytes } from "@code4bones/branch-core";

import type { AppStoreApi } from "../state/store.js";
import type { CompletedAttachment } from "../state/slices/completed-attachments-slice.js";

/** Only a small number of verified, live-tab handles may be retained at once. */
export const maxTransientCompletedAttachments = 4;

/** Metadata + verified bytes delivered by the attachment adapter after SHA-256. */
export interface InboundAttachmentCompletion {
  readonly peerId: string;
  readonly transferId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly expiresAt: number;
}

/** Structural subset of the detached verified controller manifest. */
export interface InboundAttachmentCompletionOffer {
  readonly peerId: string;
  readonly manifest: {
    readonly transferId: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteCount: number;
    readonly expiresAt: number;
  };
}

/** Narrow adapter contract: only verified completion may create a handle. */
export interface InboundAttachmentCompletionHandler {
  readonly complete: (offer: InboundAttachmentCompletionOffer, bytes: Uint8Array) => void;
  /** A terminal loss/removal clears one peer, or every peer when omitted. */
  readonly clear: (peerId?: string) => void;
}

export type CompletedAttachmentDownloadResult = "downloaded" | "not_found" | "unavailable";

interface RetainedAttachment {
  readonly metadata: CompletedAttachment;
  readonly bytes: Uint8Array;
  readonly expiryTimer: ReturnType<typeof setTimeout>;
}

interface DownloadDocument {
  readonly body: { readonly append: (node: HTMLAnchorElement) => void };
  readonly createElement: (tagName: "a") => HTMLAnchorElement;
}

interface DownloadURL {
  readonly createObjectURL: (value: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

export interface AttachmentDownloadEnvironment {
  readonly document: DownloadDocument;
  readonly url: DownloadURL;
}

// Weak ownership prevents a tab's temporary bytes from outliving its app-store.
// The value is intentionally outside Zustand, IndexedDB and every persistence
// bootstrap path. It is the only place this feature retains file bytes.
const registriesByStore = new WeakMap<AppStoreApi, Map<string, RetainedAttachment>>();

/**
 * Returns the narrow callback that the verified attachment adapter installs
 * after its whole-file integrity gate. Calling this does not imply network
 * acceptance: its input is already endpoint-verified by that adapter.
 */
export function inboundAttachmentCompletionHandler(storeApi: AppStoreApi): InboundAttachmentCompletionHandler {
  return {
    complete: (offer, bytes) => {
      stageVerifiedCompletedAttachment(storeApi, {
        peerId: offer.peerId,
        transferId: offer.manifest.transferId,
        fileName: offer.manifest.fileName,
        mediaType: offer.manifest.mediaType,
        byteCount: offer.manifest.byteCount,
        expiresAt: offer.manifest.expiresAt
      }, bytes);
    },
    clear: (peerId) => {
      if (peerId === undefined) {
        clearTransientCompletedAttachments(storeApi);
        return;
      }
      clearTransientCompletedAttachment(storeApi, peerId);
    }
  };
}

/** Stores one verified bounded byte handle per peer until manifest expiry. */
export function stageVerifiedCompletedAttachment(
  storeApi: AppStoreApi,
  attachment: InboundAttachmentCompletion,
  bytes: Uint8Array,
  now = Date.now()
): boolean {
  if (!validCompletion(attachment, bytes, now)) {
    return false;
  }
  const registry = registryFor(storeApi);
  const current = registry.get(attachment.peerId);
  if (current === undefined && registry.size >= maxTransientCompletedAttachments) {
    return false;
  }
  if (current !== undefined) {
    clearTransientCompletedAttachment(storeApi, attachment.peerId);
  }
  // Copy at the trusted adapter boundary. The controller may release or reuse
  // its receive buffer as soon as the completion callback returns.
  const retainedBytes = new Uint8Array(bytes);
  const metadata: CompletedAttachment = {
    peerId: attachment.peerId,
    transferId: attachment.transferId,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    byteCount: attachment.byteCount,
    expiresAt: attachment.expiresAt,
    completedAt: now
  };
  const delayMs = attachment.expiresAt - now;
  const expiryTimer = setTimeout(() => {
    const retained = registry.get(attachment.peerId);
    if (retained?.metadata.transferId === attachment.transferId) {
      clearTransientCompletedAttachment(storeApi, attachment.peerId);
    }
  }, delayMs);
  registry.set(attachment.peerId, { metadata, bytes: retainedBytes, expiryTimer });
  storeApi.getState().setCompletedAttachmentProjection(metadata);
  return true;
}

/** Clears exactly one peer's volatile metadata and byte handle. */
export function clearTransientCompletedAttachment(storeApi: AppStoreApi, peerId: string): void {
  storeApi.getState().clearCompletedAttachmentProjection(peerId);
}

/** Clears every transient completed handle on disconnect, app teardown or reset. */
export function clearTransientCompletedAttachments(storeApi: AppStoreApi): void {
  storeApi.getState().clearCompletedAttachmentProjections();
}

/**
 * Runs only as an explicit user click. A browser object URL is created only
 * around that click and is always revoked before this method returns.
 */
export function downloadVerifiedCompletedAttachment(
  storeApi: AppStoreApi,
  peerId: string,
  environment: AttachmentDownloadEnvironment | null = browserDownloadEnvironment()
): CompletedAttachmentDownloadResult {
  const retained = registriesByStore.get(storeApi)?.get(peerId);
  if (retained === undefined) {
    return "not_found";
  }
  if (retained.metadata.expiresAt <= Date.now()) {
    clearTransientCompletedAttachment(storeApi, peerId);
    return "not_found";
  }
  if (environment === null) {
    return "unavailable";
  }
  const blob = new Blob([copiedArrayBuffer(retained.bytes)], { type: retained.metadata.mediaType });
  const objectUrl = environment.url.createObjectURL(blob);
  const anchor = environment.document.createElement("a");
  try {
    anchor.href = objectUrl;
    anchor.download = safeDownloadName(retained.metadata.fileName);
    anchor.style.display = "none";
    environment.document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    environment.url.revokeObjectURL(objectUrl);
  }
  return "downloaded";
}

function registryFor(storeApi: AppStoreApi): Map<string, RetainedAttachment> {
  let registry = registriesByStore.get(storeApi);
  if (registry === undefined) {
    registry = new Map();
    registriesByStore.set(storeApi, registry);
    const boundRegistry = registry;
    storeApi.getState().bindCompletedAttachmentHandleCleanup({
      clearPeer: (peerId) => {
        const retained = boundRegistry.get(peerId);
        if (retained !== undefined) {
          clearTimeout(retained.expiryTimer);
          boundRegistry.delete(peerId);
        }
      },
      clearAll: () => {
        for (const retained of boundRegistry.values()) {
          clearTimeout(retained.expiryTimer);
        }
        boundRegistry.clear();
      }
    });
  }
  return registry;
}

function browserDownloadEnvironment(): AttachmentDownloadEnvironment | null {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  return { document, url: URL };
}

function validCompletion(attachment: InboundAttachmentCompletion, bytes: Uint8Array, now: number): boolean {
  return boundedText(attachment.peerId, 512) && boundedText(attachment.transferId, 128) &&
    boundedText(attachment.fileName, 160) && boundedText(attachment.mediaType, 128) &&
    Number.isSafeInteger(attachment.byteCount) && attachment.byteCount > 0 && attachment.byteCount <= maxRelayAttachmentBytes &&
    bytes.byteLength === attachment.byteCount && Number.isSafeInteger(attachment.expiresAt) && attachment.expiresAt > now;
}

function boundedText(value: string, maximumBytes: number): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function safeDownloadName(fileName: string): string {
  const flattened = Array.from(fileName, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "/" || character === "\\" || codePoint <= 31 || codePoint === 127 ? "_" : character;
  }).join("").trim();
  if (flattened === "") {
    return "branch-attachment";
  }
  // The signed manifest still renders its exact name. This only constrains the
  // browser's local save suggestion and has no wire or integrity meaning.
  return Array.from(flattened).slice(0, 160).join("");
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
