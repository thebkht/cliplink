import {
  buildRoomUrl,
  createEncryptedTransport,
  createHttpClient,
  createWebSocketTransport,
  generateRoomKey,
  isValidRoomCode,
  normalizeRoomCode,
  type EncryptedTransport,
  type RoomKey,
} from "../index.ts";

import type { ParsedArgs } from "./args.ts";
import { findSavedRoom, saveRoom } from "./config.ts";
import { extractKey, extractRoomCode, KeyError, resolveKey, type KeySource } from "./key.ts";

export type Session = {
  code: string;
  key: RoomKey;
  keySource: KeySource;
  transport: EncryptedTransport;
  /** The shareable link, key in the fragment. */
  url: string;
  /** True when the room was created by this run. */
  created: boolean;
};

/**
 * Node's own `WebSocket` global, which is why this package has no `ws`
 * dependency: the transport falls through to `globalThis.WebSocket` on its own,
 * and Node has had one since 22. Everything else the package handles.
 */
function transportOptions(baseUrl: string) {
  return { baseUrl };
}

/**
 * Resolves the room this run works against, creating one when none was named.
 *
 * Creating is the default on purpose. A CLI that minted the room and the key
 * itself never has to be handed a key at all, so the common path leaves no key
 * in shell history, in the environment, or on disk — the property the web app
 * has by keeping the key in a URL fragment.
 */
export async function openSession(args: ParsedArgs): Promise<Session> {
  const options = transportOptions(args.baseUrl);
  const http = createHttpClient(options);

  if (args.room) {
    const { code, key, keySource } = await joinRoom(args);
    const transport = createEncryptedTransport(createWebSocketTransport(options));
    transport.setRoomKey(code, key);
    return {
      code,
      key,
      keySource,
      transport,
      url: buildRoomUrl(code, args.baseUrl, args.open ? undefined : key.encoded),
      created: false,
    };
  }

  const key = await generateRoomKey();
  // The server is told the fingerprint, never the key: it can tell a joiner
  // their key is wrong without being any closer to holding it.
  // The erase check goes with it, or clips in this room could never be
  // deleted: it can only be set as the room is made.
  const { code, ttlSeconds } = await http.createRoomRequest(
    key.check,
    args.ttlSeconds ?? undefined,
    key.eraseCheck,
  );
  const transport = createEncryptedTransport(createWebSocketTransport(options));
  transport.setRoomKey(code, key);

  if (args.save) {
    const savedAt = Date.now();
    // Creating is the one path that learns the room's lifetime, so it is the
    // one that can record a real expiry rather than an upper bound.
    await saveRoom({
      code,
      key: key.encoded,
      baseUrl: args.baseUrl,
      savedAt,
      expiresAt: savedAt + ttlSeconds * 1000,
    });
  }

  return {
    code,
    key,
    keySource: "generated",
    transport,
    url: buildRoomUrl(code, args.baseUrl, key.encoded),
    created: true,
  };
}

async function joinRoom(args: ParsedArgs) {
  // A pasted room link names both halves, which is the obvious thing to try.
  const fromLink = extractRoomCode(args.room ?? "");
  const code = normalizeRoomCode(fromLink ?? args.room);
  if (!isValidRoomCode(code)) {
    throw new KeyError(
      `"${args.room}" is not a room code. Codes are six letters and digits, like X7KP2M.`,
    );
  }

  let key = args.key;
  let source: KeySource = key ? "flag" : "env";

  // A link given as --room may carry the key in its fragment.
  if (!key && args.room?.includes("#")) {
    const fromHash = extractKey(args.room);
    if (fromHash) {
      key = fromHash;
      source = "flag";
    }
  }

  if (!key && !args.open) {
    const saved = await findSavedRoom(code, args.baseUrl);
    if (saved?.key) {
      key = saved.key;
      source = "saved";
    }
  }

  const resolved = await resolveKey(code, { key, open: args.open, source });

  if (args.save && !args.open) {
    await saveRoom({
      code,
      key: resolved.key.encoded,
      baseUrl: args.baseUrl,
      savedAt: Date.now(),
    });
  }

  return { code, key: resolved.key, keySource: resolved.source };
}
