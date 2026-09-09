import { MessageOutlined } from "@ant-design/icons";
import { Typography } from "antd";

export function EmptyChatPane(): React.JSX.Element {
  return (
    <div className="pwa-empty-detail" aria-label="No chat selected">
      <MessageOutlined aria-hidden="true" />
      <Typography.Text type="secondary">Select a chat to start messaging</Typography.Text>
    </div>
  );
}
