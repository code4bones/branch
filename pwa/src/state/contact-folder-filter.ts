// The folder selector is a local presentation filter. It deliberately accepts
// only an already built chat-list projection and has no storage or transport
// dependency.
export function filterChatListByFolder<T extends { readonly contact: { readonly contactId: string } }>(
  entries: readonly T[],
  folderId: string | null,
  folderIdByContactId: Readonly<Record<string, string>>
): readonly T[] {
  return folderId === null
    ? entries
    : entries.filter((entry) => folderIdByContactId[entry.contact.contactId] === folderId);
}
