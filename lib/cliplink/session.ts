const SENDER_KEY = "cliplink:sender-id";

function createSenderId() {
  const prefix = Date.now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}${suffix}`;
}

export function getSessionSenderId() {
  if (typeof window === "undefined") {
    return createSenderId();
  }

  const existing = window.sessionStorage.getItem(SENDER_KEY);
  if (existing) {
    return existing;
  }

  const next = createSenderId();
  window.sessionStorage.setItem(SENDER_KEY, next);
  return next;
}
