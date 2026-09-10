import type { SameRelayTransportClient } from "@code4bones/branch-core";

import { getRelaySessionClient, hasAttachedRelaySession } from "./relay-session.js";
import { createDeliveryID, sendPresencePing } from "./seal-and-send.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";
import type { AppStoreApi } from "../state/store.js";

export const presenceRenewIntervalMs = 20_000;
export const presencePingTimeoutMs = 8_000;
// Three ordinary renewal opportunities fit inside this local projection. A
// single delayed or lost best-effort control must not make a recently proven
// live contact visibly flap to unknown.
export const presenceAvailableTtlMs = 60_000;

// One local runtime owns the only timer and sends at most one probe after the
// preceding sealing/send attempt settles. The scan and cadence are bounded so
// a large local contact list cannot become a relay polling queue.
const backgroundProbeBatchGapMs = 1_000;
const backgroundIdleDelayMs = 1_000;
const maxContactsExaminedPerCycle = 64;
const maxBackgroundProbesPerCycle = 4;

interface PresenceRuntime {
  readonly storeApi: AppStoreApi;
  readonly client: SameRelayTransportClient;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  cursor: number;
  stopped: boolean;
}

let activeRuntime: PresenceRuntime | null = null;

// Starts only for the currently attached live relay session. It is a
// best-effort foreground PWA timer, not a Service Worker, background sync,
// store-and-forward worker, or a source of relay-side state.
export function startContactPresenceRuntime(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  stopContactPresenceRuntime();
  const runtime: PresenceRuntime = { storeApi, client, timer: null, unsubscribe: null, cursor: 0, stopped: false };
  activeRuntime = runtime;
  runtime.unsubscribe = storeApi.subscribe((state, previous) => {
    if (state.contacts !== previous.contacts || state.identity !== previous.identity || state.attachStatus !== previous.attachStatus) {
      schedule(runtime, 0);
    }
  });
  schedule(runtime, 0);
}

export function stopContactPresenceRuntime(): void {
  const runtime = activeRuntime;
  activeRuntime = null;
  if (runtime === null) return;
  runtime.stopped = true;
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime.unsubscribe?.();
  runtime.unsubscribe = null;
}

// The manual button and the background runtime use exactly this one E2EE
// probe path. A failed attempt only clears local checking state; it never
// creates a negative relay or offline claim and is never queued for retry.
export async function probeContactPresence(storeApi: AppStoreApi, contactId: string): Promise<"sent" | "unavailable"> {
  const state = storeApi.getState();
  const contact = state.contacts.find((candidate) => candidate.contactId === contactId);
  const identity = state.identity;
  if (contact === undefined || identity === null || contact.peerId === null || contact.hpkePublicKey === null || !hasAttachedRelaySession()) {
    return "unavailable";
  }
  const pingId = createDeliveryID();
  state.beginContactPresencePing(contact.contactId, pingId);
  try {
    await sendPresencePing({
      senderPeerId: identity.peerId,
      recipientPeerId: contact.peerId,
      recipientHpkePublicKey: contact.hpkePublicKey,
      pingId
    });
    return "sent";
  } catch {
    // The ping has no relay queue or delivery claim. Retain lastProbeAt for
    // local rate limiting but immediately stop displaying checking state.
    storeApi.getState().expireContactPresencePing(contact.contactId, pingId);
    return "unavailable";
  }
}

function schedule(runtime: PresenceRuntime, delayMs: number): void {
  if (runtime.stopped) return;
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void run(runtime);
  }, Math.max(0, delayMs));
}

async function run(runtime: PresenceRuntime): Promise<void> {
  if (runtime.stopped || activeRuntime !== runtime || getRelaySessionClient() !== runtime.client) return;
  const now = Date.now();
  expireStalePresence(runtime.storeApi, now);
  const state = runtime.storeApi.getState();
  if (state.identity === null || state.attachStatus !== "attached") return;
  if (state.contacts.length === 0) return;
  const contacts = nextEligibleContacts(state.contacts, state.contactPresenceById, runtime, now);
  if (contacts.length > 0) {
    // Bounded parallelism makes the initial contact-list projection prompt,
    // while awaiting the whole batch preserves one non-overlapping timer
    // lifecycle and avoids an accumulating timer/request backlog.
    await Promise.all(contacts.map(async (contact) => probeContactPresence(runtime.storeApi, contact.contactId)));
    schedule(runtime, backgroundProbeBatchGapMs);
    return;
  }
  schedule(runtime, backgroundIdleDelayMs);
}

function nextEligibleContacts(
  contacts: readonly ContactSummary[],
  presenceById: Readonly<Record<string, { readonly lastProbeAt: number | null; readonly pendingPingId: string | null }>>,
  runtime: PresenceRuntime,
  now: number
): readonly ContactSummary[] {
  if (contacts.length === 0) return [];
  const examined = Math.min(contacts.length, maxContactsExaminedPerCycle);
  const selected: ContactSummary[] = [];
  for (let offset = 0; offset < examined; offset += 1) {
    const index = (runtime.cursor + offset) % contacts.length;
    const contact = contacts[index];
    if (contact === undefined) continue;
    if (contact.peerId === null || contact.hpkePublicKey === null) continue;
    const presence = presenceById[contact.contactId];
    if (presence?.pendingPingId !== null && presence?.pendingPingId !== undefined) continue;
    if (presence?.lastProbeAt !== null && presence?.lastProbeAt !== undefined && now - presence.lastProbeAt < presenceRenewIntervalMs) continue;
    selected.push(contact);
    if (selected.length === maxBackgroundProbesPerCycle) {
      runtime.cursor = (index + 1) % contacts.length;
      return selected;
    }
  }
  runtime.cursor = (runtime.cursor + examined) % contacts.length;
  return selected;
}

function expireStalePresence(storeApi: AppStoreApi, now: number): void {
  const state = storeApi.getState();
  for (const [contactId, presence] of Object.entries(state.contactPresenceById)) {
    if (presence.pendingPingId !== null && presence.lastProbeAt !== null && now - presence.lastProbeAt >= presencePingTimeoutMs) {
      state.expireContactPresencePing(contactId, presence.pendingPingId);
    }
    if (presence.status === "available" && now - presence.updatedAt >= presenceAvailableTtlMs) {
      state.expireContactPresence(contactId, presence.updatedAt);
    }
  }
}
