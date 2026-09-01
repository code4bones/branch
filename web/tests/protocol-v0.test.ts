import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createBetaBootstrapBeaconWrapper,
  validateBranchTextBootstrapBeacon
} from "../src/protocol/v0/bootstrap-beacon.js";
import { cborMap, decodeDeterministicCbor, encodeDeterministicCbor, readCborMap, sameBytes, type CborEntry } from "../src/protocol/v0/cbor.js";
import { decodeDraftEnvelopeText, protocolID, ProtocolError } from "../src/protocol/v0/envelope.js";
import { draftProfileMultihash, profileHashAlgorithm } from "../src/protocol/v0/profile.js";
import { decodeBase64URL, encodeBase64URL } from "../src/protocol/v0/base64url.js";
import { branchTextWrapperPrefix } from "../src/protocol/v0/text-carrier.js";

interface VectorManifest {
  readonly schema: "branch.testvectors/0";
  readonly protocol: typeof protocolID;
  readonly status: "draft";
  readonly profile: VectorProfile;
  readonly transcripts: VectorTranscripts;
  readonly bootstrap_beacon: BootstrapBeaconVectorsRef;
  readonly cases: readonly VectorCase[];
}

interface VectorProfile {
  readonly kind: "draft_profile_json";
  readonly fixture: string;
  readonly hash_algorithm: typeof profileHashAlgorithm;
  readonly development_multihash: string;
}

interface VectorCase {
  readonly name: string;
  readonly kind: "draft_envelope_json";
  readonly fixture: string;
  readonly expect: "accept-structure" | "reject-structure";
}

interface VectorTranscripts {
  readonly fixture: string;
  readonly required_kinds: readonly TranscriptKind[];
  readonly independent_implementation_status: "not-yet-demonstrated";
}

interface BootstrapBeaconVectorsRef {
  readonly fixture: string;
  readonly required_invalid_reasons: readonly string[];
}

interface BootstrapBeaconVectors {
  readonly schema: "branch.bootstrap-beacon-vectors/0";
  readonly protocol: typeof protocolID;
  readonly valid: {
    readonly name: string;
    readonly now: number;
    readonly wrapper: string;
    readonly reason: string;
  };
  readonly invalid: readonly {
    readonly name: string;
    readonly expect: "reject";
    readonly reason: string;
  }[];
}

type TranscriptKind =
  | "negotiation_transcript"
  | "relay_attachment_transcript"
  | "delivery_dedup_transcript"
  | "path_migration_transcript"
  | "relay_restart_transcript";

interface TranscriptBundle {
  readonly schema: "branch.conformance.transcripts/0";
  readonly protocol: typeof protocolID;
  readonly profile_multihash: string;
  readonly cases: readonly TranscriptCase[];
  readonly independent_implementation_requirement: {
    readonly status: "not-yet-demonstrated";
    readonly reason: string;
  };
}

interface TranscriptCase {
  readonly name: string;
  readonly kind: TranscriptKind;
  readonly expect: "accept" | "reject";
  readonly selected_error: string | null;
  readonly restores_user_traffic_after_restart?: boolean;
  readonly steps: readonly string[];
}

const thisDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(thisDir, "..", "..", "..", "testdata", "vectors", "protocol-v0");

void test("draft envelope vectors pass shared conformance checks", async (t) => {
  const manifest = await readManifest();

  assert.equal(manifest.schema, "branch.testvectors/0");
  assert.equal(manifest.protocol, protocolID);
  assert.equal(manifest.status, "draft");
  assert.equal(manifest.profile.kind, "draft_profile_json");
  assert.equal(manifest.profile.hash_algorithm, profileHashAlgorithm);
  assert.equal(manifest.transcripts.independent_implementation_status, "not-yet-demonstrated");
  assert.notEqual(manifest.cases.length, 0);

  const profileBytes = await readFile(join(vectorsDir, manifest.profile.fixture));
  assert.equal(
    await draftProfileMultihash(profileBytes),
    manifest.profile.development_multihash
  );
  await assertTranscriptCoverage(manifest);
  await assertBootstrapBeaconVectorCoverage(manifest);

  for (const vectorCase of manifest.cases) {
    await t.test(vectorCase.name, async () => {
      assert.equal(vectorCase.kind, "draft_envelope_json");
      const text = await readFile(join(vectorsDir, vectorCase.fixture), "utf8");

      if (vectorCase.expect === "accept-structure") {
        assert.doesNotThrow(() => decodeDraftEnvelopeText(text));
        return;
      }

      assert.throws(() => decodeDraftEnvelopeText(text), ProtocolError);
    });
  }
});

void test("BRANCH0 bootstrap.beacon wrapper validates exact signed CBOR", async () => {
  const now = 1_789_000_000;
  const wrapper = await createBetaBootstrapBeaconWrapper({
    now,
    expiresAt: now + 3600,
    sequence: 7,
    capabilities: ["search.direct-browser/0", "visual.ribbon-seal/0"]
  });
  const result = await validateBranchTextBootstrapBeacon(wrapper, { now });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, "accepted");
  if (result.beacon === undefined) {
    throw new Error("accepted beacon missing");
  }
  const beacon = result.beacon;
  assert.equal(beacon.envelope.protocol, protocolID);
  assert.equal(beacon.envelope.type, "bootstrap.beacon");
  assert.equal(beacon.envelope.payloadMode, "public");
  assert.equal(beacon.payload.sequence, 7);
  assert.equal(beacon.payload.expiresAt, now + 3600);
  assert.deepEqual(beacon.payload.searchMarkers, ["BRANCH0", protocolID, "branch-bootstrap-v0"]);
});

void test("BRANCH0 bootstrap.beacon validator rejects malformed and stale records with stable reasons", async () => {
  const now = 1_789_000_000;
  const valid = await createBetaBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const signedBytes = decodeBase64URL(valid.slice(branchTextWrapperPrefix.length));
  const mutatedSignature = patchSignatureByte(valid);
  const nonCanonical = new Uint8Array(signedBytes.byteLength + 1);
  nonCanonical[0] = 0xb8;
  nonCanonical[1] = 0x0a;
  nonCanonical.set(signedBytes.slice(1), 2);

  assert.equal((await validateBranchTextBootstrapBeacon("BRANCH0.invalid=", { now })).reason, "malformed_wrapper");
  assert.equal((await validateBranchTextBootstrapBeacon(`${branchTextWrapperPrefix}${encodeBase64URL(nonCanonical)}`, { now })).reason, "non_canonical_cbor");
  assert.equal((await validateBranchTextBootstrapBeacon(`${branchTextWrapperPrefix}${encodeBase64URL(mutatedSignature)}`, { now })).reason, "signature_invalid");
  assert.equal((await validateBranchTextBootstrapBeacon(valid, { now: now + 7200 })).reason, "expired");
  assert.equal((await validateBranchTextBootstrapBeacon(await createBetaBootstrapBeaconWrapper({ now: now + 3600, expiresAt: now + 7200 }), { now })).reason, "created_in_future");
});

void test("BRANCH0 bootstrap.beacon validator rejects signed wrong payload mode and payload expiry mismatch", async () => {
  const now = 1_789_000_000;
  const valid = await createBetaBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const wrongMode = await resignWrapperWithPatch(valid, (entries) => entries.map((entry) =>
    entry.key === "payload_mode" ? { key: entry.key, value: "sealed" } : entry
  ));
  const expiryMismatch = await resignWrapperWithPatch(valid, (entries) => entries.map((entry) =>
    entry.key === "payload" ? { key: entry.key, value: patchPayloadExpiry(entry.value, now + 7200) } : entry
  ));

  assert.equal((await validateBranchTextBootstrapBeacon(wrongMode, { now })).reason, "invalid_payload_mode");
  assert.equal((await validateBranchTextBootstrapBeacon(expiryMismatch, { now })).reason, "payload_expiry_mismatch");
});

async function readManifest(): Promise<VectorManifest> {
  const text = await readFile(join(vectorsDir, "manifest.json"), "utf8");
  const manifest: unknown = JSON.parse(text);

  if (!isManifest(manifest)) {
    throw new Error("invalid vector manifest");
  }

  return manifest;
}

async function assertBootstrapBeaconVectorCoverage(manifest: VectorManifest): Promise<void> {
  const text = await readFile(join(vectorsDir, manifest.bootstrap_beacon.fixture), "utf8");
  const vectors: unknown = JSON.parse(text);

  if (!isBootstrapBeaconVectors(vectors)) {
    throw new Error("invalid bootstrap beacon vectors");
  }

  const valid = await validateBranchTextBootstrapBeacon(vectors.valid.wrapper, { now: vectors.valid.now });
  assert.equal(valid.reason, vectors.valid.reason);
  assert.equal(valid.accepted, true);

  const reasons = new Set(vectors.invalid.map((testCase) => testCase.reason));
  for (const reason of manifest.bootstrap_beacon.required_invalid_reasons) {
    assert.equal(reasons.has(reason), true, `missing bootstrap invalid reason ${reason}`);
  }
}

async function assertTranscriptCoverage(manifest: VectorManifest): Promise<void> {
  const text = await readFile(join(vectorsDir, manifest.transcripts.fixture), "utf8");
  const bundle: unknown = JSON.parse(text);

  if (!isTranscriptBundle(bundle)) {
    throw new Error("invalid transcript bundle");
  }

  assert.equal(bundle.protocol, protocolID);
  assert.equal(bundle.profile_multihash, manifest.profile.development_multihash);
  assert.equal(
    bundle.independent_implementation_requirement.status,
    manifest.transcripts.independent_implementation_status
  );

  const seen = new Set(bundle.cases.map((testCase) => testCase.kind));
  for (const requiredKind of manifest.transcripts.required_kinds) {
    assert.equal(seen.has(requiredKind), true, `missing transcript kind ${requiredKind}`);
  }

  for (const testCase of bundle.cases) {
    assert.notEqual(testCase.name, "");
    assert.notEqual(testCase.steps.length, 0);
    if (testCase.expect === "reject") {
      assert.notEqual(testCase.selected_error, null);
    }
    if (testCase.kind === "relay_restart_transcript") {
      assert.equal(testCase.restores_user_traffic_after_restart, false);
    }
  }
}

function isManifest(value: unknown): value is VectorManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly schema?: unknown;
    readonly protocol?: unknown;
    readonly status?: unknown;
    readonly profile?: unknown;
    readonly transcripts?: unknown;
    readonly bootstrap_beacon?: unknown;
    readonly cases?: unknown;
  };

  return (
    candidate.schema === "branch.testvectors/0" &&
    candidate.protocol === protocolID &&
    candidate.status === "draft" &&
    isVectorProfile(candidate.profile) &&
    isVectorTranscripts(candidate.transcripts) &&
    isBootstrapBeaconVectorsRef(candidate.bootstrap_beacon) &&
    Array.isArray(candidate.cases) &&
    candidate.cases.every(isVectorCase)
  );
}

function isVectorProfile(value: unknown): value is VectorProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly kind?: unknown;
    readonly fixture?: unknown;
    readonly hash_algorithm?: unknown;
    readonly development_multihash?: unknown;
  };

  return (
    candidate.kind === "draft_profile_json" &&
    typeof candidate.fixture === "string" &&
    candidate.hash_algorithm === profileHashAlgorithm &&
    typeof candidate.development_multihash === "string"
  );
}

function isVectorTranscripts(value: unknown): value is VectorTranscripts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly fixture?: unknown;
    readonly required_kinds?: unknown;
    readonly independent_implementation_status?: unknown;
  };

  return (
    typeof candidate.fixture === "string" &&
    Array.isArray(candidate.required_kinds) &&
    candidate.required_kinds.every(isTranscriptKind) &&
    candidate.independent_implementation_status === "not-yet-demonstrated"
  );
}

function isBootstrapBeaconVectorsRef(value: unknown): value is BootstrapBeaconVectorsRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly fixture?: unknown;
    readonly required_invalid_reasons?: unknown;
  };

  return (
    typeof candidate.fixture === "string" &&
    Array.isArray(candidate.required_invalid_reasons) &&
    candidate.required_invalid_reasons.every((reason) => typeof reason === "string")
  );
}

function isBootstrapBeaconVectors(value: unknown): value is BootstrapBeaconVectors {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly schema?: unknown;
    readonly protocol?: unknown;
    readonly valid?: unknown;
    readonly invalid?: unknown;
  };

  return (
    candidate.schema === "branch.bootstrap-beacon-vectors/0" &&
    candidate.protocol === protocolID &&
    isBootstrapBeaconValidVector(candidate.valid) &&
    Array.isArray(candidate.invalid) &&
    candidate.invalid.every(isBootstrapBeaconInvalidVector)
  );
}

function isBootstrapBeaconValidVector(value: unknown): value is BootstrapBeaconVectors["valid"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly now?: unknown;
    readonly wrapper?: unknown;
    readonly reason?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    typeof candidate.now === "number" &&
    typeof candidate.wrapper === "string" &&
    typeof candidate.reason === "string"
  );
}

function isBootstrapBeaconInvalidVector(value: unknown): value is BootstrapBeaconVectors["invalid"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly expect?: unknown;
    readonly reason?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    candidate.expect === "reject" &&
    typeof candidate.reason === "string"
  );
}

function isTranscriptBundle(value: unknown): value is TranscriptBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly schema?: unknown;
    readonly protocol?: unknown;
    readonly profile_multihash?: unknown;
    readonly cases?: unknown;
    readonly independent_implementation_requirement?: unknown;
  };

  return (
    candidate.schema === "branch.conformance.transcripts/0" &&
    candidate.protocol === protocolID &&
    typeof candidate.profile_multihash === "string" &&
    Array.isArray(candidate.cases) &&
    candidate.cases.every(isTranscriptCase) &&
    isIndependentImplementationRequirement(candidate.independent_implementation_requirement)
  );
}

function isTranscriptCase(value: unknown): value is TranscriptCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly kind?: unknown;
    readonly expect?: unknown;
    readonly selected_error?: unknown;
    readonly restores_user_traffic_after_restart?: unknown;
    readonly steps?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    isTranscriptKind(candidate.kind) &&
    (candidate.expect === "accept" || candidate.expect === "reject") &&
    (typeof candidate.selected_error === "string" || candidate.selected_error === null) &&
    (candidate.restores_user_traffic_after_restart === undefined ||
      typeof candidate.restores_user_traffic_after_restart === "boolean") &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every((step) => typeof step === "string")
  );
}

function isTranscriptKind(value: unknown): value is TranscriptKind {
  return (
    value === "negotiation_transcript" ||
    value === "relay_attachment_transcript" ||
    value === "delivery_dedup_transcript" ||
    value === "path_migration_transcript" ||
    value === "relay_restart_transcript"
  );
}

async function resignWrapperWithPatch(
  wrapper: string,
  patch: (entries: readonly CborEntry[]) => readonly CborEntry[]
): Promise<string> {
  const existingBytes = decodeBase64URL(wrapper.slice(branchTextWrapperPrefix.length));
  const existingMap = readCborMap(decodeDeterministicCbor(existingBytes), "signed_event");
  const unsignedEntries = patch(existingMap.entries.filter((entry) => entry.key !== "signature"));
  const generated = await globalThis.crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  assert("privateKey" in generated && "publicKey" in generated);
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", generated.publicKey));
  const patchedEntries = unsignedEntries.map((entry) =>
    entry.key === "sender"
      ? { key: "sender", value: cborMap([{ key: "key_alg", value: "ed25519" }, { key: "public_key", value: publicKey }]) }
      : entry
  );
  const unsignedBytes = encodeDeterministicCbor(cborMap(patchedEntries));
  const signatureInput = concatBytes([new TextEncoder().encode("BRANCH signed event v0\n"), unsignedBytes]);
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", generated.privateKey, toArrayBuffer(signatureInput)));
  const signedBytes = encodeDeterministicCbor(cborMap([...patchedEntries, { key: "signature", value: signature }]));
  assert(!sameBytes(existingBytes, signedBytes));
  return `${branchTextWrapperPrefix}${encodeBase64URL(signedBytes)}`;
}

function patchPayloadExpiry(value: unknown, expiresAt: number): Uint8Array {
  assert(value instanceof Uint8Array);
  const payloadMap = readCborMap(decodeDeterministicCbor(value), "payload");
  const entries = payloadMap.entries.map((entry) =>
    entry.key === "expires_at" ? { key: entry.key, value: expiresAt } : entry
  );
  return encodeDeterministicCbor(cborMap(entries));
}

function patchSignatureByte(wrapper: string): Uint8Array {
  const signedBytes = decodeBase64URL(wrapper.slice(branchTextWrapperPrefix.length));
  const signedMap = readCborMap(decodeDeterministicCbor(signedBytes), "signed_event");
  const entries = signedMap.entries.map((entry) => {
    if (entry.key !== "signature") {
      return entry;
    }
    assert(entry.value instanceof Uint8Array);
    const signature = entry.value.slice();
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    return { key: entry.key, value: signature };
  });
  return encodeDeterministicCbor(cborMap(entries));
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isIndependentImplementationRequirement(
  value: unknown
): value is TranscriptBundle["independent_implementation_requirement"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly status?: unknown;
    readonly reason?: unknown;
  };

  return (
    candidate.status === "not-yet-demonstrated" &&
    typeof candidate.reason === "string"
  );
}

function isVectorCase(value: unknown): value is VectorCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly kind?: unknown;
    readonly fixture?: unknown;
    readonly expect?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    candidate.kind === "draft_envelope_json" &&
    typeof candidate.fixture === "string" &&
    (candidate.expect === "accept-structure" || candidate.expect === "reject-structure")
  );
}
