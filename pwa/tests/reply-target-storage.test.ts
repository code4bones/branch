import assert from "node:assert/strict";
import { test } from "node:test";

import { loadStoredTimelineEntryByApplicationMessageId } from "../src/storage/messages-store.js";

const presentationMessageId = "local-presentation-message";
const applicationMessageId = "authenticated-application-message";

void test("an evicted text reply target is read locally by application identity, not presentation identity", async () => {
  const storedRecord = {
    messageId: presentationMessageId,
    applicationMessageId,
    contactId: "contact-1",
    sentAt: 42,
    kind: "text",
    message: {
      messageId: presentationMessageId,
      applicationMessageId,
      contactId: "contact-1",
      direction: "incoming" as const,
      body: "local original outside the render window",
      sentAt: 42,
      deliveryState: "received" as const
    }
  };
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let requestedIndex: string | null = null;
  let requestedKey: IDBValidKey | null = null;

  const requestFor = <T>(result: T): IDBRequest<T> => {
    const request = {} as IDBRequest<T>;
    queueMicrotask(() => {
      Object.defineProperty(request, "result", { configurable: true, value: result });
      request.onsuccess?.call(request, new Event("success"));
    });
    return request;
  };
  const fakeDatabase = {
    close: () => {},
    transaction: () => ({
      objectStore: () => ({
        index: (name: string) => ({
          get: (key: IDBValidKey) => {
            requestedIndex = name;
            requestedKey = key;
            return requestFor(key === applicationMessageId ? storedRecord : undefined);
          }
        })
      })
    })
  } as unknown as IDBDatabase;
  const fakeIndexedDb = {
    open: () => requestFor(fakeDatabase)
  } as unknown as IDBFactory;

  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
  try {
    const entry = await loadStoredTimelineEntryByApplicationMessageId(applicationMessageId);
    assert.equal(requestedIndex, "byApplicationMessageId");
    assert.equal(requestedKey, applicationMessageId);
    assert.deepEqual(entry, {
      kind: "text",
      messageId: presentationMessageId,
      sentAt: 42,
      message: storedRecord.message
    });
  } finally {
    if (originalIndexedDb === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    else Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
  }
});
