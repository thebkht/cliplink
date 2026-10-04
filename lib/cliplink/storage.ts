import { MAX_ROOM_CLIPS, ROOM_TTL_SECONDS } from "@/lib/cliplink/constants";
import { getRedis } from "@/lib/cliplink/redis";
import { generateRoomCode } from "@/lib/cliplink/room-code";
import type {
  Clip,
  EraseClipsRequest,
  EraseClipsResponse,
  Room,
} from "@/lib/cliplink/types";

/**
 * A room as the server holds it. The erase fields stay off the shared `Room`
 * type on purpose: the check is never sent to a client, and keeping it out of
 * the type a response is built from is what makes sending it a type error.
 */
export type StoredRoom = Room & {
  /** Hash of the room's erase token, or null for a room that cannot delete. */
  eraseCheck: string | null;
  /** How many deletions have removed something. See `PollClipsResponse`. */
  eraseGen: number;
};

type EraseCheckSource = string | ((code: string) => Promise<string>);

function resolveEraseCheck(source: EraseCheckSource | undefined, code: string) {
  return typeof source === "function" ? source(code) : source;
}

type StorageAdapter = {
  /**
   * `eraseCheck` may be a function of the room code, for the one kind of room
   * whose check depends on a code that does not exist until this allocates it.
   */
  createRoom(
    ttlSeconds?: number,
    keyCheck?: string,
    eraseCheck?: EraseCheckSource,
  ): Promise<Room>;
  getRoom(code: string): Promise<StoredRoom | null>;
  appendClip(code: string, clip: Clip): Promise<Room | null>;
  getClipsAfter(
    code: string,
    afterId: number,
  ): Promise<{ clips: Clip[]; eraseGen: number } | null>;
  /**
   * Removes clips and counts the deletion. Like every read, and unlike
   * `appendClip`, it must not extend the room's TTL: taking things out of a
   * room is no reason for it to live longer.
   */
  eraseClips(
    code: string,
    request: EraseClipsRequest,
  ): Promise<EraseClipsResponse | null>;
  touchRoom(code: string): Promise<boolean>;
  /**
   * When the room expires, in epoch ms, or null if it is already gone. This is
   * a read: it must never extend the TTL, which only `appendClip` and
   * `touchRoom` are allowed to do.
   */
  getRoomExpiresAt(code: string): Promise<number | null>;
};

type MemoryMeta = {
  code: string;
  createdAt: number;
  ttlSeconds: number;
  keyCheck: string | null;
  eraseCheck: string | null;
  eraseGen: number;
  expiresAt: number;
};

declare global {
  var __cliplinkMemoryMeta: Map<string, MemoryMeta> | undefined;
  var __cliplinkMemoryClips: Map<string, Clip[]> | undefined;
}

function metaKey(code: string) {
  return `room:${code}:meta`;
}

function clipsKey(code: string) {
  return `room:${code}:clips`;
}

function getMemoryMetaStore() {
  if (!globalThis.__cliplinkMemoryMeta) {
    globalThis.__cliplinkMemoryMeta = new Map<string, MemoryMeta>();
  }
  return globalThis.__cliplinkMemoryMeta;
}

function getMemoryClipsStore() {
  if (!globalThis.__cliplinkMemoryClips) {
    globalThis.__cliplinkMemoryClips = new Map<string, Clip[]>();
  }
  return globalThis.__cliplinkMemoryClips;
}

function trimClips(clips: Clip[]) {
  return [...clips].sort((left, right) => left.id - right.id).slice(-MAX_ROOM_CLIPS);
}

function readMemoryMeta(code: string): MemoryMeta | null {
  const store = getMemoryMetaStore();
  const meta = store.get(code);
  if (!meta) {
    return null;
  }

  if (meta.expiresAt <= Date.now()) {
    store.delete(code);
    getMemoryClipsStore().delete(code);
    return null;
  }

  return meta;
}

const memoryAdapter: StorageAdapter = {
  async createRoom(ttlSeconds = ROOM_TTL_SECONDS, keyCheck, eraseCheck) {
    const store = getMemoryMetaStore();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateRoomCode();
      if (!readMemoryMeta(code)) {
        const createdAt = Date.now();
        store.set(code, {
          code,
          createdAt,
          ttlSeconds,
          keyCheck: keyCheck ?? null,
          eraseCheck: (await resolveEraseCheck(eraseCheck, code)) ?? null,
          eraseGen: 0,
          expiresAt: createdAt + ttlSeconds * 1000,
        });
        getMemoryClipsStore().set(code, []);
        return { code, createdAt, ttlSeconds, keyCheck: keyCheck ?? null, clips: [] };
      }
    }

    throw new Error("Failed to allocate a unique room code");
  },

  async getRoom(code) {
    const meta = readMemoryMeta(code);
    if (!meta) {
      return null;
    }

    const clips = getMemoryClipsStore().get(code) ?? [];
    return {
      code: meta.code,
      createdAt: meta.createdAt,
      ttlSeconds: meta.ttlSeconds,
      keyCheck: meta.keyCheck,
      eraseCheck: meta.eraseCheck,
      eraseGen: meta.eraseGen,
      clips,
    };
  },

  async appendClip(code, clip) {
    const meta = readMemoryMeta(code);
    if (!meta) {
      return null;
    }

    const clipsStore = getMemoryClipsStore();
    const nextClips = trimClips([...(clipsStore.get(code) ?? []), clip]);
    clipsStore.set(code, nextClips);
    meta.expiresAt = Date.now() + meta.ttlSeconds * 1000;
    return {
      code: meta.code,
      createdAt: meta.createdAt,
      ttlSeconds: meta.ttlSeconds,
      keyCheck: meta.keyCheck,
      clips: nextClips,
    };
  },

  async getClipsAfter(code, afterId) {
    const meta = readMemoryMeta(code);
    if (!meta) {
      return null;
    }

    const clips = getMemoryClipsStore().get(code) ?? [];
    return {
      clips: clips.filter((clip) => clip.id > afterId).sort((a, b) => a.id - b.id),
      eraseGen: meta.eraseGen,
    };
  },

  async eraseClips(code, request) {
    const meta = readMemoryMeta(code);
    if (!meta) {
      return null;
    }

    const clipsStore = getMemoryClipsStore();
    const clips = clipsStore.get(code) ?? [];
    const doomed = "ids" in request ? new Set(request.ids) : null;
    const isDoomed = (clip: Clip) =>
      doomed ? doomed.has(clip.id) : "upTo" in request && clip.id <= request.upTo;

    const ids = clips.filter(isDoomed).map((clip) => clip.id);
    if (ids.length > 0) {
      clipsStore.set(
        code,
        clips.filter((clip) => !isDoomed(clip)),
      );
      meta.eraseGen += 1;
    }
    return { ids, gen: meta.eraseGen };
  },

  async touchRoom(code) {
    const meta = readMemoryMeta(code);
    if (!meta) {
      return false;
    }

    meta.expiresAt = Date.now() + meta.ttlSeconds * 1000;
    return true;
  },

  async getRoomExpiresAt(code) {
    return readMemoryMeta(code)?.expiresAt ?? null;
  },
};

function isClip(value: unknown): value is Clip {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const clip = value as Partial<Clip>;
  return (
    typeof clip.id === "number" &&
    typeof clip.text === "string" &&
    typeof clip.senderId === "string" &&
    typeof clip.ts === "number"
  );
}

/**
 * Members are stored as JSON strings, but `@upstash/redis` deserializes
 * responses by default — so a member that parses as JSON comes back already
 * an object, and `JSON.parse` on it would throw and drop the clip. Both shapes
 * are accepted rather than the client's deserialization being switched off,
 * because that setting is global to the client and this is the only caller
 * that stores JSON.
 */
function parseClipMember(member: unknown): Clip | null {
  if (isClip(member)) {
    return member;
  }

  if (typeof member !== "string") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(member);
    return isClip(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One script, so the three steps cannot be separated: check the room is still
 * there, remove, count. Done as separate commands, a room that expired between
 * the check and the count would have its meta key recreated by HINCRBY — with
 * no TTL, and so forever.
 *
 * KEYS: meta, clips. ARGV: "ids" then the ids, or "upTo" then the bound.
 * Returns false for a missing room, else {generation, removed ids}; both as
 * strings, since a clip id does not survive a trip through a Lua number.
 */
const ERASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return false
end
local removed = {}
if ARGV[1] == 'ids' then
  for i = 2, #ARGV do
    if redis.call('ZREMRANGEBYSCORE', KEYS[2], ARGV[i], ARGV[i]) > 0 then
      removed[#removed + 1] = ARGV[i]
    end
  end
else
  local doomed = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[2], 'WITHSCORES')
  for i = 2, #doomed, 2 do
    removed[#removed + 1] = doomed[i]
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
end
local gen = redis.call('HGET', KEYS[1], 'eraseGen') or '0'
if #removed > 0 then
  gen = redis.call('HINCRBY', KEYS[1], 'eraseGen', 1)
end
return {tostring(gen), removed}
`;

function createRedisAdapter(): StorageAdapter {
  return {
    async createRoom(ttlSeconds = ROOM_TTL_SECONDS, keyCheck, eraseCheck) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const code = generateRoomCode();
        const exists = await redis.exists(metaKey(code));
        if (!exists) {
          const createdAt = Date.now();
          await redis.hset(metaKey(code), {
            code,
            createdAt,
            ttlSeconds,
            // Empty rather than absent: hset cannot store undefined, and an
            // empty string reads back as "this room has no key".
            keyCheck: keyCheck ?? "",
            eraseCheck: (await resolveEraseCheck(eraseCheck, code)) ?? "",
            eraseGen: 0,
          });
          await redis.expire(metaKey(code), ttlSeconds);
          return { code, createdAt, ttlSeconds, keyCheck: keyCheck ?? null, clips: [] };
        }
      }

      throw new Error("Failed to allocate a unique room code");
    },

    async getRoom(code) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      const meta = await redis.hgetall<{
        code: string;
        createdAt: number;
        ttlSeconds: number;
        keyCheck?: string;
        eraseCheck?: string;
        eraseGen?: number;
      }>(metaKey(code));
      if (!meta || !meta.code) {
        return null;
      }

      const members = await redis.zrange<unknown[]>(clipsKey(code), 0, -1);
      const clips = members
        .map(parseClipMember)
        .filter((clip): clip is Clip => clip !== null)
        .sort((a, b) => a.id - b.id);

      return {
        code: meta.code,
        createdAt: Number(meta.createdAt),
        ttlSeconds: Number(meta.ttlSeconds),
        keyCheck: meta.keyCheck ? String(meta.keyCheck) : null,
        // Absent on a room created before deletion existed, which is how
        // such a room stays undeletable.
        eraseCheck: meta.eraseCheck ? String(meta.eraseCheck) : null,
        eraseGen: Number(meta.eraseGen ?? 0) || 0,
        clips,
      };
    },

    async appendClip(code, clip) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      const meta = await redis.hgetall<{ ttlSeconds: number }>(metaKey(code));
      if (!meta || !meta.ttlSeconds) {
        return null;
      }

      const ttlSeconds = Number(meta.ttlSeconds);
      const pipeline = redis.pipeline();
      pipeline.zadd(clipsKey(code), { score: clip.id, member: JSON.stringify(clip) });
      pipeline.zremrangebyrank(clipsKey(code), 0, -(MAX_ROOM_CLIPS + 1));
      pipeline.expire(metaKey(code), ttlSeconds);
      pipeline.expire(clipsKey(code), ttlSeconds);
      await pipeline.exec();

      return this.getRoom(code);
    },

    async getClipsAfter(code, afterId) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      // The existence check and the deletion count in one read: `code` is
      // on every room, so a null there is a room that is gone.
      const meta = await redis.hmget<{ code: string | null; eraseGen: number | null }>(
        metaKey(code),
        "code",
        "eraseGen",
      );
      if (!meta || !meta.code) {
        return null;
      }

      const members = await redis.zrange<unknown[]>(clipsKey(code), `(${afterId}`, "+inf", {
        byScore: true,
      });
      return {
        clips: members
          .map(parseClipMember)
          .filter((clip): clip is Clip => clip !== null)
          .sort((a, b) => a.id - b.id),
        eraseGen: Number(meta.eraseGen ?? 0) || 0,
      };
    },

    async eraseClips(code, request) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      const args =
        "ids" in request
          ? ["ids", ...request.ids.map(String)]
          : ["upTo", String(request.upTo)];
      const result = await redis.eval<string[], [unknown, unknown[]] | null>(
        ERASE_SCRIPT,
        [metaKey(code), clipsKey(code)],
        args,
      );
      if (!Array.isArray(result)) {
        return null;
      }

      const [gen, removed] = result;
      return {
        // Number() either way: the client may have deserialised the strings.
        ids: (Array.isArray(removed) ? removed : []).map(Number),
        gen: Number(gen) || 0,
      };
    },

    async touchRoom(code) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      const meta = await redis.hgetall<{ ttlSeconds: number }>(metaKey(code));
      if (!meta || !meta.ttlSeconds) {
        return false;
      }

      const ttlSeconds = Number(meta.ttlSeconds);
      await redis.expire(metaKey(code), ttlSeconds);
      await redis.expire(clipsKey(code), ttlSeconds);
      return true;
    },

    async getRoomExpiresAt(code) {
      const redis = getRedis();
      if (!redis) {
        throw new Error("Redis client unavailable");
      }

      // PTTL is a read, and reads never refresh — only EXPIRE/PEXPIRE do — so
      // a tab polling this cannot keep a room alive. Milliseconds rather than
      // TTL's whole seconds, so the countdown does not jitter between reads.
      const ttl = await redis.pttl(metaKey(code));
      return ttl >= 0 ? Date.now() + ttl : null;
    },
  };
}

const redisAdapter = createRedisAdapter();

function activeAdapter(): StorageAdapter {
  return getRedis() ? redisAdapter : memoryAdapter;
}

export const storage: StorageAdapter = {
  createRoom: (ttlSeconds, keyCheck, eraseCheck) =>
    activeAdapter().createRoom(ttlSeconds, keyCheck, eraseCheck),
  getRoom: (code) => activeAdapter().getRoom(code),
  appendClip: (code, clip) => activeAdapter().appendClip(code, clip),
  getClipsAfter: (code, afterId) => activeAdapter().getClipsAfter(code, afterId),
  eraseClips: (code, request) => activeAdapter().eraseClips(code, request),
  touchRoom: (code) => activeAdapter().touchRoom(code),
  getRoomExpiresAt: (code) => activeAdapter().getRoomExpiresAt(code),
};

export function createClipId() {
  const now = Date.now();
  const suffix = Math.floor(Math.random() * 1000);
  return now * 1000 + suffix;
}
