import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationControlSigningBytes,
  applicationControlWireVersion,
  encodeApplicationControl,
  encodeBase64URL,
  encodeRtcCapabilities,
  rtcCapabilitiesControlKind,
  rtcSignalingVersion,
  SameRelayTransportClient
} from "@code4bones/branch-core";

import { RTCSignalingControlRuntime } from "../src/connectivity/rtc-signaling-control.js";

void test("RTC signaling ingress releases only canonical signed controls for the relay-authenticated known peer", async () => {
  const [sender, recipient] = await Promise.all([SameRelayTransportClient.createIdentity(), SameRelayTransportClient.createIdentity()]);
  const now = 50_000;
  const wire = await signedCapabilities(sender, recipient.peerId, now);
  const runtime = new RTCSignalingControlRuntime();
  const input = { plaintext: wire, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "known", now };
  const accepted = await runtime.receive(input);
  assert.equal(accepted.handled, true);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.kind, rtcCapabilitiesControlKind);
  assert.deepEqual(accepted.body, { version: rtcSignalingVersion, maxDescriptionBytes: 1536, maxCandidateBytes: 1024, maxCandidatesPerDirection: 32 });
  assert.deepEqual(await runtime.receive(input), { handled: true, outcome: "replay" });
});

void test("RTC signaling ingress rejects bad provenance and never claims unknown application controls", async () => {
  const [sender, recipient, stranger] = await Promise.all([SameRelayTransportClient.createIdentity(), SameRelayTransportClient.createIdentity(), SameRelayTransportClient.createIdentity()]);
  const now = 50_000;
  const wire = await signedCapabilities(sender, recipient.peerId, now);
  assert.deepEqual(await new RTCSignalingControlRuntime().receive({ plaintext: wire, localPeerId: recipient.peerId, senderPeerId: stranger.peerId, knownContactId: "known", now }), { handled: true, outcome: "unknown_contact" });
  assert.deepEqual(await new RTCSignalingControlRuntime().receive({ plaintext: wire, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: null, now }), { handled: true, outcome: "unknown_contact" });
  const unknown = encodeApplicationControl({
    version: applicationControlWireVersion,
    kind: "branch.unknown/0.draft",
    controlId: encodeBase64URL(new Uint8Array(16).fill(7)),
    issuedAt: now,
    expiresAt: now + 1_000,
    senderPeerId: sender.peerId,
    recipientPeerId: recipient.peerId,
    body: new Uint8Array([1]),
    signature: new Uint8Array(64)
  });
  assert.deepEqual(await new RTCSignalingControlRuntime().receive({ plaintext: unknown, localPeerId: recipient.peerId, senderPeerId: sender.peerId, knownContactId: "known", now }), { handled: false });
});

async function signedCapabilities(
  sender: Awaited<ReturnType<typeof SameRelayTransportClient.createIdentity>>,
  recipientPeerId: string,
  now: number
): Promise<Uint8Array> {
  const unsigned = {
    version: applicationControlWireVersion,
    kind: rtcCapabilitiesControlKind,
    controlId: encodeBase64URL(new Uint8Array(16).fill(9)),
    issuedAt: now,
    expiresAt: now + 60_000,
    senderPeerId: sender.peerId,
    recipientPeerId,
    body: await encodeRtcCapabilities({ version: rtcSignalingVersion, maxDescriptionBytes: 1536, maxCandidateBytes: 1024, maxCandidatesPerDirection: 32 })
  };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", sender.privateKey, arrayBuffer(applicationControlSigningBytes(unsigned))));
  return encodeApplicationControl({ ...unsigned, signature });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
