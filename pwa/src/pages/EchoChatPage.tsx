import { runEchoRoundTrip } from "@code4bones/branch-core";
import { RadarChartOutlined } from "@ant-design/icons";
import { useState } from "react";

import { DetailHeader } from "../app/DetailHeader.js";
import { MessageComposer } from "../app/MessageComposer.js";
import { MessageLog } from "../app/MessageLog.js";
import { ECHO_CONTACT_ID } from "../app/paths.js";
import { useConnection, useConversation, useMarkContactRead } from "../state/hooks.js";

// Beta Echo (D-BRANCH-040) is a self-addressed relay loopback: the sender is
// also the recipient. There is no fixed Echo peerId/hpkePublicKey and it is
// not a ContactSummary — it just reuses the ordinary message log under the
// reserved ECHO_CONTACT_ID so it looks and feels like any other chat.
export function EchoChatPage(): React.JSX.Element {
  const conversation = useConversation(ECHO_CONTACT_ID);
  const connection = useConnection();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  useMarkContactRead(ECHO_CONTACT_ID);

  const handleSend = (): void => {
    const body = draft.trim();
    if (body === "") {
      return;
    }
    setSendError(null);
    setLastResult(null);
    const outgoingMessageId = crypto.randomUUID();
    conversation.appendMessage({
      messageId: outgoingMessageId,
      contactId: ECHO_CONTACT_ID,
      direction: "outgoing",
      body,
      sentAt: Date.now(),
      deliveryState: "pending"
    });
    setDraft("");

    runEchoRoundTrip({ routes: connection.discoveredRoutes, body })
      .then((report) => {
        if (report.status === "ok") {
          conversation.setMessageDeliveryState(ECHO_CONTACT_ID, outgoingMessageId, "received");
          conversation.appendMessage({
            messageId: crypto.randomUUID(),
            contactId: ECHO_CONTACT_ID,
            direction: "incoming",
            body: report.body,
            sentAt: Date.now(),
            deliveryState: "received"
          });
          setLastResult(`via ${report.route.endpointUri} · ${String(report.latencyMs)}ms`);
          return;
        }
        conversation.setMessageDeliveryState(ECHO_CONTACT_ID, outgoingMessageId, "unavailable");
        const triedCount = report.attempts.length;
        setSendError(`Echo unavailable (${String(triedCount)} route${triedCount === 1 ? "" : "s"} tried)`);
      })
      .catch(() => {
        conversation.setMessageDeliveryState(ECHO_CONTACT_ID, outgoingMessageId, "unavailable");
        setSendError(`Echo unavailable (${String(connection.discoveredRoutes.length)} route${connection.discoveredRoutes.length === 1 ? "" : "s"} tried)`);
      });
  };

  return (
    <section className="pwa-chat" aria-label="Chat with Echo">
      <DetailHeader
        avatar={<span className="pwa-echo-avatar"><RadarChartOutlined /></span>}
        subtitle="Self-addressed relay check"
        title="Echo"
      />
      <MessageLog contactId={ECHO_CONTACT_ID} emptyDescription="Write to Echo to test your connection." messages={conversation.messages} />
      {lastResult !== null && <div className="pwa-chat-detail">{lastResult}</div>}
      {sendError !== null && <div className="pwa-chat-error">{sendError}</div>}
      <MessageComposer onChange={setDraft} onSend={handleSend} placeholder="Write to Echo…" value={draft} />
    </section>
  );
}
