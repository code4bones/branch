import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { deleteStoredMessageRequest, saveStoredMessageRequest } from "../../storage/message-requests-store.js";

export const maxIncomingMessageRequests = 50;

export interface IncomingMessageRequest {
  readonly requestId: string;
  readonly senderPeerId: string;
  readonly senderHpkePublicKey: string;
  readonly senderDisplayName: string;
  readonly body: string;
  readonly receivedAt: number;
}

export interface MessageRequestsSlice {
  readonly incomingMessageRequests: readonly IncomingMessageRequest[];
  readonly receiveMessageRequest: (request: IncomingMessageRequest) => void;
  readonly acceptMessageRequest: (requestId: string) => string | null;
  readonly dismissMessageRequest: (requestId: string) => void;
  readonly setIncomingMessageRequests: (requests: readonly IncomingMessageRequest[]) => void;
}

export const createMessageRequestsSlice: StateCreator<AppStore, [], [], MessageRequestsSlice> = (set, get) => ({
  incomingMessageRequests: [],
  receiveMessageRequest: (request) => {
    const existing = get().incomingMessageRequests;
    if (existing.some((candidate) => candidate.requestId === request.requestId)) {
      return;
    }
    const next = [...existing, request]
      .sort((left, right) => left.receivedAt - right.receivedAt);
    const evicted = next.length > maxIncomingMessageRequests ? next.shift() : undefined;
    set({ incomingMessageRequests: next });
    void saveStoredMessageRequest(request).catch(() => {
      // Local request history is best-effort when browser storage is blocked.
    });
    if (evicted !== undefined) {
      void deleteStoredMessageRequest(evicted.requestId).catch(() => {
        // The bounded in-memory state remains authoritative for this session.
      });
    }
  },
  acceptMessageRequest: (requestId) => {
    const request = get().incomingMessageRequests.find((candidate) => candidate.requestId === requestId);
    if (request === undefined) {
      return null;
    }
    const existingContact = get().contacts.find((contact) => contact.peerId === request.senderPeerId);
    const contactId = existingContact?.contactId ?? crypto.randomUUID();
    if (existingContact === undefined) {
      get().upsertContact({
        contactId,
        displayName: request.senderDisplayName,
        peerId: request.senderPeerId,
        hpkePublicKey: request.senderHpkePublicKey,
        lastRouteHint: null
      });
    }
    get().appendMessage({
      messageId: request.requestId,
      contactId,
      direction: "incoming",
      body: request.body,
      sentAt: request.receivedAt,
      deliveryState: "received"
    });
    get().dismissMessageRequest(requestId);
    return contactId;
  },
  dismissMessageRequest: (requestId) => {
    set((state) => ({
      incomingMessageRequests: state.incomingMessageRequests.filter((request) => request.requestId !== requestId)
    }));
    void deleteStoredMessageRequest(requestId).catch(() => {
      // The dismissed request stays absent from the active in-memory view.
    });
  },
  setIncomingMessageRequests: (requests) => {
    const unique = new Map<string, IncomingMessageRequest>();
    for (const request of requests) {
      unique.set(request.requestId, request);
    }
    const bounded = Array.from(unique.values())
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .slice(-maxIncomingMessageRequests);
    set({ incomingMessageRequests: bounded });
  }
});
