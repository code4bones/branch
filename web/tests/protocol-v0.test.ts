import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeDraftEnvelopeText, protocolID, ProtocolError } from "../src/protocol/v0/envelope.js";
import { draftProfileMultihash, profileHashAlgorithm } from "../src/protocol/v0/profile.js";

interface VectorManifest {
  readonly schema: "branch.testvectors/0";
  readonly protocol: typeof protocolID;
  readonly status: "draft";
  readonly profile: VectorProfile;
  readonly transcripts: VectorTranscripts;
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

async function readManifest(): Promise<VectorManifest> {
  const text = await readFile(join(vectorsDir, "manifest.json"), "utf8");
  const manifest: unknown = JSON.parse(text);

  if (!isManifest(manifest)) {
    throw new Error("invalid vector manifest");
  }

  return manifest;
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
    readonly cases?: unknown;
  };

  return (
    candidate.schema === "branch.testvectors/0" &&
    candidate.protocol === protocolID &&
    candidate.status === "draft" &&
    isVectorProfile(candidate.profile) &&
    isVectorTranscripts(candidate.transcripts) &&
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
