import type { SameRelayTransportClient } from "@code4bones/branch-core";

import { deliveryReceiptControlTTLms, sendDeliveryReceipt } from "./delivery-receipt-control.js";
import { getRelaySessionClient, hasAttachedRelaySession } from "./relay-session.js";
import type { AppStoreApi } from "../state/store.js";

const readReceiptRetryDelayMs = 30_000;
const maxReadReceiptsPerRun = 128;

interface ReadReceiptRuntime {
  readonly storeApi: AppStoreApi;
  readonly client: SameRelayTransportClient;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  stopped: boolean;
  running: boolean;
  readonly retryAtByTarget: Map<string, number>;
}

let activeRuntime: ReadReceiptRuntime | null = null;

// This runtime is deliberately attachment-driven, never presence-driven. A
// local reader may have viewed a message while the contact was unavailable.
export function startReadReceiptRuntime(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  stopReadReceiptRuntime();
  const runtime: ReadReceiptRuntime = {
    storeApi,
    client,
    timer: null,
    unsubscribe: null,
    stopped: false,
    running: false,
    retryAtByTarget: new Map()
  };
  activeRuntime = runtime;
  runtime.unsubscribe = storeApi.subscribe((state, previous) => {
    if (
      state.readReceiptOutbox !== previous.readReceiptOutbox ||
      state.contacts !== previous.contacts ||
      state.identity !== previous.identity ||
      state.attachStatus !== previous.attachStatus
    ) schedule(runtime, 0);
  });
  schedule(runtime, 0);
}

export function stopReadReceiptRuntime(): void {
  const runtime = activeRuntime;
  activeRuntime = null;
  if (runtime === null) return;
  runtime.stopped = true;
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime.unsubscribe?.();
  runtime.unsubscribe = null;
}

function schedule(runtime: ReadReceiptRuntime, delayMs: number): void {
  if (runtime.stopped || activeRuntime !== runtime) return;
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void run(runtime);
  }, Math.max(0, delayMs));
}

async function run(runtime: ReadReceiptRuntime): Promise<void> {
  if (
    runtime.stopped || activeRuntime !== runtime || runtime.running ||
    getRelaySessionClient() !== runtime.client || !hasAttachedRelaySession()
  ) return;
  runtime.running = true;
  try {
    const state = runtime.storeApi.getState();
    if (state.identity === null || state.attachStatus !== "attached") return;
    const entries = state.readReceiptOutbox
      .filter((entry) => entry.receiptPending)
      .sort((left, right) => left.readAt - right.readAt)
      .slice(0, maxReadReceiptsPerRun);
    const pendingTargets = new Set(entries.map((entry) => entry.targetDeliveryId));
    for (const targetDeliveryId of runtime.retryAtByTarget.keys()) {
      if (!pendingTargets.has(targetDeliveryId)) runtime.retryAtByTarget.delete(targetDeliveryId);
    }
    let nextAttemptAt: number | null = null;
    for (const entry of entries) {
      if (getRelaySessionClient() !== runtime.client || !hasAttachedRelaySession()) return;
      const now = Date.now();
      const expiresAt = entry.readAt + deliveryReceiptControlTTLms;
      if (now >= expiresAt) {
        // A local queue age limit bounds duplicate signed controls.  This is
        // cleanup only: the sender UI stays Delivered without a signed Read.
        runtime.retryAtByTarget.delete(entry.targetDeliveryId);
        state.settleReadReceipt(entry.targetDeliveryId);
        state.recordTransportTrace("delivery receipt: read_expired");
        continue;
      }
      const retryAt = runtime.retryAtByTarget.get(entry.targetDeliveryId);
      if (retryAt !== undefined && retryAt > now) {
        nextAttemptAt = earliest(nextAttemptAt, retryAt);
        continue;
      }
      const contact = state.contacts.find((candidate) => candidate.contactId === entry.contactId);
      if (contact === undefined || contact.peerId === null || contact.hpkePublicKey === null) {
        // Contact removal clears this record in the same local lifecycle;
        // incomplete route material may later be completed locally. Neither
        // case authorizes a route lookup or any presence-driven action here.
        const next = nextRetryAt(now, expiresAt);
        runtime.retryAtByTarget.set(entry.targetDeliveryId, next);
        nextAttemptAt = earliest(nextAttemptAt, next);
        continue;
      }
      try {
        const result = await sendDeliveryReceipt({
          kind: "read",
          targetDeliveryId: entry.targetDeliveryId,
          senderPeerId: state.identity.peerId,
          recipientPeerId: contact.peerId,
          recipientHpkePublicKey: contact.hpkePublicKey,
          attached: true,
        });
        if (result === "sent") {
          // A successful hand-off has consumed this local work item. Retrying
          // it with a fresh signed control makes a healthy recipient see an
          // otherwise-valid duplicate after it has already consumed the
          // delivery mapping, which is indistinguishable from an unmatched
          // receipt. Failures below remain bounded retries because the send
          // routine releases its local dedup key before it throws.
          runtime.retryAtByTarget.delete(entry.targetDeliveryId);
          state.settleReadReceipt(entry.targetDeliveryId);
          state.recordTransportTrace("delivery receipt: read_attempt_sent");
          continue;
        }
        // A syntactically invalid local record or unavailable keys cannot be
        // repaired by a retry. Do not transform it into network traffic.
        runtime.retryAtByTarget.delete(entry.targetDeliveryId);
        state.settleReadReceipt(entry.targetDeliveryId);
        state.recordTransportTrace("delivery receipt: read_skipped");
      } catch (cause) {
        const next = nextRetryAt(Date.now(), expiresAt);
        runtime.retryAtByTarget.set(entry.targetDeliveryId, next);
        state.recordTransportTrace(`delivery receipt: read_failed_${readReceiptFailure(cause)}`);
        nextAttemptAt = earliest(nextAttemptAt, next);
      }
    }
    if (nextAttemptAt !== null) schedule(runtime, Math.max(0, nextAttemptAt - Date.now()));
  } finally {
    runtime.running = false;
  }
}

function nextRetryAt(now: number, expiresAt: number): number {
  return Math.min(expiresAt, now + readReceiptRetryDelayMs);
}

function earliest(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

function readReceiptFailure(cause: unknown): "relay_not_attached" | "invalid_local" | "crypto" | "send" {
  if (cause instanceof Error && cause.message === "relay session is not attached") return "relay_not_attached";
  if (cause instanceof Error && /invalid|protocol|frame/iu.test(cause.message)) return "invalid_local";
  if (cause instanceof DOMException && /operation|key|crypto/iu.test(cause.name)) return "crypto";
  return "send";
}
