import assert from "node:assert/strict";
import test from "node:test";

import {
  rtcAnswerControlKind,
  rtcCandidateControlKind,
  rtcDescriptionSHA256,
  rtcOfferControlKind,
  rtcSignalingVersion,
  type RtcOffer
} from "@code4bones/branch-core";

import { RTCSessionController, extractDTLSFingerprintSHA256, rtcDataChannelLabel, type RTCDataChannelPort, type RTCPeerConnectionPort, type RTCSignal } from "../src/connectivity/rtc-session.js";

const localPeer = "a-local";
const remotePeer = "z-remote";
const fingerprint = Array.from({ length: 32 }, () => "02").join(":");
const remoteFingerprint = Array.from({ length: 32 }, () => "03").join(":");
const localSDP = `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
const remoteSDP = `v=0\r\na=fingerprint:sha-256 ${remoteFingerprint}\r\n`;

class FakeConnection implements RTCPeerConnectionPort {
  local: string | null = null;
  remote: string | null = null;
  readonly candidates: string[] = [];
  closed = false;
  #ice: ((candidate: string | null) => void) | null = null;
  #data: ((channel: RTCDataChannelPort) => void) | null = null;

  createOffer(): Promise<string> { return Promise.resolve(localSDP); }
  createAnswer(): Promise<string> { return Promise.resolve(localSDP); }
  setLocalDescription(description: string): Promise<void> { this.local = description; return Promise.resolve(); }
  setRemoteDescription(description: string): Promise<void> { this.remote = description; return Promise.resolve(); }
  addIceCandidate(candidate: string): Promise<void> { this.candidates.push(candidate); return Promise.resolve(); }
  close(): void { this.closed = true; }
  onIceCandidate(listener: (candidate: string | null) => void): void { this.#ice = listener; }
  createDataChannel(label: string): RTCDataChannelPort { return new FakeChannel(label); }
  onDataChannel(listener: (channel: RTCDataChannelPort) => void): void { this.#data = listener; }
  emitCandidate(candidate: string): void { this.#ice?.(candidate); }
  emitDataChannel(channel: RTCDataChannelPort): void { this.#data?.(channel); }
}

class FakeChannel implements RTCDataChannelPort {
  binaryType: "arraybuffer" | "blob" = "blob";
  closed = false;
  constructor(
    readonly label: string,
    readonly ordered: boolean = true,
    readonly negotiated: boolean = false,
    readonly maxPacketLifeTime: number | null = null,
    readonly maxRetransmits: number | null = null
  ) {}
  send(bytes: Uint8Array): void { void bytes; }
  onMessage(listener: (data: unknown) => void): void { void listener; }
  close(): void { this.closed = true; }
}

void test("RTC session controller permits an offer only after live peer capability and binds an answer", async () => {
  const connections: FakeConnection[] = [];
  const sent: RTCSignal[] = [];
  let now = 1_000;
  const controller = new RTCSessionController({
    localPeerId: localPeer,
    now: () => now,
    newSessionId: () => "AQEBAQEBAQEBAQEBAQEBAQ",
    createConnection: () => { const connection = new FakeConnection(); connections.push(connection); return connection; },
    sendSignal: (_peer, signal) => { sent.push(signal); return Promise.resolve(); }
  });
  assert.equal(await controller.start(remotePeer), false);
  assert.equal(controller.acceptCapabilities(remotePeer, { version: rtcSignalingVersion, maxDescriptionBytes: 1536, maxCandidateBytes: 1024, maxCandidatesPerDirection: 32 }, now + 10_000), true);
  assert.equal(await controller.start(remotePeer), true);
  const offerSignal = sent[0];
  if (offerSignal === undefined || offerSignal.kind !== rtcOfferControlKind) assert.fail("missing offer");
  const offer = offerSignal.body;
  const activeConnection = connections[0];
  if (activeConnection === undefined) throw new Error("missing peer connection");
  const answerDescriptionSHA256 = await rtcDescriptionSHA256(remoteSDP);
  const earlyCandidate: RTCSignal = {
    kind: rtcCandidateControlKind,
    body: {
      version: rtcSignalingVersion,
      rtcSessionId: offer.rtcSessionId,
      generation: 0,
      direction: "answerer",
      descriptionSHA256: answerDescriptionSHA256,
      candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host"
    }
  };
  // Live WSS signaling does not make an answer and its first candidate one
  // atomic delivery. A candidate that beats the answer is staged, not lost.
  assert.equal(await controller.receive(remotePeer, earlyCandidate), "accepted");
  assert.deepEqual(activeConnection.candidates, []);
  assert.equal(await controller.receive(remotePeer, {
    kind: rtcAnswerControlKind,
    body: { version: rtcSignalingVersion, rtcSessionId: offer.rtcSessionId, generation: 0, description: remoteSDP, descriptionSHA256: answerDescriptionSHA256, dtlsFingerprintSHA256: extractDTLSFingerprintSHA256(remoteSDP), offerDescriptionSHA256: offer.descriptionSHA256 }
  }), "accepted");
  assert.equal(connections[0]?.remote, remoteSDP);
  assert.deepEqual(activeConnection.candidates, ["candidate:1 1 UDP 1 192.0.2.1 9 typ host"]);
  connections[0].emitCandidate("candidate:1 1 UDP 1 192.0.2.1 9 typ host");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[1]?.kind, rtcCandidateControlKind);
  now += 20_000;
  assert.equal(await controller.start(remotePeer), false);
});

void test("RTC session controller rejects a malformed fingerprint before Browser API effects", async () => {
  let created = 0;
  const controller = new RTCSessionController({
    localPeerId: remotePeer,
    newSessionId: () => "AQEBAQEBAQEBAQEBAQEBAQ",
    createConnection: () => { created += 1; return new FakeConnection(); },
    sendSignal: () => Promise.resolve()
  });
  const descriptionSHA256 = await rtcDescriptionSHA256("v=0\r\na=fingerprint:sha-1 01:02\r\n");
  const offer: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: "AQEBAQEBAQEBAQEBAQEBAQ", generation: 0, description: "v=0\r\na=fingerprint:sha-1 01:02\r\n", descriptionSHA256, dtlsFingerprintSHA256: extractDTLSFingerprintSHA256(localSDP) };
  assert.equal(await controller.receive(localPeer, { kind: rtcOfferControlKind, body: offer }), "rejected");
  assert.equal(created, 0);
});

void test("RTC glare has one deterministic winner and duplicate remote candidates do not reach the browser twice", async () => {
  const connection = new FakeConnection();
  const controller = new RTCSessionController({
    localPeerId: localPeer,
    newSessionId: () => "AQEBAQEBAQEBAQEBAQEBAQ",
    createConnection: () => connection,
    sendSignal: () => Promise.resolve()
  });
  controller.acceptCapabilities(remotePeer, { version: rtcSignalingVersion, maxDescriptionBytes: 1536, maxCandidateBytes: 1024, maxCandidatesPerDirection: 32 }, Date.now() + 10_000);
  await controller.start(remotePeer);
  const remoteDescriptionSHA256 = await rtcDescriptionSHA256(remoteSDP);
  const remoteOffer: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: "AgICAgICAgICAgICAgICAg", generation: 0, description: remoteSDP, descriptionSHA256: remoteDescriptionSHA256, dtlsFingerprintSHA256: extractDTLSFingerprintSHA256(remoteSDP) };
  assert.equal(await controller.receive(remotePeer, { kind: rtcOfferControlKind, body: remoteOffer }), "ignored");
  const localOfferDescriptionSHA256 = await rtcDescriptionSHA256(localSDP);
  const answerDescriptionSHA256 = await rtcDescriptionSHA256(remoteSDP);
  assert.equal(await controller.receive(remotePeer, { kind: rtcAnswerControlKind, body: { version: rtcSignalingVersion, rtcSessionId: "AQEBAQEBAQEBAQEBAQEBAQ", generation: 0, description: remoteSDP, descriptionSHA256: answerDescriptionSHA256, dtlsFingerprintSHA256: extractDTLSFingerprintSHA256(remoteSDP), offerDescriptionSHA256: localOfferDescriptionSHA256 } }), "accepted");
  const candidate: RTCSignal = { kind: rtcCandidateControlKind, body: { version: rtcSignalingVersion, rtcSessionId: "AQEBAQEBAQEBAQEBAQEBAQ", generation: 0, direction: "answerer", descriptionSHA256: answerDescriptionSHA256, candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host" } };
  assert.equal(await controller.receive(remotePeer, candidate), "accepted");
  assert.equal(await controller.receive(remotePeer, candidate), "duplicate");
  assert.deepEqual(connection.candidates, ["candidate:1 1 UDP 1 192.0.2.1 9 typ host"]);
});

void test("RTC session accepts only the D95 reliable binary channel profile", async () => {
  const connection = new FakeConnection();
  const published: RTCDataChannelPort[] = [];
  const controller = new RTCSessionController({
    localPeerId: remotePeer,
    newSessionId: () => "AQEBAQEBAQEBAQEBAQEBAQ",
    createConnection: () => connection,
    sendSignal: () => Promise.resolve(),
    onDataChannel: (session) => { published.push(session.channel); }
  });
  const remoteDescriptionSHA256 = await rtcDescriptionSHA256(remoteSDP);
  const offer: RtcOffer = { version: rtcSignalingVersion, rtcSessionId: "AQEBAQEBAQEBAQEBAQEBAQ", generation: 0, description: remoteSDP, descriptionSHA256: remoteDescriptionSHA256, dtlsFingerprintSHA256: extractDTLSFingerprintSHA256(remoteSDP) };
  const channel = new FakeChannel(rtcDataChannelLabel);
  assert.equal(await controller.receive(localPeer, { kind: rtcOfferControlKind, body: offer }), "accepted");
  connection.emitDataChannel(channel);
  assert.equal(channel.binaryType, "arraybuffer");
  // The answerer must publish the browser-delivered channel as well as the
  // offerer's locally created channel, otherwise DATA/ADMIT stays inert.
  assert.deepEqual(published, [channel]);
  const extra = new FakeChannel(rtcDataChannelLabel);
  connection.emitDataChannel(extra);
  assert.equal(extra.closed, true);
  const invalid = new FakeChannel("other");
  connection.emitDataChannel(invalid);
  assert.equal(invalid.closed, true);
});
