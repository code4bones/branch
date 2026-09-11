import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeRtcAnswer,
  decodeRtcCandidate,
  decodeRtcCancel,
  decodeRtcCapabilities,
  decodeRtcOffer,
  decodeRtcRestart,
  encodeRtcAnswer,
  encodeRtcCandidate,
  encodeRtcCancel,
  encodeRtcCapabilities,
  encodeRtcOffer,
  encodeRtcRestart,
  maxRtcCandidateBytes,
  maxRtcDescriptionBytes,
  rtcDescriptionSHA256,
  rtcSignalingVersion,
  type RtcOffer
} from "../src/index.js";
import { cborMap, encodeDeterministicCbor } from "../src/protocol/v0/cbor.js";
import { decodeBase64URL, encodeBase64URL } from "../src/protocol/v0/base64url.js";

const sessionId = token(16, 1);
const fingerprint = token(32, 2);
const fingerprintLine = Array.from({ length: 32 }, () => "02").join(":");
const description = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=branch\r\nt=0 0\r\na=fingerprint:sha-256 ${fingerprintLine}\r\n`;

test("RTC signaling bodies round-trip as bounded canonical CBOR", async () => {
  const descriptionSHA256 = await rtcDescriptionSHA256(description);
  const offer: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 0, description, descriptionSHA256, dtlsFingerprintSHA256: fingerprint };
  const answer = { ...offer, generation: 1, offerDescriptionSHA256: descriptionSHA256 };
  const restart = { ...offer, generation: 2, priorDescriptionSHA256: descriptionSHA256 };

  assert.deepEqual(await decodeRtcCapabilities(await encodeRtcCapabilities({ version: rtcSignalingVersion, maxDescriptionBytes: maxRtcDescriptionBytes, maxCandidateBytes: maxRtcCandidateBytes, maxCandidatesPerDirection: 32 })), { version: rtcSignalingVersion, maxDescriptionBytes: maxRtcDescriptionBytes, maxCandidateBytes: maxRtcCandidateBytes, maxCandidatesPerDirection: 32 });
  assert.deepEqual(await decodeRtcOffer(await encodeRtcOffer(offer)), offer);
  assert.deepEqual(await decodeRtcAnswer(await encodeRtcAnswer(answer)), answer);
  assert.deepEqual(await decodeRtcRestart(await encodeRtcRestart(restart)), restart);
  assert.deepEqual(await decodeRtcCandidate(await encodeRtcCandidate({ version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 2, direction: "offerer", descriptionSHA256, candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host" })), { version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 2, direction: "offerer", descriptionSHA256, candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host" });
  assert.deepEqual(await decodeRtcCancel(await encodeRtcCancel({ version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 2, descriptionSHA256, reason: "glare" })), { version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 2, descriptionSHA256, reason: "glare" });
});

test("RTC description codecs reject SHA-256 substitution and malformed closed maps", async () => {
  const descriptionSHA256 = await rtcDescriptionSHA256(description);
  const offer: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 0, description, descriptionSHA256, dtlsFingerprintSHA256: fingerprint };
  await assert.rejects(encodeRtcOffer({ ...offer, descriptionSHA256: token(32, 9) }));

  const malformed = encodeDeterministicCbor(cborMap([
    { key: "version", value: rtcSignalingVersion },
    { key: "rtc_session_id", value: new Uint8Array(16).fill(1) },
    { key: "generation", value: 0 },
    { key: "description", value: description },
    { key: "description_sha256", value: new Uint8Array(32).fill(2) },
    { key: "dtls_fingerprint_sha256", value: new Uint8Array(32).fill(2) },
    { key: "unexpected", value: "no" }
  ]));
  await assert.rejects(decodeRtcOffer(malformed));
});

test("RTC signaling bounds descriptions, candidates, generations and terminal reasons", async () => {
  const digest = await rtcDescriptionSHA256(description);
  const base: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 0, description, descriptionSHA256: digest, dtlsFingerprintSHA256: fingerprint };
  await assert.rejects(encodeRtcOffer({ ...base, description: "x".repeat(maxRtcDescriptionBytes + 1) }));
  await assert.rejects(encodeRtcCandidate({ version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 0, direction: "offerer", descriptionSHA256: digest, candidate: "x".repeat(maxRtcCandidateBytes + 1) }));
  await assert.rejects(encodeRtcCancel({ version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 65_536, descriptionSHA256: digest, reason: "glare" }));
  await assert.rejects(encodeRtcCancel({ version: rtcSignalingVersion, rtcSessionId: sessionId, generation: 0, descriptionSHA256: digest, reason: "free_text" as never }));
});

void test("RTC signaling shared vectors fix every canonical body", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../../testdata/vectors/protocol-v0/rtc-signaling-vectors.json", import.meta.url), "utf8")) as {
    valid: {
      description: string;
      description_sha256: string;
      dtls_fingerprint_sha256: string;
      session_id: string;
      canonical_body: Record<"capabilities" | "offer" | "answer" | "candidate" | "restart" | "cancel", string>;
    };
    invalid_body: { description_hash_substitution: string; candidate_invalid_direction: string };
  };
  const offer: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: fixture.valid.session_id, generation: 0, description: fixture.valid.description, descriptionSHA256: fixture.valid.description_sha256, dtlsFingerprintSHA256: fixture.valid.dtls_fingerprint_sha256 };
  const canonical = fixture.valid.canonical_body;
  assert.equal(encodeBase64URL(await encodeRtcCapabilities({ version: rtcSignalingVersion, maxDescriptionBytes: maxRtcDescriptionBytes, maxCandidateBytes: maxRtcCandidateBytes, maxCandidatesPerDirection: 32 })), canonical.capabilities);
  assert.equal(encodeBase64URL(await encodeRtcOffer(offer)), canonical.offer);
  assert.equal(encodeBase64URL(await encodeRtcAnswer({ ...offer, generation: 1, offerDescriptionSHA256: offer.descriptionSHA256 })), canonical.answer);
  assert.equal(encodeBase64URL(await encodeRtcCandidate({ version: rtcSignalingVersion, rtcSessionId: offer.rtcSessionId, generation: 1, direction: "offerer", descriptionSHA256: offer.descriptionSHA256, candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host" })), canonical.candidate);
  assert.equal(encodeBase64URL(await encodeRtcRestart({ ...offer, generation: 2, priorDescriptionSHA256: offer.descriptionSHA256 })), canonical.restart);
  assert.equal(encodeBase64URL(await encodeRtcCancel({ version: rtcSignalingVersion, rtcSessionId: offer.rtcSessionId, generation: 2, descriptionSHA256: offer.descriptionSHA256, reason: "glare" })), canonical.cancel);
  await assert.rejects(decodeRtcOffer(decodeBase64URL(fixture.invalid_body.description_hash_substitution)));
  await assert.rejects(decodeRtcCandidate(decodeBase64URL(fixture.invalid_body.candidate_invalid_direction)));
});

function token(size: number, fill: number): string {
  return encodeBase64URL(new Uint8Array(size).fill(fill));
}
