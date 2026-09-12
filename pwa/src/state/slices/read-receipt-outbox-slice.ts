import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import {
  deleteStoredReadReceipt,
  maxStoredReadReceiptEntries,
  saveStoredReadReceipt,
  type StoredReadReceiptEntry
} from "../../storage/read-receipt-outbox-store.js";

export interface ReadReceiptOutboxSlice {
  readonly readReceiptOutbox: readonly StoredReadReceiptEntry[];
  readonly hydrateReadReceiptOutbox: (entries: readonly StoredReadReceiptEntry[]) => void;
  // Presentation is stored whether or not receipts are enabled. Only an
  // explicit local opt-in creates transport work for the presented message.
  readonly recordIncomingMessagesRead: (contactId: string, targetDeliveryIds: readonly string[], queueReceipts: boolean) => void;
  readonly settleReadReceipt: (targetDeliveryId: string) => void;
}

export const createReadReceiptOutboxSlice: StateCreator<AppStore, [], [], ReadReceiptOutboxSlice> = (set, get) => ({
  readReceiptOutbox: [],
  hydrateReadReceiptOutbox: (entries) => {
    const normalized = entries.slice().sort((left, right) => left.readAt - right.readAt);
    const retained = normalized.slice(-maxStoredReadReceiptEntries);
    const retainedTargets = new Set(retained.map((entry) => entry.targetDeliveryId));
    set({ readReceiptOutbox: retained });
    for (const entry of normalized) {
      if (!retainedTargets.has(entry.targetDeliveryId)) void deleteStoredReadReceipt(entry.targetDeliveryId).catch(() => {});
    }
  },
  recordIncomingMessagesRead: (contactId, targetDeliveryIds, queueReceipts) => {
    const uniqueIds = [...new Set(targetDeliveryIds)];
    if (uniqueIds.length === 0) return;
    const readAt = Date.now();
    const entries = uniqueIds.map((targetDeliveryId) => ({ targetDeliveryId, contactId, readAt, receiptPending: queueReceipts }));
    const newlyRecorded: StoredReadReceiptEntry[] = [];
    const evicted: StoredReadReceiptEntry[] = [];
    set((state) => {
      const replaced = new Map(state.readReceiptOutbox.map((entry) => [entry.targetDeliveryId, entry]));
      for (const entry of entries) {
        // ChatPage's foreground presentation set is intentionally ephemeral.
        // After reload it may present retained history again, but that must
        // never turn an already settled receipt back into outbound work.
        if (replaced.has(entry.targetDeliveryId)) continue;
        replaced.set(entry.targetDeliveryId, entry);
        newlyRecorded.push(entry);
      }
      const next = [...replaced.values()].sort((left, right) => left.readAt - right.readAt);
      while (next.length > maxStoredReadReceiptEntries) {
        const removed = next.shift();
        if (removed !== undefined) evicted.push(removed);
      }
      return { readReceiptOutbox: next };
    });
    for (const entry of newlyRecorded) void saveStoredReadReceipt(entry).catch(() => {});
    for (const entry of evicted) void deleteStoredReadReceipt(entry.targetDeliveryId).catch(() => {});
  },
  settleReadReceipt: (targetDeliveryId) => {
    const existing = get().readReceiptOutbox.find((entry) => entry.targetDeliveryId === targetDeliveryId);
    if (existing === undefined || !existing.receiptPending) return;
    const settled: StoredReadReceiptEntry = { ...existing, receiptPending: false };
    set((state) => ({
      readReceiptOutbox: state.readReceiptOutbox.map((entry) => entry.targetDeliveryId === targetDeliveryId ? settled : entry)
    }));
    void saveStoredReadReceipt(settled).catch(() => {});
  }
});
