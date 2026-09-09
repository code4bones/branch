import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationControlSigningBytes,
  createApplicationControlRegistry,
  encodeApplicationControl,
  prepareOutboundApplicationControl,
  processApplicationControl,
  type ApplicationControlDescriptor,
  type ApplicationControlEnvelope,
  type ApplicationControlPorts
} from "../src/application-control/runtime.js";
import { encodeBase64URL } from "../src/protocol/v0/base64url.js";

const alicePeerId = token(32, 1);
const bobPeerId = token(32, 2);
const controlId = token(16, 3);
const now = 1_700_000_000_000;

const typingDescriptor: ApplicationControlDescriptor<{ readonly active: boolean }> = {
  kind: "branch.pwa.typing/0.draft",
  authentication: "ed25519",
  maximumTTLms: 8_000,
  projection: "ephemeral",
  allowedEffects: ["ephemeral_projection"],
  decodeBody: (bytes) => {
    const active = new TextDecoder().decode(bytes);
    if (active !== "typing") {
      throw new Error("invalid typing body");
    }
    return { active: true };
  },
  encodeBody: (body) => {
    if (!body.active) {
      throw new Error("typing must be active");
    }
    return new TextEncoder().encode("typing");
  },
  reduce: ({ envelope }) => [{
    kind: "ephemeral_projection",
    projection: "typing",
    value: new TextEncoder().encode("active"),
    expiresAt: envelope.expiresAt
  }]
};

test("application-control accepts a known signed canonical control exactly once", async () => {
  const unsigned = prepareOutboundApplicationControl({
    kind: typingDescriptor.kind,
    controlId,
    issuedAt: now - 500,
    expiresAt: now + 5_000,
    senderPeerId: alicePeerId,
    recipientPeerId: bobPeerId,
    body: { active: true }
  }, typingDescriptor, makeOutboundPorts());
  const envelope: ApplicationControlEnvelope = { ...unsigned, signature: new Uint8Array(64).fill(7) };
  const seen = new Set<string>();
  let signatureInput: Uint8Array | null = null;
  const ports = makePorts(seen, async (_peerId, input, signature) => {
    signatureInput = input;
    return signature.byteLength === 64;
  });
  const registry = createApplicationControlRegistry([typingDescriptor]);

  const accepted = await processApplicationControl(encodeApplicationControl(envelope), registry, ports);
  assert.deepEqual(accepted, {
    status: "accepted",
    effects: [{
      kind: "ephemeral_projection",
      projection: "typing",
      value: new TextEncoder().encode("active"),
      expiresAt: now + 5_000
    }]
  });
  assert.deepEqual(signatureInput, applicationControlSigningBytes(envelope));
  assert.equal(seen.has(controlId), true);

  assert.deepEqual(await processApplicationControl(encodeApplicationControl(envelope), registry, ports), {
    status: "rejected",
    reason: "replay"
  });
});

test("application-control rejects recipient mismatch, expiry, invalid signatures and malformed bytes before effects", async () => {
  const registry = createApplicationControlRegistry([typingDescriptor]);
  const unsigned = prepareOutboundApplicationControl({
    kind: typingDescriptor.kind,
    controlId,
    issuedAt: now - 500,
    expiresAt: now + 5_000,
    senderPeerId: alicePeerId,
    recipientPeerId: bobPeerId,
    body: { active: true }
  }, typingDescriptor, makeOutboundPorts());
  const envelope: ApplicationControlEnvelope = { ...unsigned, signature: new Uint8Array(64).fill(7) };

  assert.deepEqual(await processApplicationControl(encodeApplicationControl(envelope), registry, {
    ...makePorts(new Set(), async () => true),
    localPeerId: alicePeerId
  }), { status: "rejected", reason: "recipient_mismatch" });
  assert.deepEqual(await processApplicationControl(encodeApplicationControl(envelope), registry, makePorts(new Set(), async () => false)), {
    status: "rejected", reason: "signature_invalid"
  });
  assert.deepEqual(await processApplicationControl(new Uint8Array([0xff]), registry, makePorts(new Set(), async () => true)), {
    status: "rejected", reason: "malformed"
  });
  const expired: ApplicationControlEnvelope = { ...envelope, expiresAt: now };
  assert.deepEqual(await processApplicationControl(encodeApplicationControl(expired), registry, makePorts(new Set(), async () => true)), {
    status: "rejected", reason: "expired"
  });
});

test("application-control rejects a descriptor reducer effect outside its declared closed set", async () => {
  const unsafeDescriptor: ApplicationControlDescriptor<{ readonly active: boolean }> = {
    ...typingDescriptor,
    allowedEffects: [],
    reduce: ({ envelope }) => [{
      kind: "ephemeral_projection",
      projection: "typing",
      value: new TextEncoder().encode("active"),
      expiresAt: envelope.expiresAt
    }]
  };
  const unsigned = prepareOutboundApplicationControl({
    kind: unsafeDescriptor.kind,
    controlId,
    issuedAt: now - 500,
    expiresAt: now + 5_000,
    senderPeerId: alicePeerId,
    recipientPeerId: bobPeerId,
    body: { active: true }
  }, unsafeDescriptor, makeOutboundPorts());
  const envelope: ApplicationControlEnvelope = { ...unsigned, signature: new Uint8Array(64).fill(7) };

  assert.deepEqual(await processApplicationControl(
    encodeApplicationControl(envelope),
    createApplicationControlRegistry([unsafeDescriptor]),
    makePorts(new Set(), async () => true)
  ), { status: "rejected", reason: "effect_forbidden" });
});

test("application-control preserves declared validated effect order", async () => {
  const descriptor: ApplicationControlDescriptor<{ readonly active: boolean }> = {
    ...typingDescriptor,
    allowedEffects: ["message_metadata", "ephemeral_projection"],
    reduce: ({ envelope }) => [
      { kind: "message_metadata", deliveryId: token(16, 9), state: "typing_observed" },
      { kind: "ephemeral_projection", projection: "typing", value: new TextEncoder().encode("active"), expiresAt: envelope.expiresAt }
    ]
  };
  const unsigned = prepareOutboundApplicationControl({
    kind: descriptor.kind,
    controlId,
    issuedAt: now - 500,
    expiresAt: now + 5_000,
    senderPeerId: alicePeerId,
    recipientPeerId: bobPeerId,
    body: { active: true }
  }, descriptor, makeOutboundPorts());
  const result = await processApplicationControl(
    encodeApplicationControl({ ...unsigned, signature: new Uint8Array(64).fill(7) }),
    createApplicationControlRegistry([descriptor]),
    makePorts(new Set(), async () => true)
  );

  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.deepEqual(result.effects.map((effect) => effect.kind), ["message_metadata", "ephemeral_projection"]);
  }
});

function makePorts(seen: Set<string>, verifyEd25519: ApplicationControlPorts["verifyEd25519"]): ApplicationControlPorts {
  return {
    now,
    localPeerId: bobPeerId,
    isKnownContact: (peerId) => peerId === alicePeerId,
    verifyEd25519,
    hasSeenControl: (id) => seen.has(id),
    rememberControl: (id) => { seen.add(id); },
    isAllowed: () => true,
    maxClockSkewMs: 1_000
  };
}

function makeOutboundPorts() {
  return {
    now,
    localPeerId: alicePeerId,
    isKnownContact: (peerId: string) => peerId === bobPeerId,
    isAllowed: () => true,
    consumeRateLimit: () => true,
    maxClockSkewMs: 1_000
  };
}

function token(size: number, fill: number): string {
  return encodeBase64URL(new Uint8Array(size).fill(fill));
}
