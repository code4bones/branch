import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { traceCategory } from "../src/app/PocDebugPanel.js";
import { maximumPocBurstMessages, PocBurstRunner, type PocBurstTimerPort } from "../src/app/poc-burst.js";

void test("PoC burst is explicitly bounded, sequential, and has no hidden retry path", () => {
  const timers = new Timers();
  const runner = new PocBurstRunner(timers);
  const emitted: number[] = [];
  const progress: string[] = [];

  assert.equal(runner.start(4, (index) => { emitted.push(index); }, (next) => { progress.push(`${String(next.sent)}/${String(next.total)}/${String(next.running)}`); }), true);
  assert.deepEqual(emitted, [1]);
  timers.runNext();
  timers.runNext();
  timers.runNext();
  assert.deepEqual(emitted, [1, 2, 3, 4]);
  assert.equal(runner.running, false);
  assert.deepEqual(progress.at(-1), "4/4/false");
  assert.equal(runner.start(maximumPocBurstMessages + 1, () => undefined, () => undefined), false);
});

void test("stopping a PoC burst cancels only future local pacing", () => {
  const timers = new Timers();
  const runner = new PocBurstRunner(timers);
  const emitted: number[] = [];
  assert.equal(runner.start(4, (index) => { emitted.push(index); }, () => undefined), true);
  runner.stop();
  timers.runAll();
  assert.deepEqual(emitted, [1]);
  assert.equal(runner.running, false);
});

void test("chat exposes the floating PoC panel while compact CSS keeps it out of mobile chat", async () => {
  const [chat, css] = await Promise.all([
    readFile(resolve(process.cwd(), "src/pages/ChatPage.tsx"), "utf8"),
    readFile(resolve(process.cwd(), "public/pwa.css"), "utf8")
  ]);
  assert.match(chat, /<PocDebugPanel/);
  assert.match(chat, /sendPocBurstMessage/);
  assert.match(css, /\.pwa-poc-debug \{[\s\S]*position: absolute/);
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*\.pwa-poc-debug \{ display: none; \}/);
});

void test("PoC trace categories keep semantic diagnostics visible without raw frame noise", () => {
  assert.equal(traceCategory("outbound frame: ENVELOPE"), "frames");
  assert.equal(traceCategory("incoming envelope: opened"), "frames");
  assert.equal(traceCategory("incoming envelope: message"), "messages");
  assert.equal(traceCategory("incoming envelope: presence_pong"), "presence");
  assert.equal(traceCategory("delivery receipt: read_matched"), "receipts");
  assert.equal(traceCategory("outbox: retry_sent"), "outbox");
  assert.equal(traceCategory("application capabilities: accepted"), "controls");
  assert.equal(traceCategory("relay notice: peer unavailable"), "transport");
});

class Timers implements PocBurstTimerPort {
  readonly callbacks: Array<() => void> = [];

  schedule(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }

  cancel(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  }

  runNext(): void {
    const callback = this.callbacks.shift();
    if (callback === undefined) throw new Error("expected scheduled burst item");
    callback();
  }

  runAll(): void {
    while (this.callbacks.length > 0) this.runNext();
  }
}
