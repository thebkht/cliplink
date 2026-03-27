import {
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/cliplink/constants";

type WindowState = {
  count: number;
  resetAt: number;
};

declare global {
  var __cliplinkRateLimit:
    | Map<string, WindowState>
    | undefined;
}

function getRateLimitStore() {
  if (!globalThis.__cliplinkRateLimit) {
    globalThis.__cliplinkRateLimit = new Map<string, WindowState>();
  }

  return globalThis.__cliplinkRateLimit;
}

export function getClientIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function checkRateLimit(key: string) {
  const store = getRateLimitStore();
  const now = Date.now();
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return {
      ok: true,
      retryAfterSeconds: 0,
    };
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
    };
  }

  current.count += 1;
  return {
    ok: true,
    retryAfterSeconds: 0,
  };
}
