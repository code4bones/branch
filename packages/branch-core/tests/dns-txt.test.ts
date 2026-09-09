import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  createDnsTxtBootstrapPublication,
  dnsTxtMaxCandidateOctets,
  dnsTxtMaxCharacterStringOctets,
  dnsTxtOwnerName,
  formatDnsCharacterStrings,
  parseDnsTxtBootstrapRecords
} from "../src/discovery/dns-txt.js";
import { createBootstrapBeaconWrapper, validateBranchTextBootstrapBeacon } from "../src/protocol/v0/bootstrap-beacon.js";

void test("DNS TXT publication reconstructs one exact signed wrapper", async () => {
  const { now, wrapper } = await loadSharedBootstrapFixture();
  const publication = createDnsTxtBootstrapPublication("Relay.Example.Test.", wrapper);
  const parsed = parseDnsTxtBootstrapRecords([publication.strings]);

  assert.equal(publication.ownerName, "branch-bootstrap.relay.example.test");
  assert.equal(publication.value, `branchbootstrapv0=${wrapper}`);
  assert.equal(publication.strings.join(""), publication.value);
  assert(publication.strings.every((part) => new TextEncoder().encode(part).byteLength <= dnsTxtMaxCharacterStringOctets));
  assert.match(publication.zoneFileRecord, /^branch-bootstrap\.relay\.example\.test\. 300 IN TXT /);
  assert.deepEqual(parsed.rejections, []);
  assert.equal(parsed.candidates[0]?.wrapper, wrapper);
  const validation = await validateBranchTextBootstrapBeacon(parsed.candidates[0]?.wrapper ?? "", { now });
  assert.equal(validation.accepted, true);

  const truncatedStrings = [...publication.strings];
  const finalIndex = truncatedStrings.length - 1;
  truncatedStrings[finalIndex] = (truncatedStrings[finalIndex] ?? "").slice(0, -1);
  const truncated = parseDnsTxtBootstrapRecords([truncatedStrings]);
  assert.equal(truncated.candidates.length, 1);
  const truncatedValidation = await validateBranchTextBootstrapBeacon(truncated.candidates[0]?.wrapper ?? "", { now });
  assert.equal(truncatedValidation.accepted, false);
});

void test("DNS TXT parser preserves string order per RR but treats RRset order as untrusted", async () => {
  const now = Math.floor(Date.now() / 1000);
  const first = createDnsTxtBootstrapPublication("first.example", await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 }));
  const second = createDnsTxtBootstrapPublication("second.example", await createBootstrapBeaconWrapper({ now, expiresAt: now + 3600 }));
  const parsed = parseDnsTxtBootstrapRecords([second.strings, first.strings, second.strings]);

  assert.deepEqual(parsed.candidates.map((candidate) => candidate.wrapper), [
    second.value.slice("branchbootstrapv0=".length),
    first.value.slice("branchbootstrapv0=".length)
  ]);
  assert.deepEqual(parsed.rejections, [{ rrIndex: 2, reason: "duplicate" }]);
});

void test("DNS TXT parser rejects malformed and over-limit records before bootstrap validation", () => {
  const parsed = parseDnsTxtBootstrapRecords([
    [],
    Array.from({ length: 9 }, () => "x"),
    ["x".repeat(dnsTxtMaxCharacterStringOctets + 1)],
    ["branchbootstrapv0=BRANCH0.a", "\u0000"],
    ["not-branch-value"],
    ["branchbootstrapv0=BRANCH0.not-valid="],
    ["x".repeat(dnsTxtMaxCandidateOctets + 1)]
  ]);

  assert.deepEqual(parsed.candidates, []);
  assert.deepEqual(parsed.rejections.map((rejection) => rejection.reason), [
    "empty_record",
    "too_many_strings",
    "string_too_large",
    "non_ascii",
    "wrong_prefix",
    "malformed_wrapper",
    "string_too_large"
  ]);
});

void test("DNS TXT publication rejects invalid domain and application bounds", () => {
  assert.equal(dnsTxtOwnerName("example.test"), "branch-bootstrap.example.test");
  assert.throws(() => dnsTxtOwnerName("example..test"), /invalid/);
  assert.throws(() => dnsTxtOwnerName("münchen.example"), /invalid/);
  assert.throws(() => createDnsTxtBootstrapPublication("example.test", `BRANCH0.${"A".repeat(dnsTxtMaxCandidateOctets)}`), /too large/);
});

void test("DNS TXT zone rendering quotes and escapes printable provider text", () => {
  assert.equal(formatDnsCharacterStrings(["alpha\"beta", "slash\\value"]), "\"alpha\\\"beta\" \"slash\\\\value\"");
});

interface BootstrapFixture {
  readonly valid: {
    readonly now: number;
    readonly wrapper: string;
  };
}

async function loadSharedBootstrapFixture(): Promise<{ readonly now: number; readonly wrapper: string }> {
  const path = join(process.cwd(), "..", "..", "testdata", "vectors", "protocol-v0", "bootstrap-beacon-vectors.json");
  const fixture = JSON.parse(await readFile(path, "utf8")) as BootstrapFixture;
  return fixture.valid;
}
