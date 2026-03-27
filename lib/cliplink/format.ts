export function formatHistoryTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatCharCount(length: number) {
  return `${length.toLocaleString()} char${length === 1 ? "" : "s"}`;
}

export function truncatePreview(text: string, maxLength = 120) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
