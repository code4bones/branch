// This model is intentionally presentation-only. It is not part of a
// ContactSummary, so folder metadata cannot enter connectivity or an export by
// accidentally following a contact record.
export const maxContactFolders = 32;
export const maxContactFolderNameLength = 48;

export interface ContactFolder {
  readonly folderId: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface ContactFolderAssignment {
  readonly contactId: string;
  readonly folderId: string;
}

export function normalizeContactFolderName(value: string): string | null {
  const normalized = value.normalize("NFC").trim();
  return normalized.length >= 1 && normalized.length <= maxContactFolderNameLength ? normalized : null;
}

export function isLocalFolderId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
}

export function isStoredContactFolder(value: unknown): value is ContactFolder {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ContactFolder>;
  return isLocalFolderId(candidate.folderId)
    && typeof candidate.name === "string"
    && normalizeContactFolderName(candidate.name) === candidate.name
    && typeof candidate.createdAt === "number"
    && Number.isSafeInteger(candidate.createdAt)
    && candidate.createdAt >= 0;
}

export function isStoredContactFolderAssignment(value: unknown): value is ContactFolderAssignment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ContactFolderAssignment>;
  return typeof candidate.contactId === "string"
    && candidate.contactId.length > 0
    && candidate.contactId.length <= 128
    && isLocalFolderId(candidate.folderId);
}
