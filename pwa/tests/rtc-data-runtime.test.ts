import assert from "node:assert/strict";
import test from "node:test";

import {
  betaHpkeCiphertextBytesForPlaintext,
  createBetaPayloadKeyPair,
  decodeRtcAdmit,
  decodeRtcData,
  encodeBase64URL,
  encodeRtcAdmit,
  encodeRtcData,
  makeBetaPayloadAAD,
  protocolID,
  developmentProfileMultihash,
  sealBetaPayload,
  SameRelayTransportClient,
  type RtcData
} from "@code4bones/branch-core";

import { setLocalIdentityKeys } from "../src/identity/identity-keys.js";
import { RTCDataIngressRuntime } from "../src/connectivity/rtc-data-runtime.js";
import { clearLiveRTCDataSenders, installLiveRTCDataSender, maxRTCDataInFlight, RTCDirectSender, sendLiveRTCData } from "../src/connectivity/rtc-data-runtime.js";
import { fixedAckRequested, fixedPathEpoch, fixedStreamId } from "../src/connectivity/payload-aad-defaults.js";
import type { RTCDataChannelPort } from "../src/connectivity/rtc-session.js";

const sessionId = encodeBase64URL(new Uint8Array(16).fill(1));
const originRouteId = encodeBase64URL(new Uint8Array(16).fill(2));
const deliveryId = encodeBase64URL(new Uint8Array(16).fill(3));

class FakeChannel implements RTCDataChannelPort {
  readonly label = "branch.rtc.data/0.draft";
  readonly ordered = true;
  readonly negotiated = false;
  readonly maxPacketLifeTime = null;
  readonly maxRetransmits = null;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  readonly sent: Uint8Array[] = [];
  #listener: ((data: unknown) => void) | null = null;
  send(bytes: Uint8Array): void { this.sent.push(new Uint8Array(bytes)); }
  onMessage(listener: (data: unknown) => void): void { this.#listener = listener; }
  close(): void {}
  emit(bytes: Uint8Array): void { this.#listener?.(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
}

void test("RTC DATA decrypts before admission, dispatches once, and repeats only ADMIT", async () => {
  const [remote, localRelay, localHPKE] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity(),
    createBetaPayloadKeyPair()
  ]);
  setLocalIdentityKeys({ relayPrivateKey: localRelay.privateKey, hpkePrivateKey: localHPKE.privateKey });
  const channel = new FakeChannel();
  const dispatched: Uint8Array[] = [];
  const runtime = new RTCDataIngressRuntime({
    localPeerId: localRelay.peerId,
    remotePeerId: remote.peerId,
    rtcSessionId: sessionId,
    expiresAt: Date.now() + 10_000,
    channel,
    dispatch: ({ plaintext }) => { dispatched.push(plaintext); return Promise.resolve(true); }
  });
  const frame = await sealedFrame(remote.peerId, localRelay.peerId, localHPKE.publicKey, new TextEncoder().encode("direct"));
  assert.equal(await runtime.receive(frame), "admitted");
  assert.equal(new TextDecoder().decode(dispatched[0]), "direct");
  assert.deepEqual(decodeRtcAdmit(channel.sent[0] ?? assert.fail("missing admit")), { kind: "admit", version: "branch.rtc.data/0.draft", rtcSessionId: sessionId, deliveryId });
  assert.equal(await runtime.receive(frame), "duplicate");
  assert.equal(dispatched.length, 1);
  assert.equal(channel.sent.length, 2);
  assert.equal(await runtime.receive("not binary"), "rejected");
  setLocalIdentityKeys(null);
});

void test("RTC DATA rejects conflicting delivery-id reuse without an ADMIT", async () => {
  const [remote, localRelay, localHPKE] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity(),
    createBetaPayloadKeyPair()
  ]);
  setLocalIdentityKeys({ relayPrivateKey: localRelay.privateKey, hpkePrivateKey: localHPKE.privateKey });
  const channel = new FakeChannel();
  const runtime = new RTCDataIngressRuntime({
    localPeerId: localRelay.peerId,
    remotePeerId: remote.peerId,
    rtcSessionId: sessionId,
    expiresAt: Date.now() + 10_000,
    channel,
    dispatch: () => Promise.resolve(true)
  });
  assert.equal(await runtime.receive(await sealedFrame(remote.peerId, localRelay.peerId, localHPKE.publicKey, new TextEncoder().encode("one"))), "admitted");
  assert.equal(await runtime.receive(await sealedFrame(remote.peerId, localRelay.peerId, localHPKE.publicKey, new TextEncoder().encode("two"))), "conflict");
  assert.equal(channel.sent.length, 1);
  setLocalIdentityKeys(null);
});

void test("RTC direct sender bounds pending DATA, accepts only an exact ADMIT, and falls back once", async () => {
  const channel = new FakeChannel();
  const fallback: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const sender = new RTCDirectSender({
    rtcSessionId: sessionId,
    channel,
    fallbackToWSS: (frame) => { fallback.push(frame.deliveryId); return Promise.resolve(); },
    schedule: (callback) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => { timers.delete(timer as unknown as number); }
  });
  const first = directFrame(deliveryId);
  assert.equal(sender.send(first), true);
  assert.equal(sender.pendingCount, 1);
  assert.equal(sender.admit({ kind: "admit", version: "branch.rtc.data/0.draft", rtcSessionId: encodeBase64URL(new Uint8Array(16).fill(9)), deliveryId }), false);
  assert.equal(sender.admit({ kind: "admit", version: "branch.rtc.data/0.draft", rtcSessionId: sessionId, deliveryId }), true);
  assert.equal(sender.pendingCount, 0);
  assert.deepEqual(fallback, []);

  for (let index = 0; index < maxRTCDataInFlight; index += 1) assert.equal(sender.send(directFrame(encodeBase64URL(new Uint8Array(16).fill(index + 10)))), true);
  assert.equal(sender.send(directFrame(encodeBase64URL(new Uint8Array(16).fill(99)))), false);
  const oneTimer = timers.values().next().value as (() => void) | undefined;
  assert.ok(oneTimer !== undefined);
  oneTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fallback.length, 1);
});

void test("the live direct registry binds DATA to its active session and releases only its ADMIT", () => {
  const channel = new FakeChannel();
  const peerId = "peer-direct";
  const sender = installLiveRTCDataSender({ peerId, rtcSessionId: sessionId, expiresAt: Date.now() + 10_000, channel });
  new RTCDataIngressRuntime({
    localPeerId: "local-direct",
    remotePeerId: peerId,
    rtcSessionId: sessionId,
    expiresAt: Date.now() + 10_000,
    channel,
    dispatch: () => Promise.resolve(true),
    onAdmit: (receivedDeliveryId) => { sender.admit({ kind: "admit", version: "branch.rtc.data/0.draft", rtcSessionId: sessionId, deliveryId: receivedDeliveryId }); }
  });
  const fallback: string[] = [];
  assert.equal(sendLiveRTCData({
    peerId,
    frame: { ...directFrame(deliveryId), rtcSessionId: "" },
    fallbackToWSS: (frame) => { fallback.push(frame.deliveryId); return Promise.resolve(); }
  }), true);
  assert.equal(sender.pendingCount, 1);
  const data = channel.sent[0] ?? assert.fail("missing direct DATA");
  assert.deepEqual(decodeRtcData(data), directFrame(deliveryId));

  channel.emit(encodeRtcAdmit({ kind: "admit", version: "branch.rtc.data/0.draft", rtcSessionId: sessionId, deliveryId }));
  assert.equal(sender.pendingCount, 0);
  assert.deepEqual(fallback, []);
  clearLiveRTCDataSenders();
});

function directFrame(id: string): RtcData {
  return {
    kind: "data",
    version: "branch.rtc.data/0.draft",
    rtcSessionId: sessionId,
    originRouteId,
    pathEpoch: fixedPathEpoch,
    streamId: fixedStreamId,
    deliveryId: id,
    ackRequested: fixedAckRequested,
    ciphertext: encodeBase64URL(new Uint8Array([1, 2, 3]))
  };
}

async function sealedFrame(senderPeerId: string, recipientPeerId: string, recipientPublicKey: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const expectedCiphertextBytes = betaHpkeCiphertextBytesForPlaintext(plaintext);
  const sealedPayload = await sealBetaPayload({
    recipientPublicKey,
    plaintext,
    expectedCiphertextBytes,
    aad: makeBetaPayloadAAD({
      protocol: protocolID,
      profileMultihash: developmentProfileMultihash,
      originRouteId,
      senderPeerKey: senderPeerId,
      recipientPeerKey: recipientPeerId,
      deliveryId,
      pathEpoch: fixedPathEpoch,
      streamId: fixedStreamId,
      frameType: "ENVELOPE",
      ackRequested: fixedAckRequested,
      hpkeCiphertextBytes: expectedCiphertextBytes
    })
  });
  const frame: RtcData = {
    kind: "data",
    version: "branch.rtc.data/0.draft",
    rtcSessionId: sessionId,
    originRouteId,
    pathEpoch: fixedPathEpoch,
    streamId: fixedStreamId,
    deliveryId,
    ackRequested: fixedAckRequested,
    ciphertext: sealedPayload
  };
  return encodeRtcData(frame);
}
