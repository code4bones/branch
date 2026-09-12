import { useEffect, useRef, useState } from "react";

import { pwaReleaseVersion } from "./pwa-release.js";
import type { TransportTraceEntry } from "../state/slices/transport-slice.js";

const clientMonitorEndpoint = "/node-admin/client-monitor/reports";
const maxBatchEvents = 24;
const maxPendingEvents = 48;
const minimumReportIntervalMs = 1000;

export type ClientMonitorCategory = "messages" | "presence" | "receipts" | "outbox" | "controls" | "transport" | "frames";
export type ClientMonitorEventName =
  | "receipt.read_expired" | "receipt.read_attempt_sent" | "receipt.read_skipped" | "receipt.read_failed" | "receipt.read_matched" | "receipt.read_unmatched"
  | "receipt.delivered_failed" | "receipt.delivered_sent" | "receipt.delivered_matched" | "receipt.delivered_unmatched"
  | "outbox.expired" | "outbox.retry_deferred" | "outbox.retry_sent"
  | "message.received" | "message.duplicate" | "message.request"
  | "transport.attached" | "transport.attach_failed" | "transport.relay_notice" | "transport.disconnected"
  | "frame.outbound" | "frame.incoming" | "control.capability" | "control.typing" | "control.rtc"
  | "poc.burst_started" | "poc.burst_queued" | "poc.rendezvous_sent" | "poc.rendezvous_failed";

export interface ClientMonitorEvent {
  readonly at: string;
  readonly category: ClientMonitorCategory;
  readonly event: ClientMonitorEventName;
}

interface ClientMonitorReport {
  readonly client_ref: string;
  readonly release: string;
  readonly events: readonly ClientMonitorEvent[];
}

// useClientMonitor is intentionally isolated from the transport. Reporting is
// best-effort developer tooling: a failed POST cannot add local trace entries,
// alter a relay session, or affect an application retry.
export function useClientMonitor(entries: readonly TransportTraceEntry[]): "ready" | "sending" | "sent" | "failed" {
  const [status, setStatus] = useState<"ready" | "sending" | "sent" | "failed">("ready");
  const [cycle, setCycle] = useState(0);
  const clientRef = useRef(newClientMonitorRef());
  const seen = useRef(new Set<string>());
  const pending = useRef<ClientMonitorEvent[]>([]);
  const sending = useRef(false);
  const lastSentAt = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const fresh = entries.flatMap((entry) => {
      const key = `${String(entry.at)}:${entry.detail}`;
      if (seen.current.has(key)) return [];
      seen.current.add(key);
      const event = clientMonitorEvent(entry);
      return event === null ? [] : [event];
    });
    if (fresh.length > 0) pending.current = [...pending.current, ...fresh].slice(-maxPendingEvents);
    if (pending.current.length === 0 || sending.current || timer.current !== null) {
      if (pending.current.length === 0) setStatus("ready");
      return;
    }
    setStatus("sending");
    const delay = Math.max(0, lastSentAt.current + minimumReportIntervalMs - Date.now());
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (sending.current || pending.current.length === 0) return;
      sending.current = true;
      const events = pending.current.splice(0, maxBatchEvents);
      const report: ClientMonitorReport = { client_ref: clientRef.current, release: pwaReleaseVersion, events };
      void fetch(clientMonitorEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
        keepalive: true
      }).then((response) => {
        setStatus(response.ok ? "sent" : "failed");
      }).catch(() => { setStatus("failed"); }).finally(() => {
        sending.current = false;
        lastSentAt.current = Date.now();
		setCycle((value) => value + 1);
      });
    }, delay);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [cycle, entries]);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return status;
}

// clientMonitorEvent deliberately maps trace text to a closed vocabulary. Do
// not add a fallback that posts `entry.detail`: it may contain diagnostics that
// do not belong in a centralized development view.
export function clientMonitorEvent(entry: TransportTraceEntry): ClientMonitorEvent | null {
  const event = clientMonitorEventName(entry.detail);
  if (event === null) return null;
  return { at: new Date(entry.at).toISOString(), category: clientMonitorCategory(event), event };
}

function clientMonitorEventName(detail: string): ClientMonitorEventName | null {
  const exact: Record<string, ClientMonitorEventName> = {
    "delivery receipt: read_expired": "receipt.read_expired",
    "delivery receipt: read_attempt_sent": "receipt.read_attempt_sent",
    "delivery receipt: read_skipped": "receipt.read_skipped",
    "delivery receipt: read_matched": "receipt.read_matched",
    "delivery receipt: read_unmatched": "receipt.read_unmatched",
    "delivery receipt: delivered_failed": "receipt.delivered_failed",
    "delivery receipt: delivered_sent": "receipt.delivered_sent",
    "delivery receipt: delivered_matched": "receipt.delivered_matched",
    "delivery receipt: delivered_unmatched": "receipt.delivered_unmatched",
    "outbox: expired": "outbox.expired",
    "outbox: retry_deferred": "outbox.retry_deferred",
    "outbox: retry_sent": "outbox.retry_sent",
    "incoming envelope: message": "message.received",
    "incoming envelope: duplicate message": "message.duplicate",
    "incoming envelope: message_request": "message.request",
    "incoming envelope: received": "frame.incoming",
    "incoming envelope: opened": "frame.incoming",
    "poc rendezvous: sent": "poc.rendezvous_sent",
    "poc rendezvous: failed": "poc.rendezvous_failed"
  };
  if (exact[detail] !== undefined) return exact[detail];
  if (detail.startsWith("delivery receipt: read_failed_")) return "receipt.read_failed";
  if (detail.startsWith("delivery receipt: delivered_")) return "receipt.delivered_sent";
  if (detail.startsWith("outbound frame:")) return "frame.outbound";
  if (detail.startsWith("attached:")) return "transport.attached";
  if (detail.startsWith("attach failed:")) return "transport.attach_failed";
  if (detail.startsWith("relay notice:")) return "transport.relay_notice";
  if (detail.startsWith("relay disconnected:")) return "transport.disconnected";
  if (detail.startsWith("typing control:")) return "control.typing";
  if (detail.startsWith("rtc ") || detail.startsWith("rtc signaling:")) return "control.rtc";
  if (detail.startsWith("application capabilities:") || detail.startsWith("image capabilities:")) return "control.capability";
  if (detail.startsWith("poc burst: started")) return "poc.burst_started";
  if (detail.startsWith("poc burst: queued")) return "poc.burst_queued";
  return null;
}

function clientMonitorCategory(event: ClientMonitorEventName): ClientMonitorCategory {
  if (event.startsWith("receipt.")) return "receipts";
  if (event.startsWith("outbox.")) return "outbox";
  if (event.startsWith("message.")) return "messages";
  if (event.startsWith("frame.")) return "frames";
  if (event.startsWith("control.")) return "controls";
  return "transport";
}

function newClientMonitorRef(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
