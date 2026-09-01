export function downloadText(text: string, filename: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  downloadURL(url, filename);
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
}

export function downloadURL(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export async function copyTextFromFallback(text: string, fallback: HTMLTextAreaElement | null): Promise<void> {
  if (window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (fallback === null) {
    return;
  }
  fallback.value = text;
  fallback.focus();
  fallback.select();
  const legacyCopy = (document as unknown as Record<string, unknown>)["execCommand"];
  if (typeof legacyCopy === "function") {
    legacyCopy.call(document, "copy");
  }
}
