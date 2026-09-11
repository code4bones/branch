import assert from "node:assert/strict";
import test from "node:test";

import {
  rtcCapabilitiesControlKind,
  rtcOfferControlKind,
  rtcSignalingVersion,
  type RtcCapabilities,
  type RtcSignalingBody
} from "@code4bones/branch-core";

import {
  RTCSessionRuntime,
  type RTCSignalingPort
} from "../src/connectivity/rtc-runtime.js";
import { rtcDataChannelLabel, type RTCDataChannelPort, type RTCPeerConnectionPort } from "../src/connectivity/rtc-session.js";

const localPeerId = "a-local";
const remotePeerId = "z-remote";
const validSDP = `v=0\r\na=fingerprint:sha-256 ${Array.from({ length: 32 }, () => "01").join(":")}\r\n`;
const capabilities: RtcCapabilities = {
  version: rtcSignalingVersion,
  maxDescriptionBytes: 1536,
  maxCandidateBytes: 1024,
  maxCandidatesPerDirection: 32
};

void test("accepted live RTC capability is answered and the lexical initiator sends one offer", async () => {
  const connection = new FakeConnection();
  const signaling = new FakeSignaling();
  const runtime = new RTCSessionRuntime({
    localPeerId,
    recipientHpkePublicKey: () => "recipient-hpke-key",
    createConnection: () => connection,
    signaling,
    now: () => 1_000
  });

  assert.deepEqual(await runtime.receive({
    plaintext: new Uint8Array(),
    senderPeerId: remotePeerId,
    knownContactId: "known-contact",
    now: 1_000
  }), { handled: true, outcome: "accepted" });
  assert.deepEqual(signaling.sent.map((entry) => entry.kind), [rtcCapabilitiesControlKind, rtcOfferControlKind]);

  // Duplicate capabilities neither start a second offer nor create a new
  // response before the local, short rate-limit interval expires.
  await runtime.receive({ plaintext: new Uint8Array(), senderPeerId: remotePeerId, knownContactId: "known-contact", now: 1_001 });
  assert.deepEqual(signaling.sent.map((entry) => entry.kind), [rtcCapabilitiesControlKind, rtcOfferControlKind]);
});

void test("a local RTC scheduling failure does not reject a verified capability", async () => {
  const runtime = new RTCSessionRuntime({
    localPeerId,
    recipientHpkePublicKey: () => "recipient-hpke-key",
    signaling: new FakeSignaling(true),
    createConnection: () => { throw new Error("must not start after reply failure"); },
    now: () => 1_000
  });

  assert.deepEqual(await runtime.receive({
    plaintext: new Uint8Array(),
    senderPeerId: remotePeerId,
    knownContactId: "known-contact",
    now: 1_000
  }), { handled: true, outcome: "accepted" });
});

class FakeSignaling implements RTCSignalingPort {
  readonly sent: Array<{ readonly kind: string; readonly body: RtcSignalingBody }> = [];

  constructor(private readonly rejectSend = false) {}

  receive(): ReturnType<RTCSignalingPort["receive"]> {
    return Promise.resolve({ handled: true, outcome: "accepted", kind: rtcCapabilitiesControlKind, body: capabilities, expiresAt: 61_000 });
  }

  send(input: Parameters<RTCSignalingPort["send"]>[0]): Promise<void> {
    if (this.rejectSend) return Promise.reject(new Error("simulated local transport failure"));
    this.sent.push({ kind: input.kind, body: input.body });
    return Promise.resolve();
  }

  reset(): void {}
}

class FakeConnection implements RTCPeerConnectionPort {
  createOffer(): Promise<string> { return Promise.resolve(validSDP); }
  createAnswer(): Promise<string> { return Promise.resolve(validSDP); }
  setLocalDescription(): Promise<void> { return Promise.resolve(); }
  setRemoteDescription(): Promise<void> { return Promise.resolve(); }
  addIceCandidate(): Promise<void> { return Promise.resolve(); }
  close(): void {}
  onIceCandidate(): void {}
  createDataChannel(): RTCDataChannelPort { return new FakeChannel(); }
  onDataChannel(): void {}
}

class FakeChannel implements RTCDataChannelPort {
  readonly label = rtcDataChannelLabel;
  readonly ordered = true;
  readonly negotiated = false;
  readonly maxPacketLifeTime = null;
  readonly maxRetransmits = null;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  send(): void {}
  onMessage(): void {}
  close(): void {}
}
