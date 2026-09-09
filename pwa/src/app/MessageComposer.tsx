import { Button, Input, Space } from "antd";

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
      <Button onClick={onSend} type="primary">Send</Button>
    </Space.Compact>
  );
}
