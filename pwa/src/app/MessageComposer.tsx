import { SendOutlined } from "@ant-design/icons";
import { Button, Input, Space, Tooltip } from "antd";

export function MessageComposer({ value, onChange, onSend, onTyping, placeholder }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onTyping?: () => void;
  readonly placeholder: string;
}): React.JSX.Element {
  return (
    <Space.Compact className="pwa-chat-composer">
      <Input
        onChange={(event) => {
          onChange(event.currentTarget.value);
          if (event.currentTarget.value.trim() !== "") {
            onTyping?.();
          }
        }}
        onPressEnter={onSend}
        placeholder={placeholder}
        value={value}
      />
      <Tooltip title="Send message">
        <Button aria-label="Send message" icon={<SendOutlined />} onClick={onSend} type="primary" />
      </Tooltip>
    </Space.Compact>
  );
}
