import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeDraftEnvelopeText, protocolID, ProtocolError } from "../src/protocol/v0/envelope.js";

interface VectorManifest {
  readonly schema: "branch.testvectors/0";
  readonly protocol: typeof protocolID;
  readonly status: "draft";
  readonly cases: readonly VectorCase[];
}

interface VectorCase {
  readonly name: string;
  readonly kind: "draft_envelope_json";
  readonly fixture: string;
  readonly expect: "accept-structure" | "reject-structure";
}

const thisDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(thisDir, "..", "..", "..", "testdata", "vectors", "protocol-v0");

void test("draft envelope vectors pass shared conformance checks", async (t) => {
  const manifest = await readManifest();

  assert.equal(manifest.schema, "branch.testvectors/0");
  assert.equal(manifest.protocol, protocolID);
  assert.equal(manifest.status, "draft");
  assert.notEqual(manifest.cases.length, 0);

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

function isManifest(value: unknown): value is VectorManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly schema?: unknown;
    readonly protocol?: unknown;
    readonly status?: unknown;
    readonly cases?: unknown;
  };

  return (
    candidate.schema === "branch.testvectors/0" &&
    candidate.protocol === protocolID &&
    candidate.status === "draft" &&
    Array.isArray(candidate.cases) &&
    candidate.cases.every(isVectorCase)
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
