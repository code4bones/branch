import { useEffect } from "react";

import { useContactTyping } from "../state/hooks.js";

export function ContactTyping({ contactId, variant = "header" }: { readonly contactId: string; readonly variant?: "header" | "list" }): React.JSX.Element | null {
  const { expiresAt, expireContactTyping } = useContactTyping(contactId);

  useEffect(() => {
    if (expiresAt === null) {
      return undefined;
    }
    const timer = setTimeout(() => { expireContactTyping(contactId, expiresAt); }, Math.max(0, expiresAt - Date.now()));
    return () => { clearTimeout(timer); };
  }, [contactId, expiresAt, expireContactTyping]);

  return expiresAt === null ? null : <span className={`pwa-contact-typing is-${variant}`} role="status">Typing...</span>;
}
