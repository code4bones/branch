import { CheckOutlined, CloseOutlined, InboxOutlined } from "@ant-design/icons";
import { Button, Empty, List, Space, Typography } from "antd";
import { useNavigate } from "react-router-dom";

import { DetailHeader } from "../app/DetailHeader.js";
import { chatPath } from "../app/paths.js";
import { useIncomingMessageRequests } from "../state/hooks.js";

export function MessageRequestsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const requests = useIncomingMessageRequests();

  const accept = (requestId: string): void => {
    const contactId = requests.acceptMessageRequest(requestId);
    if (contactId !== null) {
      void navigate(chatPath(contactId));
    }
  };

  return (
    <section className="pwa-message-requests" aria-label="Message requests">
      <DetailHeader avatar={<InboxOutlined />} title="Message requests" />
      {requests.requests.length === 0 ? (
        <Empty description="No incoming requests" />
      ) : (
        <List
          dataSource={requests.requests.slice().sort((left, right) => right.receivedAt - left.receivedAt)}
          renderItem={(request) => (
            <List.Item
              actions={[
                <Button icon={<CheckOutlined />} key="accept" onClick={() => { accept(request.requestId); }} type="primary">Accept</Button>,
                <Button icon={<CloseOutlined />} key="dismiss" onClick={() => { requests.dismissMessageRequest(request.requestId); }}>Dismiss</Button>
              ]}
            >
              <List.Item.Meta
                description={request.senderPeerId.slice(0, 18)}
                title={request.senderDisplayName}
              />
              <Typography.Paragraph className="pwa-message-request-body" ellipsis={{ rows: 3 }}>{request.body}</Typography.Paragraph>
            </List.Item>
          )}
        />
      )}
      {requests.requests.length > 0 && <Space className="pwa-message-requests-note" direction="vertical"><Typography.Text type="secondary">Accepting saves this peer and its reply key only on this device.</Typography.Text></Space>}
    </section>
  );
}
