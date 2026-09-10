import assert from "node:assert/strict";
import test from "node:test";

import { ContactDiscoveryScheduler } from "../src/connectivity/contact-discovery-scheduler.js";

test("contact discovery schedules again only after the previous attempt settles", async () => {
  const scheduler = new ContactDiscoveryScheduler();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  scheduler.start({ now: () => 0, nextDelay: () => attempts < 2 ? 0 : null, attempt: async () => { attempts += 1; if (attempts === 1) await pending; } });
  await tick();
  assert.equal(attempts, 1);
  await tick();
  assert.equal(attempts, 1);
  release();
  await tick(); await tick();
  assert.equal(attempts, 2);
  scheduler.stop();
});

test("stopping invalidates a late completion before it can schedule another attempt", async () => {
  const scheduler = new ContactDiscoveryScheduler();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  scheduler.start({ now: () => 0, nextDelay: () => 0, attempt: async () => { attempts += 1; await pending; } });
  await tick();
  scheduler.stop();
  release();
  await tick(); await tick();
  assert.equal(attempts, 1);
});

async function tick(): Promise<void> { await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); }
