import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createBootstrapBeaconWrapper,
  defaultBootstrapProfileMultihashes,
  validateBranchTextBootstrapBeacon
} from "../src/protocol/v0/bootstrap-beacon.js";
import { cborMap, decodeDeterministicCbor, encodeDeterministicCbor, readCborMap, sameBytes, type CborEntry } from "../src/protocol/v0/cbor.js";
import { decodeDraftEnvelopeText, protocolID, ProtocolError } from "../src/protocol/v0/envelope.js";
import { draftProfileMultihash, profileHashAlgorithm } from "../src/protocol/v0/profile.js";
import { decodeDraftRelayAttachmentFrameText, relayAttachmentSchema, relayProofDomain, RelayAttachmentError } from "../src/protocol/v0/relay-attachment.js";
import { decodeBase64URL, encodeBase64URL } from "../src/protocol/v0/base64url.js";
import { branchTextWrapperPrefix } from "../src/protocol/v0/text-carrier.js";

interface VectorManifest {
  readonly schema: "branch.testvectors/0";
  readonly protocol: typeof protocolID;
  readonly status: "draft";
  readonly profile: VectorProfile;
  readonly transcripts: VectorTranscripts;
  readonly bootstrap_beacon: BootstrapBeaconVectorsRef;
  readonly relay_attachment: RelayAttachmentVectorsRef;
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

interface RelayAttachmentVectorsRef {
  readonly fixture: string;
  readonly frame_schema: typeof relayAttachmentSchema;
  readonly required_frame_types: readonly RelayFrameType[];
  readonly required_invalid_reasons: readonly string[];
}

interface RelayAttachmentVectors {
  readonly schema: "branch.relay-attachment-vectors/0";
  readonly protocol: typeof protocolID;
  readonly profile_multihash: string;
  readonly frame_schema: typeof relayAttachmentSchema;
  readonly proof_domain: typeof relayProofDomain;
  readonly valid: readonly RelayAttachmentVectorCase[];
  readonly invalid: readonly RelayAttachmentVectorCase[];
}

interface RelayAttachmentVectorCase {
  readonly name: string;
  readonly expect: "accept" | "reject";
  readonly reason?: string;
  readonly frame: unknown;
}

type RelayFrameType =
  | "HELLO"
  | "CHALLENGE"
  | "AUTH"
  | "READY"
  | "PRESENCE"
  | "HEARTBEAT"
  | "LOOKUP"
  | "RENDEZVOUS"
  | "ENVELOPE"
  | "ACK"
  | "ERROR";

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
  await assertRelayAttachmentVectorCoverage(manifest);

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
  const wrapper = await createBootstrapBeaconWrapper({
    now,
    expiresAt: now + 3600,
    sequence: 7,
    relayCapabilities: ["route.relay.wss/0", "relay.forward.live/0"],
    relayEndpoints: [
      { transport: "wss", uri: "wss://relay-two.example:443/relay/v0", priority: 10 },
      { transport: "wss", uri: "wss://relay.example:443/relay/v0", priority: 0 }
    ]
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
  assert.deepEqual(beacon.payload.protocolVersions, [protocolID]);
  assert.deepEqual(beacon.payload.profileMultihashes, defaultBootstrapProfileMultihashes);
  assert.deepEqual(beacon.payload.relayCapabilities, ["relay.forward.live/0", "route.relay.wss/0"]);
  assert.deepEqual(beacon.payload.relayEndpoints, [
    { transport: "wss", uri: "wss://relay.example:443/relay/v0", priority: 0 },
    { transport: "wss", uri: "wss://relay-two.example:443/relay/v0", priority: 10 }
  ]);
});

void test("BRANCH0 bootstrap.beacon validator rejects malformed and stale records with stable reasons", async () => {
  const now = 1_789_000_000;
  const valid = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
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
  assert.equal((await validateBranchTextBootstrapBeacon(await createBootstrapBeaconWrapper({ now: now + 3600, expiresAt: now + 7200 }), { now })).reason, "created_in_future");
});

void test("BRANCH0 bootstrap.beacon validator rejects signed wrong payload mode and payload expiry mismatch", async () => {
  const now = 1_789_000_000;
  const valid = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const wrongMode = await resignWrapperWithPatch(valid, (entries) => entries.map((entry) =>
    entry.key === "payload_mode" ? { key: entry.key, value: "sealed" } : entry
  ));
  const expiryMismatch = await resignWrapperWithPatch(valid, (entries) => entries.map((entry) =>
    entry.key === "payload" ? { key: entry.key, value: patchPayloadExpiry(entry.value, now + 7200) } : entry
  ));

  assert.equal((await validateBranchTextBootstrapBeacon(wrongMode, { now })).reason, "invalid_payload_mode");
  assert.equal((await validateBranchTextBootstrapBeacon(expiryMismatch, { now })).reason, "payload_expiry_mismatch");
});

void test("BRANCH0 bootstrap.beacon validator rejects invalid relay endpoint descriptors", async () => {
  const now = 1_789_000_000;
  const valid = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const tooManyEndpoints = Array.from({ length: 9 }, (_, index) =>
    relayEndpointValue("wss", `wss://relay-${String(index)}.example:443/relay/v0`, index)
  );

  const cases: readonly [string, Promise<string>][] = [
    ["missing-relay-endpoints", resignWithPayloadPatch(valid, (entries) => entries.filter((entry) => entry.key !== "relay_endpoints"))],
    ["duplicate-relay-endpoint", resignWithPayloadPatch(valid, (entries) => replacePayloadEntry(entries, "relay_endpoints", [
      relayEndpointValue("wss", "wss://relay.example:443/relay/v0", 0),
      relayEndpointValue("wss", "wss://relay.example:443/relay/v0", 1)
    ]))],
    ["too-many-relay-endpoints", resignWithPayloadPatch(valid, (entries) => replacePayloadEntry(entries, "relay_endpoints", tooManyEndpoints))],
    ["missing-wss-port", resignWithPayloadPatch(valid, (entries) => replacePayloadEntry(entries, "relay_endpoints", [
      relayEndpointValue("wss", "wss://relay.example/relay/v0", 0)
    ]))],
    ["wss-userinfo", resignWithPayloadPatch(valid, (entries) => replacePayloadEntry(entries, "relay_endpoints", [
      relayEndpointValue("wss", "wss://user@relay.example:443/relay/v0", 0)
    ]))],
    ["wss-fragment", resignWithPayloadPatch(valid, (entries) => replacePayloadEntry(entries, "relay_endpoints", [
      relayEndpointValue("wss", "wss://relay.example:443/relay/v0#frag", 0)
    ]))],
    ["priority-order", resignWithPayloadPatch(valid, (entries) => replacePayloadEntry(entries, "relay_endpoints", [
      relayEndpointValue("wss", "wss://relay-two.example:443/relay/v0", 10),
      relayEndpointValue("wss", "wss://relay.example:443/relay/v0", 0)
    ]))]
  ];

  for (const [name, wrapperPromise] of cases) {
    const result = await validateBranchTextBootstrapBeacon(await wrapperPromise, { now });
    assert.equal(result.reason, "payload_invalid", name);
  }
});

void test("BRANCH0 bootstrap.beacon validator requires a supported profile multihash", async () => {
  const now = 1_789_000_000;
  const valid = await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 });
  const unsupportedProfile = await resignWithPayloadPatch(valid, (entries) =>
    replacePayloadEntry(entries, "profile_multihashes", ["uEiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])
  );
  const unorderedProfiles = await resignWithPayloadPatch(valid, (entries) =>
    replacePayloadEntry(entries, "profile_multihashes", [defaultBootstrapProfileMultihashes[0], "uEiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])
  );

  assert.equal((await validateBranchTextBootstrapBeacon(unsupportedProfile, { now })).reason, "payload_invalid");
  assert.equal((await validateBranchTextBootstrapBeacon(unorderedProfiles, { now })).reason, "payload_invalid");
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

async function assertRelayAttachmentVectorCoverage(manifest: VectorManifest): Promise<void> {
  const text = await readFile(join(vectorsDir, manifest.relay_attachment.fixture), "utf8");
  const vectors: unknown = JSON.parse(text);

  if (!isRelayAttachmentVectors(vectors)) {
    throw new Error("invalid relay attachment vectors");
  }

  assert.equal(vectors.profile_multihash, manifest.profile.development_multihash);
  assert.equal(vectors.frame_schema, manifest.relay_attachment.frame_schema);
  assert.equal(vectors.proof_domain, relayProofDomain);

  const seenFrameTypes = new Set<RelayFrameType>();
  for (const vectorCase of vectors.valid) {
    assert.equal(vectorCase.expect, "accept");
    const frame = decodeDraftRelayAttachmentFrameText(JSON.stringify(vectorCase.frame));
    seenFrameTypes.add(frame.type);
  }
  for (const frameType of manifest.relay_attachment.required_frame_types) {
    assert.equal(seenFrameTypes.has(frameType), true, `missing relay frame type ${frameType}`);
  }

  const seenReasons = new Set<string>();
  for (const vectorCase of vectors.invalid) {
    assert.equal(vectorCase.expect, "reject");
    assert.throws(() => decodeDraftRelayAttachmentFrameText(JSON.stringify(vectorCase.frame)), RelayAttachmentError);
    if (vectorCase.reason !== undefined) {
      seenReasons.add(vectorCase.reason);
    }
  }
  for (const reason of manifest.relay_attachment.required_invalid_reasons) {
    assert.equal(seenReasons.has(reason), true, `missing relay attachment invalid reason ${reason}`);
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
    readonly relay_attachment?: unknown;
    readonly cases?: unknown;
  };

  return (
    candidate.schema === "branch.testvectors/0" &&
    candidate.protocol === protocolID &&
    candidate.status === "draft" &&
    isVectorProfile(candidate.profile) &&
    isVectorTranscripts(candidate.transcripts) &&
    isBootstrapBeaconVectorsRef(candidate.bootstrap_beacon) &&
    isRelayAttachmentVectorsRef(candidate.relay_attachment) &&
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

function isRelayAttachmentVectorsRef(value: unknown): value is RelayAttachmentVectorsRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly fixture?: unknown;
    readonly frame_schema?: unknown;
    readonly required_frame_types?: unknown;
    readonly required_invalid_reasons?: unknown;
  };

  return (
    typeof candidate.fixture === "string" &&
    candidate.frame_schema === relayAttachmentSchema &&
    Array.isArray(candidate.required_frame_types) &&
    candidate.required_frame_types.every(isRelayFrameType) &&
    Array.isArray(candidate.required_invalid_reasons) &&
    candidate.required_invalid_reasons.every((reason) => typeof reason === "string")
  );
}

function isRelayAttachmentVectors(value: unknown): value is RelayAttachmentVectors {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly schema?: unknown;
    readonly protocol?: unknown;
    readonly profile_multihash?: unknown;
    readonly frame_schema?: unknown;
    readonly proof_domain?: unknown;
    readonly valid?: unknown;
    readonly invalid?: unknown;
  };

  return (
    candidate.schema === "branch.relay-attachment-vectors/0" &&
    candidate.protocol === protocolID &&
    typeof candidate.profile_multihash === "string" &&
    candidate.frame_schema === relayAttachmentSchema &&
    candidate.proof_domain === relayProofDomain &&
    Array.isArray(candidate.valid) &&
    candidate.valid.every(isRelayAttachmentVectorCase) &&
    Array.isArray(candidate.invalid) &&
    candidate.invalid.every(isRelayAttachmentVectorCase)
  );
}

function isRelayAttachmentVectorCase(value: unknown): value is RelayAttachmentVectorCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly expect?: unknown;
    readonly reason?: unknown;
    readonly frame?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    (candidate.expect === "accept" || candidate.expect === "reject") &&
    (candidate.reason === undefined || typeof candidate.reason === "string") &&
    candidate.frame !== undefined
  );
}

function isRelayFrameType(value: unknown): value is RelayFrameType {
  return (
    value === "HELLO" ||
    value === "CHALLENGE" ||
    value === "AUTH" ||
    value === "READY" ||
    value === "PRESENCE" ||
    value === "HEARTBEAT" ||
    value === "LOOKUP" ||
    value === "RENDEZVOUS" ||
    value === "ENVELOPE" ||
    value === "ACK" ||
    value === "ERROR"
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

async function resignWithPayloadPatch(
  wrapper: string,
  patch: (entries: readonly CborEntry[]) => readonly CborEntry[]
): Promise<string> {
  return resignWrapperWithPatch(wrapper, (entries) => entries.map((entry) => {
    if (entry.key !== "payload") {
      return entry;
    }
    assert(entry.value instanceof Uint8Array);
    const payloadMap = readCborMap(decodeDeterministicCbor(entry.value), "payload");
    return { key: entry.key, value: encodeDeterministicCbor(cborMap(patch(payloadMap.entries))) };
  }));
}

function replacePayloadEntry(entries: readonly CborEntry[], key: string, value: CborEntry["value"]): readonly CborEntry[] {
  return entries.map((entry) => entry.key === key ? { key, value } : entry);
}

function relayEndpointValue(transport: string, uri: string, priority: number): CborEntry["value"] {
  return cborMap([
    { key: "transport", value: transport },
    { key: "uri", value: uri },
    { key: "priority", value: priority }
  ]);
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
