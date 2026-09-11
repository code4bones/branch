import type { SameRelayTransportClient } from "@code4bones/branch-core";

import { peerSupportsChatText, sendApplicationCapabilities } from "./application-capabilities-control.js";
import { abandonCurrentPendingEnvelope, clearDelivery, getRelaySessionClient, hasAttachedRelaySession } from "./relay-session.js";
import { createDeliveryID, sealAndSendApplicationTextMessage } from "./seal-and-send.js";
import type { StoredOutboxEntry } from "../storage/message-outbox-store.js";
import { saveStoredMessageDeliveryTarget } from "../storage/message-delivery-target-store.js";
import type { AppStoreApi } from "../state/store.js";

// This is an endpoint-owned foreground retry loop, not a relay queue or a
// background-sync worker. One attempt is made at a time and each attempt gets
// a fresh live delivery id while retaining the application id for endpoint
// deduplication.
export const outboxRetryInitialDelayMs = 10_000;
export const outboxRetryMaximumDelayMs = 60_000;
export const outboxUnavailableRetryDelayMs = 5_000;
export const outboxMaximumAgeMs = 7 * 24 * 60 * 60 * 1_000;
const outboxIdleDelayMs = 60_000;
const maxOutboxEntriesExaminedPerRun = 128;
const maxPausedDrainContacts = 128;

interface OutboxRuntime {
  readonly storeApi: AppStoreApi;
  readonly client: SameRelayTransportClient;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  stopped: boolean;
  running: boolean;
  activeDeliveryId: string | null;
  activeContactId: string | null;
  preferredContactId: string | null;
  readonly pausedUntilByContactId: Map<string, number>;
  readonly awaitingReceiptRetryAtByMessageId: Map<string, number>;
}

let activeRuntime: OutboxRuntime | null = null;

// Start this only after a successful foreground attachment. Replacing an
// attachment cancels its timer; IndexedDB retains the entries for a later
// foreground attachment, but no work is performed while detached or hidden.
export function startMessageOutboxRuntime(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  stopMessageOutboxRuntime();
  const runtime: OutboxRuntime = {
    storeApi,
    client,
    timer: null,
    unsubscribe: null,
    stopped: false,
    running: false,
    activeDeliveryId: null,
    activeContactId: null,
    preferredContactId: null,
    pausedUntilByContactId: new Map(),
    awaitingReceiptRetryAtByMessageId: new Map()
  };
  activeRuntime = runtime;
  runtime.unsubscribe = storeApi.subscribe((state, previous) => {
    if (
      state.outbox !== previous.outbox ||
      state.contacts !== previous.contacts ||
      state.identity !== previous.identity ||
      state.attachStatus !== previous.attachStatus ||
      state.contactPresenceById !== previous.contactPresenceById ||
      state.messagesByContactId !== previous.messagesByContactId
    ) {
      schedule(runtime, 0);
    }
  });
  document.addEventListener("visibilitychange", runtimeVisibilityChange);
  schedule(runtime, 0);
}

export function stopMessageOutboxRuntime(): void {
  const runtime = activeRuntime;
  activeRuntime = null;
  if (runtime === null) return;
  runtime.stopped = true;
  runtime.activeDeliveryId = null;
  runtime.activeContactId = null;
  runtime.preferredContactId = null;
  runtime.pausedUntilByContactId.clear();
  runtime.awaitingReceiptRetryAtByMessageId.clear();
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime.unsubscribe?.();
  runtime.unsubscribe = null;
  document.removeEventListener("visibilitychange", runtimeVisibilityChange);
}

// relay.forwarded is only a local pacing signal. It cannot settle the outbox
// entry, but it tells this tab that the one live slot in its current drain was
// released and the next message for this same contact may be attempted.
export function advanceMessageOutboxDrainAfterRelayForwarded(deliveryId: string): void {
  const runtime = activeRuntime;
  if (runtime === null || runtime.stopped || runtime.activeDeliveryId !== deliveryId) return;
  const activeEntry = runtime.storeApi.getState().outbox.find((entry) => entry.lastDeliveryId === deliveryId);
  if (activeEntry !== undefined) {
    rememberAwaitingReceiptRetry(runtime, activeEntry.messageId, activeEntry.nextAttemptAt);
  }
  runtime.preferredContactId = runtime.activeContactId;
  runtime.activeDeliveryId = null;
  runtime.activeContactId = null;
  schedule(runtime, 0);
}

// A matching pong is stronger and newer live evidence than an unanswered
// envelope from before the peer reappeared. Release only that tab-volatile
// attempt and let the normal one-at-a-time drain create fresh ciphertext now;
// the durable outbox entry is retained throughout.
export function restartMessageOutboxDrainAfterPresencePong(contactId: string): void {
  const runtime = activeRuntime;
  if (
    runtime === null || runtime.stopped || document.visibilityState !== "visible" ||
    runtime.activeDeliveryId === null || runtime.activeContactId !== contactId
  ) return;
  const deliveryId = runtime.activeDeliveryId;
  const entry = runtime.storeApi.getState().outbox.find((candidate) => candidate.lastDeliveryId === deliveryId);
  if (entry !== undefined) {
    runtime.storeApi.getState().queueMessage({ ...entry, nextAttemptAt: Date.now() });
  }
  clearDelivery(deliveryId);
  abandonCurrentPendingEnvelope(deliveryId);
  runtime.activeDeliveryId = null;
  runtime.activeContactId = null;
  runtime.preferredContactId = contactId;
  runtime.pausedUntilByContactId.delete(contactId);
  schedule(runtime, 0);
}

// A matching encrypted pong proves only that this endpoint is live; it does
// not prove support for an optional application kind. When a local queued text
// needs that missing current capability, make one existing signed capability
// announcement. The peer's signed reply remains the sole admission evidence
// for the later text retry.
export function renewQueuedTextCapabilityAfterPresencePong(storeApi: AppStoreApi, contactId: string): void {
  if (document.visibilityState !== "visible" || !hasAttachedRelaySession()) return;
  const state = storeApi.getState();
  if (state.identity === null || state.attachStatus !== "attached") return;
  const contact = state.contacts.find((candidate) => candidate.contactId === contactId);
  if (contact === undefined || contact.peerId === null || contact.hpkePublicKey === null) return;
  if (!needsQueuedTextCapabilityRenewal(state.outbox, contactId, contact.peerId)) return;
  void sendApplicationCapabilities({
    senderPeerId: state.identity.peerId,
    recipientPeerId: contact.peerId,
    recipientHpkePublicKey: contact.hpkePublicKey,
    attached: true
  }).then((result) => {
    storeApi.getState().recordTransportTrace(`outbox: capability_renew_${result}`);
  }).catch(() => {
    // This is one existing best-effort live control. The bounded outbox keeps
    // waiting; a later encrypted pong may make another rate-limited attempt.
    storeApi.getState().recordTransportTrace("outbox: capability_renew_failed");
  });
}

export function needsQueuedTextCapabilityRenewal(
  entries: readonly StoredOutboxEntry[],
  contactId: string,
  peerId: string,
  now: number = Date.now()
): boolean {
  return entries.some((entry) => entry.contactId === contactId) && !peerSupportsChatText(peerId, now);
}

function runtimeVisibilityChange(): void {
  const runtime = activeRuntime;
  if (runtime === null || runtime.stopped) return;
  if (document.visibilityState === "visible") schedule(runtime, 0);
}

function schedule(runtime: OutboxRuntime, delayMs: number): void {
  if (runtime.stopped || activeRuntime !== runtime) return;
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void run(runtime);
  }, Math.max(0, delayMs));
}

async function run(runtime: OutboxRuntime): Promise<void> {
  if (
    runtime.stopped || activeRuntime !== runtime || runtime.running || runtime.activeDeliveryId !== null ||
    document.visibilityState !== "visible" || getRelaySessionClient() !== runtime.client || !hasAttachedRelaySession()
  ) {
    return;
  }
  runtime.running = true;
  try {
    const now = Date.now();
    const state = runtime.storeApi.getState();
    if (state.identity === null || state.attachStatus !== "attached") return;

    const entries = state.outbox
      .slice()
      .sort(compareOutboxEntryOrder)
      .slice(0, maxOutboxEntriesExaminedPerRun);
    pruneAwaitingReceiptRetries(runtime, entries);
    const expiredDeliveredEntries = entries.filter((entry) => (
      entry.deliveredAt !== null && now - entry.createdAt >= outboxMaximumAgeMs
    ));
    if (expiredDeliveredEntries.length > 0) {
      for (const entry of expiredDeliveredEntries) state.settleOutboxMessage(entry.messageId);
      schedule(runtime, 0);
      return;
    }
    const due = nextEligibleEntry(entries, runtime, now);
    if (due === undefined) {
      schedule(runtime, nextWakeDelay(entries, runtime, now));
      return;
    }

    const contact = state.contacts.find((candidate) => candidate.contactId === due.contactId);
    const message = state.messagesByContactId[due.contactId]?.find((candidate) => candidate.messageId === due.messageId);
    if (contact === undefined || message === undefined || message.direction !== "outgoing") {
      // The conversation/contact was locally removed after this entry was
      // written. Do not retain an orphaned plaintext retry record.
      state.settleOutboxMessage(due.messageId);
      schedule(runtime, 0);
      return;
    }
    if (now - due.createdAt >= outboxMaximumAgeMs) {
      state.setMessageDeliveryState(due.contactId, due.messageId, "unavailable");
      state.settleOutboxMessage(due.messageId);
      state.recordTransportTrace("outbox: expired");
      schedule(runtime, 0);
      return;
    }
    if (contact.peerId === null || contact.hpkePublicKey === null) {
      defer(runtime, due, now, outboxUnavailableRetryDelayMs);
      return;
    }
    if (state.contactPresenceById[contact.contactId]?.status !== "available" || !peerSupportsChatText(contact.peerId, now)) {
      // A relay ACK is not peer presence. Wait for an encrypted pong/live
      // traffic and a fresh capability advertisement before retrying.
      defer(runtime, due, now, outboxUnavailableRetryDelayMs);
      return;
    }

    const deliveryId = createDeliveryID();
    const next: StoredOutboxEntry = {
      ...due,
      attempts: due.attempts + 1,
      lastDeliveryId: deliveryId,
      nextAttemptAt: now + outboxRetryDelay(due.attempts + 1)
    };
    state.queueMessage(next);
    // This is the sole active live envelope in this foreground drain. It is
    // cleared only by relay.forwarded or a terminal local failure, never by a
    // loop that pumps additional messages into SameRelay.pending.
    runtime.activeDeliveryId = deliveryId;
    runtime.activeContactId = due.contactId;
    try {
      // Persist this outer-id association before handing ciphertext to the
      // live transport. A later signed Read must survive outbox settlement
      // and a page reload in order to update the local bubble truthfully.
      await saveStoredMessageDeliveryTarget({
        messageId: due.messageId,
        contactId: due.contactId,
        deliveryId,
        createdAt: due.createdAt
      });
      await sealAndSendApplicationTextMessage({
        senderPeerId: state.identity.peerId,
        recipientPeerId: contact.peerId,
        recipientHpkePublicKey: contact.hpkePublicKey,
        contactId: contact.contactId,
        messageId: due.messageId,
        deliveryId,
        applicationMessageId: due.applicationMessageId,
        plaintext: message.body,
        ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
        onRelayOutcomeTimeout: () => {
          runtime.storeApi.getState().setMessageDeliveryState(due.contactId, due.messageId, "unavailable");
          stopActiveDrain(runtime, deliveryId, due.contactId, due.messageId, outboxRetryDelay(next.attempts));
        }
      });
      runtime.storeApi.getState().recordTransportTrace("outbox: retry_sent");
    } catch {
      // The next attempt was persisted before sealing so a reload, route
      // change, or local failure cannot turn this into a hidden live queue.
      runtime.storeApi.getState().setMessageDeliveryState(due.contactId, due.messageId, "unavailable");
      runtime.storeApi.getState().recordTransportTrace("outbox: retry_failed");
      stopActiveDrain(runtime, deliveryId, due.contactId, due.messageId, outboxRetryDelay(next.attempts));
    }
  } finally {
    runtime.running = false;
  }
}

function stopActiveDrain(runtime: OutboxRuntime, deliveryId: string, contactId: string, messageId: string, retryDelayMs: number): void {
  if (runtime.stopped || activeRuntime !== runtime || runtime.activeDeliveryId !== deliveryId) return;
  const retryAt = Date.now() + retryDelayMs;
  const entry = runtime.storeApi.getState().outbox.find((candidate) => candidate.messageId === messageId);
  if (entry !== undefined) {
    runtime.storeApi.getState().queueMessage({ ...entry, nextAttemptAt: Math.max(entry.nextAttemptAt, retryAt) });
  }
  runtime.activeDeliveryId = null;
  runtime.activeContactId = null;
  runtime.preferredContactId = null;
  pauseContactDrain(runtime, contactId, retryAt);
  schedule(runtime, Math.max(0, retryAt - Date.now()));
}

function defer(runtime: OutboxRuntime, entry: StoredOutboxEntry, now: number, delayMs: number): void {
  const nextAttemptAt = Math.max(entry.nextAttemptAt, now + delayMs);
  if (nextAttemptAt !== entry.nextAttemptAt) {
    runtime.storeApi.getState().queueMessage({ ...entry, nextAttemptAt });
  }
  schedule(runtime, Math.max(0, nextAttemptAt - now));
}

function nextEligibleEntry(entries: readonly StoredOutboxEntry[], runtime: OutboxRuntime, now: number): StoredOutboxEntry | undefined {
  const temporarilyAdvancedMessageIds = advancedOutboxMessageIds(entries, runtime, now);
  // nextAttemptAt is mutable retry bookkeeping. It must never let a newer
  // composition overtake the oldest non-advanced entry for one contact.
  const eligible = contactOutboxHeads(entries, temporarilyAdvancedMessageIds).filter((entry) => (
    entry.nextAttemptAt <= now &&
    !isContactDrainPaused(runtime, entry.contactId, now) &&
    !isAwaitingReceiptRetry(runtime, entry.messageId, now)
  ));
  if (runtime.preferredContactId !== null) {
    const preferred = eligible.find((entry) => entry.contactId === runtime.preferredContactId);
    if (preferred !== undefined) return preferred;
    runtime.preferredContactId = null;
  }
  return eligible[0];
}

function nextWakeDelay(entries: readonly StoredOutboxEntry[], runtime: OutboxRuntime, now: number): number {
  let nextAttemptAt: number | null = null;
  const temporarilyAdvancedMessageIds = advancedOutboxMessageIds(entries, runtime, now);
  for (const entry of contactOutboxHeads(entries, temporarilyAdvancedMessageIds)) {
    const pausedUntil = runtime.pausedUntilByContactId.get(entry.contactId) ?? 0;
    const receiptRetryAt = runtime.awaitingReceiptRetryAtByMessageId.get(entry.messageId) ?? 0;
    const eligibleAt = Math.max(entry.nextAttemptAt, pausedUntil, receiptRetryAt);
    if (nextAttemptAt === null || eligibleAt < nextAttemptAt) nextAttemptAt = eligibleAt;
  }
  // An entry already advanced by relay.forwarded stays in the durable outbox
  // pending an endpoint receipt. It must still wake the scheduler at its
  // bounded retry time if no receipt arrives, even though it no longer blocks
  // the next composition in this live ACK-gated drain.
  for (const entry of entries) {
    if (!temporarilyAdvancedMessageIds.has(entry.messageId)) continue;
    const retryAt = entry.deliveredAt === null
      ? runtime.awaitingReceiptRetryAtByMessageId.get(entry.messageId) ?? entry.nextAttemptAt
      : entry.createdAt + outboxMaximumAgeMs;
    if (nextAttemptAt === null || retryAt < nextAttemptAt) nextAttemptAt = retryAt;
  }
  return nextAttemptAt === null ? outboxIdleDelayMs : Math.max(0, nextAttemptAt - now);
}

function advancedOutboxMessageIds(entries: readonly StoredOutboxEntry[], runtime: OutboxRuntime, now: number): ReadonlySet<string> {
  return new Set(entries.filter((entry) => (
    entry.deliveredAt !== null || isAwaitingReceiptRetry(runtime, entry.messageId, now)
  )).map((entry) => entry.messageId));
}

// Returns the oldest currently unadvanced entry for every contact. Entries
// named in temporarilyAdvancedMessageIds have already received the active
// relay.forwarded ACK during this foreground session, so D-BRANCH-072 allows
// the next composition to start while the older entry waits for a real peer
// receipt. Without that ACK, the oldest entry is strict head-of-line.
export function contactOutboxHeads(
  entries: readonly StoredOutboxEntry[],
  temporarilyAdvancedMessageIds: ReadonlySet<string> = new Set()
): readonly StoredOutboxEntry[] {
  const headsByContactId = new Map<string, StoredOutboxEntry>();
  for (const entry of [...entries].sort(compareOutboxEntryOrder)) {
    if (temporarilyAdvancedMessageIds.has(entry.messageId) || headsByContactId.has(entry.contactId)) continue;
    headsByContactId.set(entry.contactId, entry);
  }
  return [...headsByContactId.values()].sort(compareOutboxEntryOrder);
}

function compareOutboxEntryOrder(left: StoredOutboxEntry, right: StoredOutboxEntry): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
}

function isContactDrainPaused(runtime: OutboxRuntime, contactId: string, now: number): boolean {
  const pausedUntil = runtime.pausedUntilByContactId.get(contactId);
  if (pausedUntil === undefined) return false;
  if (pausedUntil > now) return true;
  runtime.pausedUntilByContactId.delete(contactId);
  return false;
}

function pauseContactDrain(runtime: OutboxRuntime, contactId: string, retryAt: number): void {
  if (!runtime.pausedUntilByContactId.has(contactId) && runtime.pausedUntilByContactId.size >= maxPausedDrainContacts) {
    const oldestContactId = runtime.pausedUntilByContactId.keys().next().value;
    if (typeof oldestContactId === "string") runtime.pausedUntilByContactId.delete(oldestContactId);
  }
  runtime.pausedUntilByContactId.set(contactId, retryAt);
}

function isAwaitingReceiptRetry(runtime: OutboxRuntime, messageId: string, now: number): boolean {
  const retryAt = runtime.awaitingReceiptRetryAtByMessageId.get(messageId);
  if (retryAt === undefined) return false;
  if (retryAt > now) return true;
  runtime.awaitingReceiptRetryAtByMessageId.delete(messageId);
  return false;
}

function rememberAwaitingReceiptRetry(runtime: OutboxRuntime, messageId: string, retryAt: number): void {
  if (!runtime.awaitingReceiptRetryAtByMessageId.has(messageId) && runtime.awaitingReceiptRetryAtByMessageId.size >= maxOutboxEntriesExaminedPerRun) {
    const oldestMessageId = runtime.awaitingReceiptRetryAtByMessageId.keys().next().value;
    if (typeof oldestMessageId === "string") runtime.awaitingReceiptRetryAtByMessageId.delete(oldestMessageId);
  }
  runtime.awaitingReceiptRetryAtByMessageId.set(messageId, retryAt);
}

function pruneAwaitingReceiptRetries(runtime: OutboxRuntime, entries: readonly StoredOutboxEntry[]): void {
  const queuedMessageIds = new Set(entries.map((entry) => entry.messageId));
  for (const messageId of runtime.awaitingReceiptRetryAtByMessageId.keys()) {
    if (!queuedMessageIds.has(messageId)) runtime.awaitingReceiptRetryAtByMessageId.delete(messageId);
  }
}

export function outboxRetryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 6);
  return Math.min(outboxRetryMaximumDelayMs, outboxRetryInitialDelayMs * 2 ** exponent);
}
