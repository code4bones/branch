import { branchTextWrapperPrefix, isBranchTextWrapper } from "../protocol/v0/text-carrier.js";

export const dnsTxtBootstrapPrefix = "branchbootstrapv0=" as const;
export const dnsTxtOwnerLabel = "branch-bootstrap" as const;
export const dnsTxtRecommendedTTLSeconds = 300 as const;
export const dnsTxtMaxCharacterStrings = 8 as const;
export const dnsTxtMaxCharacterStringOctets = 255 as const;
export const dnsTxtMaxCandidateOctets = 2040 as const;

const encoder = new TextEncoder();
const domainLabelPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

export type DnsTxtBootstrapRejectionReason =
  | "empty_record"
  | "too_many_strings"
  | "string_too_large"
  | "non_ascii"
  | "record_too_large"
  | "wrong_prefix"
  | "malformed_wrapper"
  | "duplicate";

export interface DnsTxtBootstrapPublication {
  readonly ownerName: string;
  readonly ttlSeconds: typeof dnsTxtRecommendedTTLSeconds;
  readonly strings: readonly string[];
  readonly value: string;
  readonly zoneFileRecord: string;
}

export interface DnsTxtBootstrapCandidate {
  readonly wrapper: string;
  readonly rrIndex: number;
  readonly strings: readonly string[];
}

export interface DnsTxtBootstrapRejection {
  readonly rrIndex: number;
  readonly reason: DnsTxtBootstrapRejectionReason;
}

export interface DnsTxtBootstrapParseResult {
  readonly candidates: readonly DnsTxtBootstrapCandidate[];
  readonly rejections: readonly DnsTxtBootstrapRejection[];
}

// createDnsTxtBootstrapPublication turns one exact signed wrapper into the DNS
// application representation. It does not validate signatures or expiry; those
// checks stay in the existing protocol validation boundary.
export function createDnsTxtBootstrapPublication(domain: string, wrapper: string): DnsTxtBootstrapPublication {
  if (!isBranchTextWrapper(wrapper)) {
    throw new Error("DNS TXT publication requires an exact bounded BRANCH0 wrapper");
  }
  const ownerName = dnsTxtOwnerName(domain);
  const value = dnsTxtBootstrapPrefix + wrapper;
  const strings = splitDnsCharacterStrings(value);
  return {
    ownerName,
    ttlSeconds: dnsTxtRecommendedTTLSeconds,
    strings,
    value,
    zoneFileRecord: `${ownerName}. ${String(dnsTxtRecommendedTTLSeconds)} IN TXT ${formatDnsCharacterStrings(strings)}`
  };
}

// dnsTxtOwnerName derives the fixed owner-name profile from an explicit
// operator-owned ASCII domain. Unicode domains must be supplied as A-labels.
export function dnsTxtOwnerName(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized.length === 0 || encoder.encode(normalized).byteLength > 253) {
    throw new Error("DNS TXT domain is invalid");
  }
  const labels = normalized.split(".");
  if (labels.some((label) => !domainLabelPattern.test(label))) {
    throw new Error("DNS TXT domain is invalid");
  }
  const ownerName = `${dnsTxtOwnerLabel}.${normalized}`;
  if (encoder.encode(ownerName).byteLength > 253) {
    throw new Error("DNS TXT owner name is too large");
  }
  return ownerName;
}

// parseDnsTxtBootstrapRecords consumes raw TXT character-string arrays from one
// DNS RRset. RR order is untrusted, while string order within one RR is wire
// order and must remain unchanged.
export function parseDnsTxtBootstrapRecords(records: readonly (readonly string[])[]): DnsTxtBootstrapParseResult {
  const candidates: DnsTxtBootstrapCandidate[] = [];
  const rejections: DnsTxtBootstrapRejection[] = [];
  const seen = new Set<string>();

  for (const [rrIndex, strings] of records.entries()) {
    const decoded = decodeDnsTxtRecord(strings);
    if ("reason" in decoded) {
      rejections.push({ rrIndex, reason: decoded.reason });
      continue;
    }
    if (!decoded.value.startsWith(dnsTxtBootstrapPrefix)) {
      rejections.push({ rrIndex, reason: "wrong_prefix" });
      continue;
    }
    const wrapper = decoded.value.slice(dnsTxtBootstrapPrefix.length);
    if (!wrapper.startsWith(branchTextWrapperPrefix) || !isBranchTextWrapper(wrapper)) {
      rejections.push({ rrIndex, reason: "malformed_wrapper" });
      continue;
    }
    if (seen.has(wrapper)) {
      rejections.push({ rrIndex, reason: "duplicate" });
      continue;
    }
    seen.add(wrapper);
    candidates.push({ wrapper, rrIndex, strings: [...strings] });
  }
  return { candidates, rejections };
}

// formatDnsCharacterStrings creates provider-neutral RFC-style zone text for
// already bounded application strings. It is an output convenience, not a DNS
// parser and never becomes protocol input.
export function formatDnsCharacterStrings(strings: readonly string[]): string {
  const decoded = decodeDnsTxtRecord(strings);
  if ("reason" in decoded) {
    throw new Error(`invalid DNS TXT strings: ${decoded.reason}`);
  }
  return strings.map((part) => `"${escapeZoneString(part)}"`).join(" ");
}

function splitDnsCharacterStrings(value: string): readonly string[] {
  if (!isASCII(value)) {
    throw new Error("DNS TXT application value must be ASCII");
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength > dnsTxtMaxCandidateOctets) {
    throw new Error("DNS TXT application value is too large");
  }
  const strings: string[] = [];
  for (let offset = 0; offset < value.length; offset += dnsTxtMaxCharacterStringOctets) {
    strings.push(value.slice(offset, offset + dnsTxtMaxCharacterStringOctets));
  }
  if (strings.length === 0 || strings.length > dnsTxtMaxCharacterStrings) {
    throw new Error("DNS TXT application value has too many strings");
  }
  return strings;
}

function decodeDnsTxtRecord(strings: readonly string[]): { readonly value: string } | { readonly reason: DnsTxtBootstrapRejectionReason } {
  if (strings.length === 0) {
    return { reason: "empty_record" };
  }
  if (strings.length > dnsTxtMaxCharacterStrings) {
    return { reason: "too_many_strings" };
  }
  let total = 0;
  for (const part of strings) {
    const size = encoder.encode(part).byteLength;
    if (size > dnsTxtMaxCharacterStringOctets) {
      return { reason: "string_too_large" };
    }
    if (!isASCII(part)) {
      return { reason: "non_ascii" };
    }
    total += size;
    if (total > dnsTxtMaxCandidateOctets) {
      return { reason: "record_too_large" };
    }
  }
  return { value: strings.join("") };
}

function escapeZoneString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function isASCII(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x20 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}
