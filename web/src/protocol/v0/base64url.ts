const base64URLPattern = /^[A-Za-z0-9_-]+$/;

export function encodeBase64URL(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64URL(value: string): Uint8Array {
  if (!validBase64URL(value)) {
    throw new Error("invalid base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function validBase64URL(value: string): boolean {
  return value.length > 0 && value.length % 4 !== 1 && base64URLPattern.test(value);
}
