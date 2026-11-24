// ─── Helpers for the support chat UI ────────────────────────────────────────

export function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('ar-SA', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ─── Message Parsing Helper ──

export function parseMessageContent(raw: string) {
  const imageRegex = /\[IMAGE\]([\s\S]*?)\[\/IMAGE\]/;
  const match = raw.match(imageRegex);
  if (match) {
    const imageUrl = match[1].trim();
    const textContent = raw.replace(imageRegex, '').trim();
    return { imageUrl, textContent };
  }
  return { imageUrl: null, textContent: raw };
}
