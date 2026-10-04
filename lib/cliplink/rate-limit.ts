import { Ratelimit } from "@upstash/ratelimit";

import {
  CLIP_RATE_LIMIT,
  ERASE_RATE_LIMIT,
  ROOM_CREATE_RATE_LIMIT,
} from "@/lib/cliplink/constants";
import { getRedis } from "@/lib/cliplink/redis";

/**
 * A token bucket: `burst` tokens to spend at once, refilled at
 * `refillTokens` per `refillSeconds`. One request costs one token.
 */
export type RateLimitConfig = {
  burst: number;
  refillTokens: number;
  refillSeconds: number;
};

export type RateLimitResult = {
  ok: boolean;
  retryAfterSeconds: number;
};

type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

/**
 * Beyond this the in-memory store is swept of buckets that have refilled to
 * full. Only the single-process fallback keeps buckets in memory, but it still
 * sees one entry per client, and nothing else ever removed them.
 */
const MEMORY_BUCKET_CAP = 10_000;

declare global {
  var __cliplinkRateLimitStores: Map<string, Map<string, Bucket>> | undefined;
  var __cliplinkRatelimiters: Map<string, Ratelimit> | undefined;
}

function refillPerSecond(config: RateLimitConfig) {
  return config.refillTokens / config.refillSeconds;
}

function getMemoryStore(name: string) {
  const stores = (globalThis.__cliplinkRateLimitStores ??= new Map());
  let store = stores.get(name);
  if (!store) {
    store = new Map<string, Bucket>();
    stores.set(name, store);
  }
  return store;
}

/** Drops buckets that have refilled to full, which hold no more than absence. */
function sweep(store: Map<string, Bucket>, config: RateLimitConfig, now: number) {
  const rate = refillPerSecond(config);
  for (const [key, bucket] of store) {
    const elapsedSeconds = (now - bucket.lastRefillMs) / 1000;
    if (bucket.tokens + elapsedSeconds * rate >= config.burst) {
      store.delete(key);
    }
  }
}

function checkMemory(
  name: string,
  config: RateLimitConfig,
  key: string,
): RateLimitResult {
  const store = getMemoryStore(name);
  const now = Date.now();

  if (store.size > MEMORY_BUCKET_CAP) {
    sweep(store, config, now);
  }

  const rate = refillPerSecond(config);
  const current = store.get(key);
  // Tokens accrue against the clock rather than on a schedule, so an unseen
  // bucket needs no timer to have caught up by the time it is read again.
  const tokens = current
    ? Math.min(
        config.burst,
        current.tokens + ((now - current.lastRefillMs) / 1000) * rate,
      )
    : config.burst;

  if (tokens < 1) {
    store.set(key, { tokens, lastRefillMs: now });
    return { ok: false, retryAfterSeconds: Math.ceil((1 - tokens) / rate) };
  }

  store.set(key, { tokens: tokens - 1, lastRefillMs: now });
  return { ok: true, retryAfterSeconds: 0 };
}

function getRatelimiter(name: string, config: RateLimitConfig): Ratelimit | null {
  const redis = getRedis();
  if (!redis) {
    return null;
  }

  const limiters = (globalThis.__cliplinkRatelimiters ??= new Map());
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.tokenBucket(
        config.refillTokens,
        `${config.refillSeconds} s`,
        config.burst,
      ),
      // Distinct per limiter, so the clip and room-creation buckets for one
      // caller never share a key.
      prefix: `cliplink:ratelimit:${name}`,
    });
    limiters.set(name, limiter);
  }

  return limiter;
}

export function getClientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * One limiter, backed by a bucket shared across every instance when Redis is
 * configured and a process-local one when it is not. The fallback is per
 * process and so is only as strict as the instance count, which is the price
 * of booting with no credentials at all.
 */
function createLimiter(name: string, config: RateLimitConfig) {
  return {
    async check(key: string): Promise<RateLimitResult> {
      const limiter = getRatelimiter(name, config);
      if (!limiter) {
        return checkMemory(name, config, key);
      }

      try {
        const result = await limiter.limit(key);
        if (result.success) {
          return { ok: true, retryAfterSeconds: 0 };
        }

        return {
          ok: false,
          retryAfterSeconds: Math.max(
            0,
            Math.ceil((result.reset - Date.now()) / 1000),
          ),
        };
      } catch (error) {
        // Failing open is deliberate: a limiter that cannot reach Redis must
        // not become the reason the app stops answering.
        console.error(`Rate limit check failed (${name}), failing open`, error);
        return { ok: true, retryAfterSeconds: 0 };
      }
    },
  };
}

export const clipRateLimit = createLimiter("clips", CLIP_RATE_LIMIT);
export const roomCreateRateLimit = createLimiter("rooms", ROOM_CREATE_RATE_LIMIT);
export const eraseRateLimit = createLimiter("erase", ERASE_RATE_LIMIT);
