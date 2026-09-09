import { CONTACTS_STORE, openDatabase } from "./database.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";

export async function loadStoredContacts(): Promise<readonly ContactSummary[]> {
  const db = await openDatabase();
  try {
    return await new Promise<readonly ContactSummary[]>((resolve, reject) => {
      const request = db.transaction(CONTACTS_STORE, "readonly").objectStore(CONTACTS_STORE).getAll();
      request.onsuccess = () => { resolve(request.result as ContactSummary[]); };
      request.onerror = () => { reject(request.error ?? new Error("failed to read contacts")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredContact(contact: ContactSummary): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONTACTS_STORE, "readwrite");
      transaction.objectStore(CONTACTS_STORE).put(contact);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write contact")); };
    });
  } finally {
    db.close();
  }
}

export async function deleteStoredContact(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONTACTS_STORE, "readwrite");
      transaction.objectStore(CONTACTS_STORE).delete(contactId);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact")); };
    });
  } finally {
    db.close();
  }
}
