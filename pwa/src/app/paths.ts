export const ONBOARDING_PATH = "/onboarding";
export const DISCOVERY_PATH = "/discovery";
export const CHATS_PATH = "/chats";
export const SETTINGS_PATH = "/settings";
export const MESSAGE_REQUESTS_PATH = "/requests";

export function chatPath(contactId: string): string {
  return `${CHATS_PATH}/${contactId}`;
}
