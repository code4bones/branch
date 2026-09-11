import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeRtcAdmit,
  decodeRtcData,
  decodeRtcDataFrame,
  encodeRtcAdmit,
  encodeRtcData,
  maxRtcDataCiphertextBytes,
  rtcDataVersion,
  type RtcData
} from "../src/index.js";
import { cborMap, decodeDeterministicCbor, encodeDeterministicCbor } from "../src/protocol/v0/cbor.js";
import { decodeBase64URL, encodeBase64URL } from "../src/protocol/v0/base64url.js";

const data: RtcData = {
  kind: "data",
  version: rtcDataVersion,
  rtcSessionId: token(16, 1),
  originRouteId: token(16, 2),
  pathEpoch: 3,
  streamId: 4,
  deliveryId: token(16, 5),
  ackRequested: true,
  ciphertext: token(32, 6)
};

test("RTC DATA and ADMIT are bounded canonical CBOR endpoint frames", () => {
  const encodedData = encodeRtcData(data);
  const admit = { kind: "admit" as const, version: rtcDataVersion, rtcSessionId: data.rtcSessionId, deliveryId: data.deliveryId };
  const encodedAdmit = encodeRtcAdmit(admit);

  assert.deepEqual(decodeRtcData(encodedData), data);
  assert.deepEqual(decodeRtcAdmit(encodedAdmit), admit);
  assert.deepEqual(decodeRtcDataFrame(encodedData), data);
  assert.deepEqual(decodeRtcDataFrame(encodedAdmit), admit);
  assert.deepEqual(encodeRtcData(decodeRtcData(encodedData)), encodedData);
  assert.deepEqual(encodeRtcAdmit(decodeRtcAdmit(encodedAdmit)), encodedAdmit);
});

test("RTC DATA encodes CBOR booleans canonically", () => {
  assert.deepEqual(encodeDeterministicCbor(true), new Uint8Array([0xf5]));
  assert.deepEqual(encodeDeterministicCbor(false), new Uint8Array([0xf4]));
  assert.equal(decodeDeterministicCbor(new Uint8Array([0xf5])), true);
  assert.equal(decodeDeterministicCbor(new Uint8Array([0xf4])), false);

  const encoded = encodeRtcData({ ...data, ackRequested: false });
  assert.deepEqual(decodeRtcData(encoded), { ...data, ackRequested: false });
});

test("RTC direct frame rejects relay fields, malformed booleans, unknown kinds, and non-canonical CBOR", () => {
  const relayShaped = encodeDeterministicCbor(cborMap([
    { key: "kind", value: "data" },
    { key: "version", value: rtcDataVersion },
    { key: "rtc_session_id", value: new Uint8Array(16).fill(1) },
    { key: "origin_route_id", value: new Uint8Array(16).fill(2) },
    { key: "path_epoch", value: 3 },
    { key: "stream_id", value: 4 },
    { key: "delivery_id", value: new Uint8Array(16).fill(5) },
    { key: "ack_requested", value: true },
    { key: "ciphertext", value: new Uint8Array(32).fill(6) },
    { key: "route_id", value: new Uint8Array(16).fill(7) }
  ]));
  const numericAck = encodeDeterministicCbor(cborMap([
    { key: "kind", value: "data" },
    { key: "version", value: rtcDataVersion },
    { key: "rtc_session_id", value: new Uint8Array(16).fill(1) },
    { key: "origin_route_id", value: new Uint8Array(16).fill(2) },
    { key: "path_epoch", value: 3 },
    { key: "stream_id", value: 4 },
    { key: "delivery_id", value: new Uint8Array(16).fill(5) },
    { key: "ack_requested", value: 1 },
    { key: "ciphertext", value: new Uint8Array(32).fill(6) }
  ]));
  const unknownKind = encodeDeterministicCbor(cborMap([
    { key: "kind", value: "relay_ack" },
    { key: "version", value: rtcDataVersion }
  ]));

  assert.throws(() => decodeRtcData(relayShaped));
  assert.throws(() => decodeRtcData(numericAck));
  assert.throws(() => decodeRtcDataFrame(unknownKind));
  assert.throws(() => decodeRtcData(new Uint8Array([0xb8, 0x00])));
});

test("RTC DATA bounds opaque ciphertext and unsigned sequence values", () => {
  assert.equal(decodeRtcData(encodeRtcData({ ...data, ciphertext: token(maxRtcDataCiphertextBytes, 8) })).ciphertext, token(maxRtcDataCiphertextBytes, 8));
  assert.throws(() => encodeRtcData({ ...data, ciphertext: token(maxRtcDataCiphertextBytes + 1, 8) }));
  assert.throws(() => encodeRtcData({ ...data, ciphertext: "" }));
  assert.throws(() => encodeRtcData({ ...data, pathEpoch: -1 }));
  assert.throws(() => encodeRtcData({ ...data, streamId: Number.MAX_SAFE_INTEGER + 1 }));
});

void test("RTC DATA shared vectors are canonical in TypeScript", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../../testdata/vectors/protocol-v0/rtc-data-vectors.json", import.meta.url), "utf8")) as {
    valid: { data: { rtc_session_id: string; origin_route_id: string; path_epoch: number; stream_id: number; delivery_id: string; ack_requested: boolean; ciphertext: string; canonical_frame: string }; admit: { rtc_session_id: string; delivery_id: string; canonical_frame: string } };
    invalid_frame: Record<string, string>;
  };
  assert.equal(encodeBase64URL(encodeRtcData({ kind: "data", version: rtcDataVersion, rtcSessionId: fixture.valid.data.rtc_session_id, originRouteId: fixture.valid.data.origin_route_id, pathEpoch: fixture.valid.data.path_epoch, streamId: fixture.valid.data.stream_id, deliveryId: fixture.valid.data.delivery_id, ackRequested: fixture.valid.data.ack_requested, ciphertext: fixture.valid.data.ciphertext })), fixture.valid.data.canonical_frame);
  assert.equal(encodeBase64URL(encodeRtcAdmit({ kind: "admit", version: rtcDataVersion, rtcSessionId: fixture.valid.admit.rtc_session_id, deliveryId: fixture.valid.admit.delivery_id })), fixture.valid.admit.canonical_frame);
  for (const bytes of Object.values(fixture.invalid_frame)) assert.throws(() => decodeRtcDataFrame(decodeBase64URL(bytes)));
});

function token(size: number, fill: number): string {
  return encodeBase64URL(new Uint8Array(size).fill(fill));
}
