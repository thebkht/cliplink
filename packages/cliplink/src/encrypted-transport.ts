import {
  decryptClipText,
  encryptClipText,
  openClipMeta,
  openSignal,
  sealClipMeta,
  sealSignal,
  type RoomKey,
} from "./crypto.ts";
import type {
  Clip,
  RoomCode,
  SealedTransport,
  TransportClient,
} from "./types.ts";
import { parseClipMeta, parseSignalPayload } from "./validation.ts";

/**
 * Shown in place of a clip that will not open. Never silently dropped: a row
 * that cannot be read is how someone learns they pasted the wrong key, and a
 * clip that vanishes teaches them nothing.
 */
export const UNDECRYPTABLE_TEXT = "[Could not decrypt this clip]";

/**
 * Thrown when the loaded key does not match the fingerprint the room was
 * created with. Checked here rather than by the caller so that no connection
 * can commit state under a key that was never going to work.
 */
export class RoomKeyMismatchError extends Error {
  constructor() {
    super("That key does not match this room.");
    this.name = "RoomKeyMismatchError";
  }
}

/**
 * A clip or a request without the two sender fields. Both are this module's to
 * write: `meta` is what it sealed and `from` is what it opened, so a copy that
 * arrived from the other side — the caller's or the server's — is not trusted.
 */
function withoutSender<T extends { meta?: string; from?: unknown }>(value: T) {
  const rest = { ...value };
  delete rest.meta;
  delete rest.from;
  return rest;
}

export type EncryptedTransport = TransportClient & {
  /** Set on join, cleared on leave. Null means nothing can be sent or read. */
  setRoomKey: (roomCode: RoomCode, key: RoomKey | null) => void;
  clearRoomKey: () => void;
};

/**
 * Wraps a wire transport so everything above it works in plaintext.
 *
 * Encryption belongs here rather than in the room session hook because the
 * transport is the seam the rest of the app already talks through — the retry
 * and backoff state machine above it is written once and stays written once.
 */
export function createEncryptedTransport(
  wire: SealedTransport,
): EncryptedTransport {
  let roomKey: RoomKey | null = null;
  let roomCode: RoomCode | null = null;

  // Signals seal asynchronously but must arrive in the order they were sent —
  // an ICE candidate overtaking the description it belongs to would break the
  // handshake. Chaining keeps send order without making callers await.
  let sendChain: Promise<void> = Promise.resolve();

  // Deletion. A poll and a socket backlog can only ever add clips, so the
  // server counts deletions (`eraseGen`) and this compares: a count ahead of
  // the last one seen means something was removed that nobody said. What, is
  // found by asking for the room again and seeing which known clips are gone.
  /** The last `eraseGen` accounted for. Null until a server reports one. */
  let knownGen: number | null = null;
  /** Clips handed to the caller and not yet known to be deleted. */
  const seen = new Set<number>();
  /**
   * Clips known deleted. Kept so one whose decryption was still in flight when
   * its removal arrived is not delivered afterwards, as if it had come back.
   */
  const gone = new Set<number>();
  let reconciling: Promise<number[]> | null = null;

  function markGone(ids: number[]) {
    for (const id of ids) {
      gone.add(id);
      seen.delete(id);
    }
    return ids;
  }

  /** True when the server has counted a deletion this transport has not seen. */
  function isAhead(gen: number | undefined): gen is number {
    if (gen === undefined) {
      // A server from before deletion existed. Not a count of zero.
      return false;
    }
    if (knownGen === null) {
      knownGen = gen;
      return false;
    }
    return gen > knownGen;
  }

  /** Resolves with the clips that turned out to be gone. */
  function reconcile(code: RoomCode, gen: number) {
    reconciling ??= (async () => {
      // Only what was known before asking: a clip that arrives while the
      // snapshot is in flight is newer than it, not missing from it.
      const before = [...seen];
      const response = await wire.connect(code);
      const live = new Set(response.clips.map((clip) => clip.id));
      knownGen = Math.max(knownGen ?? 0, gen, response.room.eraseGen ?? 0);
      return markGone(before.filter((id) => !live.has(id)));
    })().finally(() => {
      reconciling = null;
    });
    return reconciling;
  }

  async function decryptClips(sealedClips: Clip[]): Promise<Clip[]> {
    const key = roomKey;
    const code = roomCode;

    const clips = await Promise.all(
      sealedClips.map(async (sealed) => {
        const { meta } = sealed;
        const clip = withoutSender(sealed);
        if (!key || !code) {
          return { ...clip, text: UNDECRYPTABLE_TEXT };
        }

        const [text, opened] = await Promise.all([
          decryptClipText(key, code, clip.text),
          meta ? openClipMeta(key, code, clip.text, meta) : null,
        ]);
        const from = opened === null ? null : parseClipMeta(opened);
        return {
          ...clip,
          text: text ?? UNDECRYPTABLE_TEXT,
          ...(from ? { from } : {}),
        };
      }),
    );

    // After the awaits, so a removal that landed meanwhile is honoured.
    const kept = clips.filter((clip) => !gone.has(clip.id));
    for (const clip of kept) {
      seen.add(clip.id);
    }
    return kept;
  }

  return {
    setRoomKey(nextRoomCode, key) {
      roomCode = nextRoomCode;
      roomKey = key;
    },

    clearRoomKey() {
      roomCode = null;
      roomKey = null;
    },

    async connect(code) {
      const response = await wire.connect(code);
      const key = roomKey;
      if (key && response.room.keyCheck && response.room.keyCheck !== key.check) {
        throw new RoomKeyMismatchError();
      }
      // A fresh snapshot is the whole truth about the room: start over from it.
      seen.clear();
      gone.clear();
      knownGen = response.room.eraseGen ?? null;
      return { ...response, clips: await decryptClips(response.clips) };
    },

    async sendClip(code, payload) {
      const key = roomKey;
      if (!key) {
        throw new Error("This room is encrypted and no key is loaded.");
      }

      const { from } = payload;
      const text = await encryptClipText(key, code, payload.text);
      const response = await wire.sendClip(code, {
        ...withoutSender(payload),
        text,
        ...(from ? { meta: await sealClipMeta(key, code, text, from) } : {}),
      });
      // Echo back what the caller handed us rather than decrypting our own
      // ciphertext, so the sender's own history row cannot read as broken.
      seen.add(response.clip.id);
      return {
        ...response,
        clip: {
          ...withoutSender(response.clip),
          text: payload.text,
          ...(from ? { from } : {}),
        },
      };
    },

    async pollClips(code, afterId) {
      const response = await wire.pollClips(code, afterId);
      const clips = await decryptClips(response.clips);
      if (!isAhead(response.eraseGen)) {
        return { clips };
      }

      // A failed look is not fatal: the count is still ahead on the next poll.
      const removed = await reconcile(code, response.eraseGen).catch(() => []);
      return {
        clips: clips.filter((clip) => !gone.has(clip.id)),
        ...(removed.length > 0 ? { removed } : {}),
      };
    },

    async eraseClips(code, request) {
      const key = roomKey;
      if (!key) {
        throw new Error("This room is encrypted and no key is loaded.");
      }

      const response = await wire.eraseClips(code, key.eraseToken, request);
      const ids = new Set(markGone(response.ids));
      if (knownGen !== null && response.gen > knownGen + 1) {
        // Someone else deleted something in between, and this is the first
        // this transport has heard of it.
        for (const id of await reconcile(code, response.gen).catch(() => [])) {
          ids.add(id);
        }
      } else {
        knownGen = Math.max(knownGen ?? 0, response.gen);
      }
      return { ids: [...ids], gen: response.gen };
    },

    streamClips(code, afterId, peerId, handlers) {
      const removed = (ids: number[]) => {
        if (ids.length > 0) {
          handlers.onRemoved?.(ids);
        }
      };
      const catchUp = (gen: number) => {
        void reconcile(code, gen).then(removed, () => {
          // Left for the next count that arrives to notice.
        });
      };

      return wire.streamClips(code, afterId, peerId, {
        onOpen: (eraseGen) => {
          handlers.onOpen?.();
          // The backlog a socket replays holds no deletions, so a reconnect
          // is exactly where one can have been missed.
          if (isAhead(eraseGen)) {
            catchUp(eraseGen);
          }
        },
        onRemoved: (ids, gen) => {
          const missed = knownGen !== null && gen > knownGen + 1;
          removed(markGone(ids));
          if (missed) {
            catchUp(gen);
          } else {
            knownGen = Math.max(knownGen ?? 0, gen);
          }
        },
        onClips: (clips) => {
          void decryptClips(clips).then(handlers.onClips);
        },
        onSealedSignal: (from, sealed) => {
          const key = roomKey;
          const signalRoom = roomCode;
          if (!key || !signalRoom || !handlers.onSignal) {
            return;
          }
          void openSignal(key, signalRoom, sealed).then((payload) => {
            // Validated after decryption, which is the only place it can be:
            // the server relays a signal it cannot read, so rebuilding the
            // payload from known fields is the client's job now.
            const parsed = payload === null ? null : parseSignalPayload(payload);
            // A name is only believed from the peer it names. Without this a
            // key holder could rename someone else in everyone's list.
            if (parsed?.type === "presence" && parsed.peer !== from) {
              return;
            }
            if (parsed) {
              handlers.onSignal?.(from, parsed);
            }
          });
        },
        // Arrives unsealed because the server originates it, but the rest of
        // the app has no reason to care which channel it came in on.
        onPeerLeft: (from) => handlers.onSignal?.(from, { type: "peer-left" }),
        onDisconnect: handlers.onDisconnect,
      });
    },

    sendSignal(payload, to) {
      const key = roomKey;
      const code = roomCode;
      if (!key || !code || !wire.canSend()) {
        return false;
      }

      sendChain = sendChain
        .then(async () => {
          wire.sendSealedSignal(await sealSignal(key, code, payload), to);
        })
        .catch(() => {
          // A signal that cannot be sealed is dropped. Transfers already
          // recover from a lost signal by stalling and retrying.
        });
      return true;
    },

    disconnect: wire.disconnect,
  };
}
