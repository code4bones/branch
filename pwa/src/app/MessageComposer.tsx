import { SendOutlined } from "@ant-design/icons";
import { Button, Input, Space, Tooltip } from "antd";

export function MessageComposer({ value, onChange, onSend, onTyping, placeholder }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onTyping?: () => void;
  readonly placeholder: string;
}): React.JSX.Element {
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
      return;
    }
    event.preventDefault();
    onSend();
  };

  return (
    <Space.Compact className="pwa-chat-composer">
      <Input.TextArea
        autoSize={{ minRows: 1, maxRows: 5 }}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          if (event.currentTarget.value.trim() !== "") {
            onTyping?.();
          }
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        value={value}
      />
      <Tooltip title="Send message">
        <Button aria-label="Send message" icon={<SendOutlined />} onClick={onSend} type="primary" />
      </Tooltip>
    </Space.Compact>
  );
}
