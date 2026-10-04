"use client";

import { useEffect, useRef, useState } from "react";

import {
  MAX_SESSION_HISTORY,
  POLL_INTERVAL_MS,
} from "@/lib/cliplink/constants";
import { isPageAttended } from "@/lib/cliplink/attention";
import { writeClipboard } from "@/lib/cliplink/clipboard";
import { getDeviceName, ownClipMark } from "@/lib/cliplink/device";
import { haptic } from "@/lib/cliplink/haptics";
import { createRandomId } from "@/lib/cliplink/session";
import type {
  Clip,
  PeerId,
  RoomCode,
  RoomStatus,
  SessionClip,
  SignalPayload,
} from "@/lib/cliplink/types";
import {
  createEncryptedTransport,
  UNDECRYPTABLE_TEXT,
} from "@/lib/cliplink/encrypted-transport";
import type { RoomKey } from "@/lib/cliplink/crypto";
import { createWebSocketTransport } from "@/lib/cliplink/ws";

import { useMissedClips } from "./use-missed-clips";
import type { PushToast } from "./use-toasts";

/**
 * One transport for the life of the tab, so `transport.sendSignal` keeps a
 * stable identity — the file-transfer manager memoises on it, and a fresh
 * closure each render would reset the manager in a loop. The room key is a
 * mutable slot inside it for the same reason.
 */
export const transport = createEncryptedTransport(createWebSocketTransport());

// Identifies this page load for peer-to-peer signaling. Unlike the sender id it
// isn't kept in sessionStorage, so duplicated tabs don't share an identity.
export const peerId = createRandomId();

/** How long the localised arrival highlight stays on the panel and new row. */
const ARRIVAL_CUE_MS = 500;

export function clearTimer(ref: React.RefObject<number | null>) {
  if (ref.current) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function sortClipsNewestFirst(clips: SessionClip[]) {
  return [...clips].sort((left, right) => right.id - left.id);
}

function mergeHistory(current: SessionClip[], additions: SessionClip[]) {
  const seen = new Set(current.map((clip) => clip.id));
  const merged = [...current];

  for (const clip of additions) {
    if (!seen.has(clip.id)) {
      merged.push(clip);
      seen.add(clip.id);
    }
  }

  return sortClipsNewestFirst(merged).slice(0, MAX_SESSION_HISTORY);
}

type RoomSessionOptions = {
  pushToast: PushToast;
  senderIdRef: React.RefObject<string>;
  /** Fired once the socket is open, so open file offers can be re-announced. */
  onRealtimeOpen: () => void;
  /** Fired when the socket drops, so peer-derived state can be cleared. */
  onRealtimeClose: () => void;
  onSignal: (from: PeerId, payload: SignalPayload) => void;
};

/**
 * The room's connection and clip state: WebSocket with a polling fallback,
 * exponential-backoff reconnect, session history, and the arrival cue.
 *
 * Everything here is imperative and timer-driven, which is exactly why it is
 * worth keeping out of the view. Callers get plain state plus three verbs —
 * `hydrate`, `send`, `leave`.
 */
export function useRoomSession({
  pushToast,
  senderIdRef,
  onRealtimeOpen,
  onRealtimeClose,
  onSignal,
}: RoomSessionOptions) {
  const [roomCode, setRoomCode] = useState<RoomCode | null>(null);
  // Joined, but with no key to read the room with. The clips still arrive and
  // still cannot be opened; the room is legible as a room and nothing more.
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState<RoomStatus>("offline");
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [history, setHistory] = useState<SessionClip[]>([]);
  const [arrivalId, setArrivalId] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  // Whether clips here can be deleted: the room was created with an erase
  // check, and this device holds the key the token comes from.
  const [erasable, setErasable] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<number>>(new Set());

  const lastSeenIdRef = useRef(0);
  const ttlSecondsRef = useRef<number | null>(null);
  const roomCodeRef = useRef<RoomCode | null>(null);
  const pollingRef = useRef<number | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const syncResetRef = useRef<number | null>(null);
  const initializedRoomRef = useRef<string | null>(null);
  const realtimeRetryRef = useRef<number | null>(null);
  const realtimeRetryCountRef = useRef(0);
  const realtimeOpenedRef = useRef(false);
  const arrivalResetRef = useRef<number | null>(null);
  const lockedRef = useRef(false);

  const missed = useMissedClips({ pushToast });

  // A reconnect scheduled minutes ago must call today's handlers, not the ones
  // captured when the timer was set.
  const handlersRef = useRef({
    pushToast,
    onRealtimeOpen,
    onRealtimeClose,
    onSignal,
  });
  useEffect(() => {
    handlersRef.current = {
      pushToast,
      onRealtimeOpen,
      onRealtimeClose,
      onSignal,
    };
  });

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    const timers = [syncResetRef, realtimeRetryRef, arrivalResetRef];
    const polling = pollingRef;
    const stream = streamCleanupRef;

    const handlePageHide = () => transport.disconnect();
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      if (polling.current) {
        window.clearInterval(polling.current);
        polling.current = null;
      }
      stream.current?.();
      stream.current = null;
      for (const timer of timers) {
        clearTimer(timer);
      }
      transport.disconnect();
    };
  }, []);

  function clearRealtimeRetry() {
    clearTimer(realtimeRetryRef);
  }

  function clearSyncReset() {
    clearTimer(syncResetRef);
  }

  function markSyncing() {
    clearSyncReset();
    setStatus("syncing");
    syncResetRef.current = window.setTimeout(() => {
      setStatus("live");
      syncResetRef.current = null;
    }, 600);
  }

  /**
   * Highlights the panel and the row that just landed. This replaces a
   * full-viewport flash: an abrupt whole-screen brightness jump on every
   * incoming message is a photosensitivity risk, and it drew the eye away from
   * the thing that actually changed.
   */
  function markArrival(clipId: number) {
    clearTimer(arrivalResetRef);
    // Clearing for a frame first restarts the animation. Without it a second
    // clip arriving inside the cue window leaves the class already applied, so
    // the panel never flashes again and the arrival goes unmarked.
    setArrivalId(null);
    window.requestAnimationFrame(() => {
      setArrivalId(clipId);
      arrivalResetRef.current = window.setTimeout(() => {
        setArrivalId(null);
        arrivalResetRef.current = null;
      }, ARRIVAL_CUE_MS);
    });
  }

  function markEntering(ids: number[]) {
    setEnteringIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.add(id);
      }
      return next;
    });
  }

  function stopPolling() {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  function stopStream() {
    if (streamCleanupRef.current) {
      const cleanup = streamCleanupRef.current;
      streamCleanupRef.current = null;
      cleanup();
    }
  }

  function startPolling(nextRoomCode: RoomCode) {
    stopPolling();
    pollingRef.current = window.setInterval(() => {
      void pollForUpdates(nextRoomCode);
    }, POLL_INTERVAL_MS);
  }

  function scheduleRealtimeRetry(nextRoomCode: RoomCode) {
    clearRealtimeRetry();
    const attempt = realtimeRetryCountRef.current;
    const delay = Math.min(15_000, 2_000 * 2 ** attempt);
    realtimeRetryRef.current = window.setTimeout(() => {
      realtimeRetryRef.current = null;
      if (roomCodeRef.current === nextRoomCode && !streamCleanupRef.current) {
        startRealtime(nextRoomCode);
      }
    }, delay);
  }

  async function autoCopyIncoming(text: string) {
    try {
      await writeClipboard(text);
      handlersRef.current.pushToast("Received clip — copied!", "success", {
        unprompted: true,
      });
    } catch {
      handlersRef.current.pushToast(
        "Received clip. Clipboard access was blocked.",
        "info",
        { unprompted: true },
      );
    }
  }

  /**
   * The sender id says "this tab"; the mark says "this browser". Either makes
   * a clip ours, which is what keeps a reload, or a second tab, from
   * relabelling everything this device sent as received.
   */
  function toSessionClips(code: RoomCode, clips: Clip[]) {
    return Promise.all(
      clips.map(async (clip): Promise<SessionClip> => {
        const own =
          clip.senderId === senderIdRef.current ||
          (clip.from?.device !== undefined &&
            clip.from.device === (await ownClipMark(code, clip.text)));
        return { ...clip, direction: own ? "outgoing" : "incoming" };
      }),
    );
  }

  function applyIncomingClips(added: SessionClip[]) {
    if (added.length === 0) {
      return;
    }

    setHistory((current) => mergeHistory(current, added));
    setStatus("live");
    markEntering(added.map((clip) => clip.id));

    // A clip sent from another tab of this browser belongs in history, but it
    // is not an arrival: the clipboard it would be copied to is the one it
    // came from.
    const clips = added.filter((clip) => clip.direction === "incoming");
    if (clips.length === 0) {
      return;
    }

    let latest = clips[0];
    for (const clip of clips) {
      if (clip.id > latest.id) {
        latest = clip;
      }
    }
    markArrival(latest.id);
    haptic("arrive");
    if (isPageAttended()) {
      void autoCopyIncoming(latest.text);
    } else if (roomCodeRef.current) {
      // The browser would refuse the write from here. A clip this device
      // cannot read leaves nothing worth copying, but the arrival is still
      // worth marking.
      const readable =
        !lockedRef.current && latest.text !== UNDECRYPTABLE_TEXT;
      missed.hold(
        roomCodeRef.current,
        { id: latest.id, text: readable ? latest.text : null },
        clips.length,
      );
    }
    advanceExpiry(latest.ts);
  }

  /** Clips deleted from the room, whichever device asked. */
  function applyRemoved(ids: number[]) {
    if (ids.length === 0) {
      return;
    }

    const removed = new Set(ids);
    setHistory((current) => {
      const next = current.filter((clip) => !removed.has(clip.id));
      return next.length === current.length ? current : next;
    });
    missed.drop(ids);
  }

  /**
   * A clip from another device extended the room, but only its sender got the
   * refreshed expiry back in a response. The server's rule is deterministic —
   * every write pushes the deadline `ttlSeconds` past the write — so the new
   * expiry is derivable here from the clip's own server-assigned timestamp,
   * with no extra round trip. Without this a receiving tab keeps counting down
   * to the old deadline and can read "expired" for a room that is very much
   * alive.
   */
  function advanceExpiry(clipTs: number) {
    const ttlSeconds = ttlSecondsRef.current;
    if (ttlSeconds === null) {
      return;
    }

    const deadline = clipTs + ttlSeconds * 1000;
    // Monotonic: a clip arriving out of order must not drag the countdown back.
    setExpiresAt((current) => Math.max(current ?? 0, deadline));
  }

  function startRealtime(nextRoomCode: RoomCode) {
    stopPolling();
    stopStream();
    clearRealtimeRetry();
    realtimeOpenedRef.current = false;
    const cleanup = transport.streamClips(
      nextRoomCode,
      lastSeenIdRef.current,
      peerId,
      {
        onOpen: () => {
          const hadFallback = realtimeRetryCountRef.current > 0;
          realtimeOpenedRef.current = true;
          realtimeRetryCountRef.current = 0;
          setStatus("live");
          setRealtimeReady(true);
          handlersRef.current.onRealtimeOpen();
          if (hadFallback) {
            handlersRef.current.pushToast(
              "Realtime connection restored.",
              "success",
              { unprompted: true },
            );
          }
        },
        onClips: (clips) => {
          for (const clip of clips) {
            lastSeenIdRef.current = Math.max(lastSeenIdRef.current, clip.id);
          }

          void toSessionClips(
            nextRoomCode,
            clips.filter((clip) => clip.senderId !== senderIdRef.current),
          ).then((incoming) => {
            // The room may have been left while the marks were checked.
            if (roomCodeRef.current === nextRoomCode) {
              applyIncomingClips(incoming.reverse());
            }
          });
        },
        onRemoved: applyRemoved,
        onSignal: (from, payload) => handlersRef.current.onSignal(from, payload),
        onDisconnect: (reason) => {
          streamCleanupRef.current = null;
          setRealtimeReady(false);
          handlersRef.current.onRealtimeClose();
          if (reason === "error" && roomCodeRef.current === nextRoomCode) {
            const hadOpened = realtimeOpenedRef.current;
            realtimeOpenedRef.current = false;
            startPolling(nextRoomCode);
            realtimeRetryCountRef.current += 1;
            scheduleRealtimeRetry(nextRoomCode);
            handlersRef.current.pushToast(
              hadOpened
                ? "Realtime connection dropped. Using polling for now."
                : "Realtime unavailable. Using polling for now.",
              "info",
              { unprompted: true },
            );
          }
        },
      },
    );

    if (!cleanup) {
      startPolling(nextRoomCode);
      return;
    }

    streamCleanupRef.current = cleanup;
  }

  async function pollForUpdates(nextRoomCode: RoomCode) {
    try {
      const response = await transport.pollClips(
        nextRoomCode,
        lastSeenIdRef.current,
      );
      const incoming = response.clips.filter(
        (clip) => clip.senderId !== senderIdRef.current,
      );
      applyRemoved(response.removed ?? []);

      if (response.clips.length > 0) {
        lastSeenIdRef.current = response.clips.reduce(
          (highest, clip) => Math.max(highest, clip.id),
          lastSeenIdRef.current,
        );
      }

      if (incoming.length === 0) {
        return;
      }

      const additions = await toSessionClips(nextRoomCode, incoming);
      if (roomCodeRef.current === nextRoomCode) {
        applyIncomingClips(additions.reverse());
      }
    } catch (error) {
      setStatus("error");
      handlersRef.current.pushToast(
        error instanceof Error ? error.message : "Polling failed.",
        "error",
      );
    }
  }

  /** A null key joins the room locked: everything works except reading it. */
  async function hydrate(nextRoomCode: RoomCode, key: RoomKey | null) {
    transport.setRoomKey(nextRoomCode, key);
    // With the key, not after the awaits below: a stream already running
    // decrypts with the new key at once, and an arrival must agree with it.
    lockedRef.current = key === null;
    // Claimed up front, because hydrating writes ?room= to the URL and the
    // searchParams effect would otherwise read that back as a fresh link and
    // join the room a second time — two connects, two sockets, two toasts.
    initializedRoomRef.current = nextRoomCode;
    const response = await transport.connect(nextRoomCode);
    let nextHistory = sortClipsNewestFirst(
      await toSessionClips(nextRoomCode, response.clips),
    ).slice(0, MAX_SESSION_HISTORY);

    let lastSeenId = response.clips.reduce(
      (highest, clip) => Math.max(highest, clip.id),
      0,
    );

    try {
      const bootstrapDelta = await transport.pollClips(nextRoomCode, lastSeenId);
      if (bootstrapDelta.clips.length > 0) {
        nextHistory = mergeHistory(
          nextHistory,
          await toSessionClips(nextRoomCode, bootstrapDelta.clips),
        );
        lastSeenId = bootstrapDelta.clips.reduce(
          (highest, clip) => Math.max(highest, clip.id),
          lastSeenId,
        );
      }
    } catch {
      // Ignore bootstrap delta errors and fall back to the initial snapshot.
    }

    setRoomCode(nextRoomCode);
    setLocked(key === null);
    setHistory(nextHistory);
    ttlSecondsRef.current = response.room.ttlSeconds;
    setExpiresAt(response.room.expiresAt ?? null);
    setErasable(response.room.erasable === true && key !== null);
    setStatus("live");
    // Rows present at hydration are not arrivals, so they must not animate in.
    setEnteringIds(new Set());
    lastSeenIdRef.current = lastSeenId;
    startRealtime(nextRoomCode);
  }

  /** Returns true when the clip was accepted, so the caller can clear the editor. */
  async function send(text: string) {
    if (!roomCodeRef.current) {
      return false;
    }

    const code = roomCodeRef.current;
    try {
      const mark = await ownClipMark(code, text);
      const response = await transport.sendClip(code, {
        text,
        senderId: senderIdRef.current,
        from: { name: getDeviceName(), ...(mark ? { device: mark } : {}) },
      });

      const sessionClip: SessionClip = {
        ...response.clip,
        direction: "outgoing",
      };

      setHistory((current) => mergeHistory(current, [sessionClip]));
      markEntering([response.clip.id]);
      // Writing extends the room's TTL, so the countdown jumps forward.
      if (response.expiresAt !== undefined) {
        setExpiresAt(response.expiresAt);
      }
      lastSeenIdRef.current = Math.max(lastSeenIdRef.current, response.clip.id);
      markSyncing();
      // The new history row and the status dot already confirm the send, so the
      // haptic is the only extra channel it needs.
      haptic("commit");
      return true;
    } catch (error) {
      setStatus("error");
      handlersRef.current.pushToast(
        error instanceof Error ? error.message : "Could not send clip.",
        "error",
      );
      return false;
    }
  }

  /**
   * Deletes for the whole room, not just from this list. The rows go when the
   * server confirms, so a refused delete leaves them where they were.
   */
  async function erase(request: { ids: number[] } | { upTo: number }) {
    const code = roomCodeRef.current;
    if (!code) {
      return false;
    }

    try {
      const response = await transport.eraseClips(code, request);
      if (roomCodeRef.current === code) {
        // The ids asked for as well as the ones removed: a clip someone else
        // had already deleted is gone either way.
        applyRemoved([
          ...response.ids,
          ...("ids" in request ? request.ids : []),
        ]);
      }
      return true;
    } catch (error) {
      handlersRef.current.pushToast(
        error instanceof Error ? error.message : "Could not delete.",
        "error",
      );
      return false;
    }
  }

  function remove(id: number) {
    return erase({ ids: [id] });
  }

  /** Everything the room holds as of the newest clip this device has seen. */
  function clear() {
    return erase({ upTo: lastSeenIdRef.current });
  }

  function leave() {
    setRealtimeReady(false);
    onRealtimeClose();
    stopPolling();
    stopStream();
    clearSyncReset();
    clearRealtimeRetry();
    transport.disconnect();
    transport.clearRoomKey();
    setRoomCode(null);
    setLocked(false);
    lockedRef.current = false;
    missed.reset();
    setHistory([]);
    setErasable(false);
    setExpiresAt(null);
    setStatus("offline");
    setEnteringIds(new Set());
    initializedRoomRef.current = null;
    lastSeenIdRef.current = 0;
    ttlSecondsRef.current = null;
    realtimeRetryCountRef.current = 0;
    realtimeOpenedRef.current = false;
  }

  function fail() {
    setStatus("error");
    initializedRoomRef.current = null;
  }

  return {
    roomCode,
    setRoomCode,
    locked,
    status,
    realtimeReady,
    history,
    arrivalId,
    enteringIds,
    expiresAt,
    erasable,
    initializedRoomRef,
    hydrate,
    send,
    remove,
    clear,
    leave,
    fail,
  };
}
