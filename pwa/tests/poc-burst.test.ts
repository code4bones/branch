import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { purgeableOutboxMessageIds, traceBufferText, traceCategory } from "../src/app/PocDebugPanel.js";
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

void test("PoC trace clipboard text includes every already-sanitized local buffer entry", () => {
  const copied = traceBufferText([
    { at: 1_700_000_000_000, detail: "outbox: retry_sent" },
    { at: 1_700_000_001_000, detail: "delivery receipt: read_matched" }
  ]);

  assert.match(copied, /outbox: retry_sent/);
  assert.match(copied, /delivery receipt: read_matched/);
  assert.equal(copied.split("\n").length, 2);
});

void test("PoC panel derives outbox counts after selecting the stable store array", async () => {
  const panel = await readFile(resolve(process.cwd(), "src/app/PocDebugPanel.tsx"), "utf8");
  assert.match(panel, /useAppStore\(\(state\) => state\.outbox\)/);
  assert.match(panel, /useMemo\(\(\) => \{[\s\S]*localOutbox = outbox\.filter/);
  assert.doesNotMatch(panel, /useAppStore\(\(state\) => state\.outbox\.filter/);
});

void test("PoC purge targets only locally delivered records in the selected chat", () => {
  assert.deepEqual(purgeableOutboxMessageIds([
    { messageId: "delivered-here", contactId: "contact-1", deliveredAt: 1 },
    { messageId: "pending-here", contactId: "contact-1", deliveredAt: null },
    { messageId: "delivered-elsewhere", contactId: "contact-2", deliveredAt: 1 }
  ], "contact-1"), ["delivered-here"]);
});

void test("PoC purge is explicitly labelled as dropping the local correlation, not marking Read", async () => {
  const panel = await readFile(resolve(process.cwd(), "src/app/PocDebugPanel.tsx"), "utf8");
  assert.match(panel, />Purge<\/Button>/);
  assert.match(panel, /signed Read will be shown as unmatched/);
  assert.match(panel, /delivery_mapping_purged/);
  assert.doesNotMatch(panel, /Purge mapping|Purge delivered/);
});

void test("PoC title provides an explicit local trace copy action with readable contrast", async () => {
  const [panel, css] = await Promise.all([
    readFile(resolve(process.cwd(), "src/app/PocDebugPanel.tsx"), "utf8"),
    readFile(resolve(process.cwd(), "public/pwa.css"), "utf8")
  ]);

  assert.match(panel, /aria-label="Copy local trace buffer"/);
  assert.match(panel, /navigator\.clipboard\.writeText\(traceBufferText\(transportTrace\)\)/);
  assert.match(panel, /disabled=\{transportTrace\.length === 0\}/);
  assert.match(panel, /className="pwa-poc-debug-endpoint"><dd title=\{attachedRelayEndpoint/);
  assert.doesNotMatch(panel, /<dt>Attached<\/dt>/);
  assert.match(css, /\.pwa-poc-debug-heading\s*\{[\s\S]*color: var\(--pwa-ink\);/);
  assert.match(css, /\.pwa-poc-debug-copy \{ margin-left: auto; \}/);
  assert.match(css, /\.pwa-poc-debug-status \.pwa-poc-debug-endpoint\s*\{[\s\S]*grid-column: 1 \/ -1;[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
});

void test("PoC panel offers volatile opt-in client monitor control without storing a bearer", async () => {
  const [panel, monitor] = await Promise.all([
    readFile(resolve(process.cwd(), "src/app/PocDebugPanel.tsx"), "utf8"),
    readFile(resolve(process.cwd(), "src/app/client-monitor.ts"), "utf8")
  ]);
  assert.match(panel, /aria-label="Client monitor bearer"/);
  assert.match(panel, /Toggle client monitor/);
  assert.match(monitor, /const clientMonitorEndpoint = "\/node-admin\/client-monitor\/reports"/);
  assert.match(monitor, /keepalive: true/);
  assert.doesNotMatch(monitor, /localStorage|indexedDB|entry\.detail.*JSON\.stringify/);
});

void test("PoC reset chat is an explicit local test cleanup", async () => {
  const panel = await readFile(resolve(process.cwd(), "src/app/PocDebugPanel.tsx"), "utf8");
  assert.match(panel, /clearLocalConversation\(contactId\)/);
  assert.match(panel, /outbox: local_chat_reset/);
  assert.match(panel, /Reset local chat/);
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
