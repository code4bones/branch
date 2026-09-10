import type { SameRelayTransportClient } from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import type { AppStoreApi } from "../state/store.js";
import { ContactDiscoveryScheduler } from "./contact-discovery-scheduler.js";
import { getRelaySessionClient } from "./relay-session.js";

const retryEveryMs = 60_000;
const maxLookupsPerSessionMinute = 4;

let scheduler: ContactDiscoveryScheduler | null = null;
let unsubscribe: (() => void) | null = null;
let lookupTimes: number[] = [];
const pendingRequests = new Map<string, { readonly branchId: string; readonly expiresAt: number }>();

// This owns the sole document timer for BranchID lookup. It has no worker,
// persistence queue, hidden-tab bypass, or relay fallback: close/detach ends
// it, and a relay restart knows nothing about it.
export function startContactDiscoveryRuntime(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  stopContactDiscoveryRuntime();
  unsubscribe = storeApi.subscribe((state, previous) => {
    if (getRelaySessionClient() !== client) return;
    if (state.allowContactDiscovery !== previous.allowContactDiscovery) {
      announcePolicy(storeApi, client);
      setAvailability(storeApi, client);
      if (state.allowContactDiscovery && client.supportsContactDiscovery) {
        startScheduler(storeApi, client);
      } else {
        scheduler?.stop();
        scheduler = null;
      }
      return;
    }
    if (state.contactDiscoveries !== previous.contactDiscoveries) scheduler?.wake();
  });
  setAvailability(storeApi, client);
  announcePolicy(storeApi, client);
  startScheduler(storeApi, client);
}

export function stopContactDiscoveryRuntime(): void {
  unsubscribe?.();
  unsubscribe = null;
  scheduler?.stop();
  scheduler = null;
  lookupTimes = [];
  pendingRequests.clear();
}

function setAvailability(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  const state = storeApi.getState();
  if (!client.supportsContactDiscovery) {
    state.setContactDiscoveryAvailability("unsupported");
    state.recordTransportTrace("contact discovery: extension unavailable on attached relay");
    return;
  }
  if (!state.allowContactDiscovery) {
    state.setContactDiscoveryAvailability("disabled");
    state.recordTransportTrace("contact discovery: disabled locally");
    return;
  }
  state.setContactDiscoveryAvailability("ready");
  state.recordTransportTrace("contact discovery: ready");
}

function announcePolicy(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  if (!client.supportsContactDiscovery) return;
  try { client.announceContactDiscovery(storeApi.getState().allowContactDiscovery); } catch { /* live session owns reconnect */ }
}

function startScheduler(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  if (scheduler !== null || !storeApi.getState().allowContactDiscovery || !client.supportsContactDiscovery) return;
  const next = new ContactDiscoveryScheduler();
  scheduler = next;
  next.start({
    now: Date.now,
    nextDelay: () => nextDiscoveryDelay(storeApi, client),
    attempt: () => Promise.resolve().then(() => { attemptDiscovery(storeApi, client); })
  });
}

function attemptDiscovery(storeApi: AppStoreApi, client: SameRelayTransportClient): void {
  if (getRelaySessionClient() !== client || !client.supportsContactDiscovery) return;
  const state = storeApi.getState();
  if (!state.allowContactDiscovery || state.identity === null) return;
  const keys = getLocalIdentityKeys();
  if (keys === null) return;
  const now = Date.now();
  lookupTimes = lookupTimes.filter((at) => now - at < retryEveryMs);
  if (lookupTimes.length >= maxLookupsPerSessionMinute) return;
  const row = state.contactDiscoveries.find((candidate) => candidate.displayName === null && isEligible(candidate, now));
  if (row === undefined) return;
  let request: { readonly requestId: string; readonly expiresAt: number };
  try {
    request = client.lookupContact(row.branchId, state.identity.hpkePublicKey);
  } catch {
    // A local validation or socket failure is not a remote negative result.
    // Keep the row eligible and expose only a bounded diagnostic label.
    state.recordTransportTrace("contact discovery: lookup not sent");
    return;
  }
  pendingRequests.set(request.requestId, { branchId: row.branchId, expiresAt: request.expiresAt });
  lookupTimes.push(now);
  state.checkedContactDiscovery(row.branchId, now);
}

export function consumePendingContactDiscovery(requestId: string, branchId: string, now: number = Date.now()): boolean {
  for (const [candidate, value] of pendingRequests) if (value.expiresAt <= now) pendingRequests.delete(candidate);
  const pending = pendingRequests.get(requestId);
  if (pending === undefined || pending.branchId !== branchId || pending.expiresAt <= now) return false;
  pendingRequests.delete(requestId);
  return true;
}

function nextDiscoveryDelay(storeApi: AppStoreApi, client: SameRelayTransportClient): number | null {
  if (getRelaySessionClient() !== client || !client.supportsContactDiscovery || !storeApi.getState().allowContactDiscovery) return null;
  const now = Date.now();
  lookupTimes = lookupTimes.filter((at) => now - at < retryEveryMs);
  const unresolved = storeApi.getState().contactDiscoveries.filter((row) => row.displayName === null);
  if (unresolved.length === 0) return null;
  if (lookupTimes.length >= maxLookupsPerSessionMinute) {
    const oldest = lookupTimes[0];
    return oldest === undefined ? 0 : Math.max(0, oldest + retryEveryMs - now);
  }
  return Math.min(...unresolved.map((row) => nextEligibleAt(row) - now).map((delay) => Math.max(0, delay)));
}

function isEligible(row: { readonly lastCheckedAt: number | null; readonly retryRequestedAt: number }, now: number): boolean {
  return now >= nextEligibleAt(row);
}

function nextEligibleAt(row: { readonly lastCheckedAt: number | null; readonly retryRequestedAt: number }): number {
  if (row.lastCheckedAt === null || row.retryRequestedAt > row.lastCheckedAt) return row.retryRequestedAt;
  return row.lastCheckedAt + retryEveryMs;
}
