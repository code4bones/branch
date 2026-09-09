export function formatChatListTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
