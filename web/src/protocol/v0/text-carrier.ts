export const branchTextWrapperPrefix = "BRANCH0." as const;
export const maxTextCarrierRecordBytes = 64 * 1024;

const base64URLPattern = /^[A-Za-z0-9_-]+$/;
const wrapperPattern = /\bBRANCH0\.([A-Za-z0-9_-]+)(?=$|[\s"'<>),;])/g;
const encoder = new TextEncoder();

export interface BranchTextWrapper {
  readonly wrapper: string;
  readonly offset: number;
}

export function isBranchTextWrapper(value: string): boolean {
  if (!value.startsWith(branchTextWrapperPrefix)) {
    return false;
  }
  const encoded = value.slice(branchTextWrapperPrefix.length);
  return encoded.length > 0 &&
    encoded.length % 4 !== 1 &&
    base64URLPattern.test(encoded) &&
    encoder.encode(value).byteLength <= maxTextCarrierRecordBytes;
}

export function extractBranchTextWrappers(source: string, maxWrappers = 32): readonly BranchTextWrapper[] {
  if (!Number.isInteger(maxWrappers) || maxWrappers <= 0) {
    return [];
  }
  const wrappers: BranchTextWrapper[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(wrapperPattern)) {
    const wrapper = match[0];
    if (!isBranchTextWrapper(wrapper) || seen.has(wrapper)) {
      continue;
    }
    seen.add(wrapper);
    wrappers.push({ wrapper, offset: match.index });
    if (wrappers.length >= maxWrappers) {
      break;
    }
  }
  return wrappers;
}
