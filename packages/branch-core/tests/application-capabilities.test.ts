import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  decodeApplicationCapabilities,
  encodeApplicationCapabilities,
  maxApplicationCapabilityInlineBytes,
  type ApplicationCapabilities
} from "../src/index.js";
import { cborMap, encodeDeterministicCbor } from "../src/protocol/v0/cbor.js";
import { encodeBase64URL } from "../src/protocol/v0/base64url.js";

const fixtureURL = new URL("../../../../testdata/vectors/protocol-v0/application-payload-vectors.json", import.meta.url);

test("shared application capability body vector is canonical", async () => {
  const fixture = await vectors();
  const capabilities = fromFixture(fixture.valid.application_capabilities);
  const bytes = encodeApplicationCapabilities(capabilities);
  assert.equal(encodeBase64URL(bytes), fixture.valid.application_capabilities.canonical_body);
  assert.deepEqual(decodeApplicationCapabilities(bytes), capabilities);
  assert.deepEqual(encodeApplicationCapabilities(decodeApplicationCapabilities(bytes)), bytes);
});

test("shared invalid application capability vectors reject before control processing", async () => {
  const fixture = await vectors();
  for (const invalid of fixture.invalid_application_capabilities) {
    assert.throws(() => encodeApplicationCapabilities(fromFixture(invalid)), invalid.name);
  }
});

test("application capability decoder rejects unknown and non-canonical bodies", () => {
  const body = encodeDeterministicCbor(cborMap([
    { key: "application_versions", value: [] },
    { key: "kinds", value: [] },
    { key: "max_inline_bytes", value: maxApplicationCapabilityInlineBytes },
    { key: "attachment_mode", value: "none" },
    { key: "max_relay_attachment_bytes", value: 0 },
    { key: "max_direct_attachment_bytes", value: 0 },
    { key: "relay_authorization", value: "forbidden" }
  ]));
  assert.throws(() => decodeApplicationCapabilities(body));
  assert.throws(() => decodeApplicationCapabilities(new Uint8Array([0xb8, 0x00])));
});

interface CapabilityFixture {
  readonly name?: string;
  readonly application_versions: readonly string[];
  readonly kinds: readonly string[];
  readonly max_inline_bytes: number;
  readonly attachment_mode: string;
  readonly max_relay_attachment_bytes: number;
  readonly max_direct_attachment_bytes: number;
  readonly canonical_body?: string;
}

async function vectors(): Promise<{ readonly valid: { readonly application_capabilities: CapabilityFixture }; readonly invalid_application_capabilities: readonly CapabilityFixture[] }> {
  return JSON.parse(await readFile(fileURLToPath(fixtureURL), "utf8")) as Awaited<ReturnType<typeof vectors>>;
}

function fromFixture(value: CapabilityFixture): ApplicationCapabilities {
  return {
    applicationVersions: value.application_versions,
    kinds: value.kinds,
    maxInlineBytes: value.max_inline_bytes,
    attachmentMode: value.attachment_mode as ApplicationCapabilities["attachmentMode"],
    maxRelayAttachmentBytes: value.max_relay_attachment_bytes,
    maxDirectAttachmentBytes: value.max_direct_attachment_bytes
  };
}
