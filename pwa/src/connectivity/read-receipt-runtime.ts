import type { SameRelayTransportClient } from "@code4bones/branch-core";

import { sendDeliveryReceipt } from "./delivery-receipt-control.js";
import { getRelaySessionClient, hasAttachedRelaySession } from "./relay-session.js";
import type { AppStoreApi } from "../state/store.js";

const retryDelayMs = 5_000;
const maxReadReceiptsPerRun = 128;

interface ReadReceiptRuntime {
  readonly storeApi: AppStoreApi;
  readonly client: SameRelayTransportClient;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  stopped: boolean;
  running: boolean;
}

let activeRuntime: ReadReceiptRuntime | null = null;

// This runtime is deliberately attachment-driven, never presence-driven. A
// local reader may have viewed a message while the contact was unavailable.
export function startReadReceiptRuntime(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  stopReadReceiptRuntime();
  const runtime: ReadReceiptRuntime = { storeApi, client, timer: null, unsubscribe: null, stopped: false, running: false };
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
    for (const entry of entries) {
      if (getRelaySessionClient() !== runtime.client || !hasAttachedRelaySession()) return;
      const contact = state.contacts.find((candidate) => candidate.contactId === entry.contactId);
      if (contact === undefined || contact.peerId === null || contact.hpkePublicKey === null) {
        // Contact removal clears this record in the same local lifecycle;
        // incomplete route material may later be completed locally. Neither
        // case authorizes a route lookup or any presence-driven action here.
        continue;
      }
      try {
        const result = await sendDeliveryReceipt({
          kind: "read",
          targetDeliveryId: entry.targetDeliveryId,
          senderPeerId: state.identity.peerId,
          recipientPeerId: contact.peerId,
          recipientHpkePublicKey: contact.hpkePublicKey,
          attached: true
        });
        if (result === "sent") {
          state.settleReadReceipt(entry.targetDeliveryId);
          state.recordTransportTrace("delivery receipt: read_sent");
          continue;
        }
        // A syntactically invalid local record or unavailable keys cannot be
        // repaired by a retry. Do not transform it into network traffic.
        state.settleReadReceipt(entry.targetDeliveryId);
        state.recordTransportTrace("delivery receipt: read_skipped");
      } catch {
        state.recordTransportTrace("delivery receipt: read_failed");
        schedule(runtime, retryDelayMs);
        return;
      }
    }
  } finally {
    runtime.running = false;
  }
}
