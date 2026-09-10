import { CONTACT_FOLDER_ASSIGNMENTS_STORE, CONTACT_FOLDERS_STORE, openDatabase } from "./database.js";
import {
  isStoredContactFolder,
  isStoredContactFolderAssignment,
  type ContactFolder,
  type ContactFolderAssignment
} from "../state/contact-folders-model.js";

export interface StoredContactFolderState {
  readonly folders: readonly ContactFolder[];
  readonly assignments: readonly ContactFolderAssignment[];
}

export async function loadStoredContactFolders(): Promise<StoredContactFolderState> {
  const db = await openDatabase();
  try {
    return await new Promise<StoredContactFolderState>((resolve, reject) => {
      const transaction = db.transaction([CONTACT_FOLDERS_STORE, CONTACT_FOLDER_ASSIGNMENTS_STORE], "readonly");
      const folders = transaction.objectStore(CONTACT_FOLDERS_STORE).getAll();
      const assignments = transaction.objectStore(CONTACT_FOLDER_ASSIGNMENTS_STORE).getAll();
      transaction.oncomplete = () => {
        resolve({
          folders: (folders.result as unknown[]).filter(isStoredContactFolder),
          assignments: (assignments.result as unknown[]).filter(isStoredContactFolderAssignment)
        });
      };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to read contact folders")); };
    });
  } finally {
    db.close();
  }
}

export async function saveStoredContactFolder(folder: ContactFolder): Promise<void> {
  await writeFolderRecord(CONTACT_FOLDERS_STORE, folder);
}

export async function saveStoredContactFolderAssignment(assignment: ContactFolderAssignment): Promise<void> {
  await writeFolderRecord(CONTACT_FOLDER_ASSIGNMENTS_STORE, assignment);
}

export async function deleteStoredContactFolderAssignment(contactId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONTACT_FOLDER_ASSIGNMENTS_STORE, "readwrite");
      transaction.objectStore(CONTACT_FOLDER_ASSIGNMENTS_STORE).delete(contactId);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact folder assignment")); };
    });
  } finally {
    db.close();
  }
}

// Folder deletion intentionally removes only local membership. Contacts and
// their conversation records are owned by their separate local stores.
export async function deleteStoredContactFolder(folderId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([CONTACT_FOLDERS_STORE, CONTACT_FOLDER_ASSIGNMENTS_STORE], "readwrite");
      transaction.objectStore(CONTACT_FOLDERS_STORE).delete(folderId);
      const assignments = transaction.objectStore(CONTACT_FOLDER_ASSIGNMENTS_STORE).index("byFolderId");
      const cursor = assignments.openCursor(IDBKeyRange.only(folderId));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current !== null) {
          current.delete();
          current.continue();
        }
      };
      cursor.onerror = () => { reject(cursor.error ?? new Error("failed to delete contact folder assignments")); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to delete contact folder")); };
    });
  } finally {
    db.close();
  }
}

async function writeFolderRecord(storeName: string, record: ContactFolder | ContactFolderAssignment): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("failed to write contact folder record")); };
    });
  } finally {
    db.close();
  }
}
