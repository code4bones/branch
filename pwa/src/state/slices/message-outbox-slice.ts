import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { deleteStoredOutbox, maxStoredOutboxEntries, saveStoredOutbox, type StoredOutboxEntry } from "../../storage/message-outbox-store.js";

export interface MessageOutboxSlice {
  readonly outbox: readonly StoredOutboxEntry[];
  readonly hydrateOutbox: (entries: readonly StoredOutboxEntry[]) => void;
  readonly queueMessage: (entry: StoredOutboxEntry) => void;
  readonly markOutboxMessageDelivered: (messageId: string, deliveredAt: number) => void;
  readonly settleOutboxMessage: (messageId: string) => void;
}

export const createMessageOutboxSlice: StateCreator<AppStore, [], [], MessageOutboxSlice> = (set, get) => ({
  outbox: [],
  hydrateOutbox: (entries) => { set({ outbox: entries.slice(-maxStoredOutboxEntries).map(normalizeOutboxEntry) }); },
  queueMessage: (entry) => {
    const evicted: { messageId: string }[] = [];
    set((state) => {
      const next = [...state.outbox.filter((item) => item.messageId !== entry.messageId), entry];
      while (next.length > maxStoredOutboxEntries) {
        const removed = next.shift();
        if (removed !== undefined) evicted.push(removed);
      }
      return { outbox: next };
    });
    void saveStoredOutbox(entry).catch(() => {});
    for (const removed of evicted) void deleteStoredOutbox(removed.messageId).catch(() => {});
  },
  markOutboxMessageDelivered: (messageId, deliveredAt) => {
    const existing = get().outbox.find((entry) => entry.messageId === messageId);
    if (existing === undefined) return;
    const retained: StoredOutboxEntry = { ...existing, deliveredAt };
    set((state) => {
      const next = state.outbox.map((entry) => entry.messageId === messageId ? retained : entry);
      return { outbox: next };
    });
    void saveStoredOutbox(retained).catch(() => {});
  },
  settleOutboxMessage: (messageId) => {
    set((state) => ({ outbox: state.outbox.filter((item) => item.messageId !== messageId) }));
    void deleteStoredOutbox(messageId).catch(() => {});
  }
});

function normalizeOutboxEntry(entry: StoredOutboxEntry): StoredOutboxEntry {
  return { ...entry, deliveredAt: entry.deliveredAt ?? null };
}
