import {
  MAX_ROOM_CLIPS,
  RATE_LIMIT_WINDOW_MS,
  ROOM_TTL_SECONDS,
} from "@/lib/cliplink/constants";
import { generateRoomCode } from "@/lib/cliplink/room-code";
import type { Clip, Room } from "@/lib/cliplink/types";

type StoredRecord = {
  value: string;
  expiresAt: number;
};

type KvNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    },
  ): Promise<void>;
};

declare global {
  var __cliplinkMemoryStore:
    | Map<string, StoredRecord>
    | undefined;
  var CLIPLINK_KV: KvNamespaceLike | undefined;
}

type StorageAdapter = {
  createRoom(): Promise<Room>;
  getRoom(code: string): Promise<Room | null>;
  appendClip(code: string, clip: Clip): Promise<Room | null>;
  getClipsAfter(code: string, afterId: number): Promise<Clip[] | null>;
  touchRoom(code: string): Promise<boolean>;
};

const ROOM_PREFIX = "room:";

function getMemoryStore() {
  if (!globalThis.__cliplinkMemoryStore) {
    globalThis.__cliplinkMemoryStore = new Map<string, StoredRecord>();
  }

  return globalThis.__cliplinkMemoryStore;
}

function getKvStore() {
  return globalThis.CLIPLINK_KV ?? null;
}

async function getRecord(key: string) {
  const kv = getKvStore();
  if (kv) {
    return kv.get(key);
  }

  const store = getMemoryStore();
  const record = store.get(key);
  if (!record) {
    return null;
  }

  if (record.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  return record.value;
}

async function putRecord(key: string, value: string) {
  const kv = getKvStore();
  if (kv) {
    await kv.put(key, value, {
      expirationTtl: ROOM_TTL_SECONDS,
    });
    return;
  }

  const store = getMemoryStore();
  store.set(key, {
    value,
    expiresAt: Date.now() + ROOM_TTL_SECONDS * 1000,
  });
}

function parseRoom(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as Room;
  } catch {
    return null;
  }
}

function roomKey(code: string) {
  return `${ROOM_PREFIX}${code}`;
}

function trimClips(clips: Clip[]) {
  return [...clips].sort((left, right) => left.id - right.id).slice(-MAX_ROOM_CLIPS);
}

async function createRoomWithCode(code: string) {
  const room: Room = {
    code,
    createdAt: Date.now(),
    clips: [],
  };
  await putRecord(roomKey(code), JSON.stringify(room));
  return room;
}

export const storage: StorageAdapter = {
  async createRoom() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateRoomCode();
      const existing = await this.getRoom(code);
      if (!existing) {
        return createRoomWithCode(code);
      }
    }

    throw new Error("Failed to allocate a unique room code");
  },

  async getRoom(code) {
    const room = parseRoom(await getRecord(roomKey(code)));
    if (!room) {
      return null;
    }

    await putRecord(roomKey(code), JSON.stringify(room));
    return room;
  },

  async appendClip(code, clip) {
    const room = await this.getRoom(code);
    if (!room) {
      return null;
    }

    const nextRoom: Room = {
      ...room,
      clips: trimClips([...room.clips, clip]),
    };
    await putRecord(roomKey(code), JSON.stringify(nextRoom));
    return nextRoom;
  },

  async getClipsAfter(code, afterId) {
    const room = await this.getRoom(code);
    if (!room) {
      return null;
    }

    return room.clips.filter((clip) => clip.id > afterId).sort((a, b) => a.id - b.id);
  },

  async touchRoom(code) {
    const room = await this.getRoom(code);
    return Boolean(room);
  },
};

export function createClipId() {
  const now = Date.now();
  const suffix = Math.floor(Math.random() * 1000);
  return now * 1000 + suffix;
}

export function getRateLimitBucket(timestamp = Date.now()) {
  return Math.floor(timestamp / RATE_LIMIT_WINDOW_MS);
}
