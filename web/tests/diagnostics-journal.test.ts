import test from "node:test";
import assert from "node:assert/strict";

import { DiagnosticJournal } from "@code4bones/branch-core/diagnostics/journal.js";

void test("diagnostic journal keeps only the newest bounded events", () => {
  let now = 1_000;
  const journal = new DiagnosticJournal({
    maxEvents: 2,
    maxAgeMs: 10_000,
    now: () => now
  });

  journal.record({ event: "application.started", mode: "operator" });
  now += 1;
  journal.record({ event: "discovery.started", mode: "operator" });
  now += 1;
  journal.record({ event: "route.selected", mode: "operator" });

  assert.deepEqual(
    journal.snapshot().map((event) => event.event),
    ["discovery.started", "route.selected"]
  );
});

void test("diagnostic journal expires old events", () => {
  let now = 1_000;
  const journal = new DiagnosticJournal({
    maxEvents: 10,
    maxAgeMs: 5,
    now: () => now
  });

  journal.record({ event: "application.started", mode: "operator" });
  now = 1_006;
  journal.record({ event: "route.selected", mode: "operator" });

  assert.deepEqual(
    journal.snapshot().map((event) => event.event),
    ["route.selected"]
  );
});

void test("diagnostic journal ignores off mode", () => {
  const journal = new DiagnosticJournal({
    maxEvents: 10,
    maxAgeMs: 10_000,
    now: () => 1_000
  });

  journal.record({ event: "application.started", mode: "off" });

  assert.equal(journal.snapshot().length, 0);
});

void test("manual export redacts forbidden diagnostic material", () => {
  const journal = new DiagnosticJournal({
    maxEvents: 10,
    maxAgeMs: 10_000,
    now: () => 1_000
  });

  journal.record({
    event: "discovery.started",
    mode: "diagnostic",
    attributes: [
      { key: "carrier", value: "https://example.test/private?q=payload" },
      { key: "transport", value: "192.0.2.55" },
      { key: "result", value: "ok" }
    ]
  });

  const exported = journal.createManualExport();

  assert.equal(exported.schema, "branch.diagnostics.export/0");
  assert.deepEqual(exported.events[0]?.attributes, [
    { key: "carrier", value: "[redacted]" },
    { key: "transport", value: "[redacted]" },
    { key: "result", value: "ok" }
  ]);
});

