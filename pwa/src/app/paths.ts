export const ONBOARDING_PATH = "/onboarding";
export const DISCOVERY_PATH = "/discovery";
export const CHATS_PATH = "/chats";
export const SETTINGS_PATH = "/settings";
export const ECHO_PATH = "/echo";
export const MESSAGE_REQUESTS_PATH = "/requests";

// Reserved conversations-slice contactId for the pinned Echo entry (D-BRANCH-040
// self-addressed relay loopback). Not a real ContactSummary — Echo has no
// peerId/hpkePublicKey of its own to store, so it never goes through
// contacts-slice/IndexedDB contact persistence, only the message log under
// this id.
export const ECHO_CONTACT_ID = "echo";

export function chatPath(contactId: string): string {
  return `${CHATS_PATH}/${contactId}`;
}
