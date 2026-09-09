import { Avatar } from "antd";

const PALETTE: readonly string[] = ["#57d2c6", "#64a8ff", "#d9b662", "#eb7770", "#9b7bd6", "#7bd6a3"];
const FALLBACK_COLOR = "#57d2c6";

export function ChatAvatar({ name, size = 40 }: { readonly name: string; readonly size?: number }): React.JSX.Element {
  return (
    <Avatar size={size} style={{ backgroundColor: colorForName(name), color: "#0a0d11", fontWeight: 700, flexShrink: 0 }}>
      {initialsForName(name)}
    </Avatar>
  );
}

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  const first = parts[0]?.[0] ?? "?";
  const second = parts[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}

function colorForName(name: string): string {
  return PALETTE[hashCode(name) % PALETTE.length] ?? FALLBACK_COLOR;
}

function hashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
