"use client";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { useTheme } from "next-themes";

import { ClipEditor } from "@/components/cliplink/clip-editor";
import { CommandPalette } from "@/components/cliplink/command-palette";
import { FileTransfers } from "@/components/cliplink/file-transfers";
import { PlayerSheet } from "@/components/cliplink/player-sheet";
import { HistoryList } from "@/components/cliplink/history-list";
import { IconTheme } from "@/components/cliplink/icons";
import { KeyPrompt } from "@/components/cliplink/key-prompt";
import { LandingView } from "@/components/cliplink/landing-view";
import { QrSheet } from "@/components/cliplink/qr-sheet";
import { createRoomActions } from "@/components/cliplink/room-actions";
import { RoomHeader } from "@/components/cliplink/room-header";
import {
  ShareBanner,
  type ShareState,
} from "@/components/cliplink/share-banner";
import { ShortcutsSheet } from "@/components/cliplink/shortcuts-sheet";
import { headerSurfaceStyle } from "@/components/cliplink/ui";
import { Wordmark } from "@/components/cliplink/wordmark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { useClipEditor } from "@/components/cliplink/use-clip-editor";
import { useRoomExpiry } from "@/components/cliplink/use-room-expiry";
import { useFileTransfer } from "@/components/cliplink/use-file-transfer";
import {
  clearTimer,
  peerId,
  transport,
  useRoomSession,
} from "@/components/cliplink/use-room-session";
import { DevicesSheet } from "@/components/cliplink/devices-sheet";
import { usePresence } from "@/components/cliplink/use-presence";
import { useShortcuts } from "@/components/cliplink/use-shortcuts";
import { useToasts } from "@/components/cliplink/use-toasts";

import {
  disableNotifications,
  enableNotifications,
  notificationsEnabled,
  subscribeToNotifications,
} from "@/lib/cliplink/attention";
import { writeClipboard } from "@/lib/cliplink/clipboard";
import { MAX_CLIP_CHARS, MAX_FILES_PER_SHARE } from "@/lib/cliplink/constants";
import {
  entriesFromDataTransfer,
  entriesFromFileList,
  type ShareEntry,
} from "@/lib/cliplink/dropped-files";
import {
  deriveOpenRoomKey,
  formatRoomKey,
  generateRoomKey,
  importRoomKey,
  type RoomKey,
} from "@/lib/cliplink/crypto";
import { RoomKeyMismatchError } from "@/lib/cliplink/encrypted-transport";
import { connectRoom, createRoomRequest } from "@/lib/cliplink/http";
import {
  describeShare,
  holdShare,
  isShareMessage,
  SHARE_CHANNEL,
  claimCachedShare,
  takeHeldShare,
  type PendingShare,
  type ShareMessage,
} from "@/lib/cliplink/pending-share";
import {
  buildRoomUrl,
  normalizeRoomCode,
  parseRoomKeyFromHash,
  roomKeyFragment,
} from "@/lib/cliplink/room-code";
import { createRandomId, getSessionSenderId } from "@/lib/cliplink/session";
import type { RoomCode, RoomStatus } from "@/lib/cliplink/types";
import { validateRoomCode } from "@/lib/cliplink/validation";
import { cn } from "@/lib/utils";

/** Stable no-op subscribe for the `useSyncExternalStore` hydration guard. */
const subscribeToNothing = () => () => {};

/** A destructive confirmation that never times out is a trap of its own. */
const CONFIRM_WINDOW_MS = 4000;

/** How long a room tab gets to confirm it took a share before it's dropped. */
const SHARE_DELIVERY_TIMEOUT_MS = 3000;

const SHARE_ERRORS: Record<string, string> = {
  unavailable:
    "CLIPLINK was still setting up and couldn't receive that share. Share it again.",
  unreadable: "That share couldn't be read. Try sharing again.",
};

type StatusTone = "idle" | "good" | "busy" | "warn" | "bad";

/**
 * One source for the word and the colour, so they cannot disagree. Polling had
 * been reading as Live-green while the label said the connection was degraded
 * — the dot said everything was fine and the word said it was not.
 */
function statusFor(
  status: RoomStatus,
  realtimeReady: boolean,
): { label: string; tone: StatusTone } {
  switch (status) {
    case "live":
      return realtimeReady
        ? { label: "Live", tone: "good" }
        : { label: "Polling", tone: "warn" };
    case "syncing":
      return { label: "Syncing", tone: "busy" };
    case "error":
      return { label: "Error", tone: "bad" };
    default:
      return { label: "Offline", tone: "idle" };
  }
}

const DOT_TONE: Record<StatusTone, string> = {
  idle: "bg-muted-foreground",
  good: "bg-success",
  // Steady, not pulsing: polling is a settled state, not work in progress.
  warn: "bg-warning",
  busy: "animate-[pulse_1s_ease-in-out_infinite] bg-link",
  bad: "bg-destructive",
};

type CliplinkAppProps = {
  /** Present when rendered at /room/[code]; absent on the landing page. */
  initialRoomCode?: string;
  /** Rendered by the server page, so the star count is fetched and cached there. */
  repoLink?: React.ReactNode;
  /** Present when rendered at /share, where the OS share sheet lands. */
  share?: { error?: string };
};

export default function CliplinkApp({
  initialRoomCode,
  repoLink,
  share,
}: CliplinkAppProps) {
  const [joinCode, setJoinCode] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [showQrSheet, setShowQrSheet] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  /** The file the player is open on, by id so it follows the live item. */
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // The room being joined by code alone, waiting on a key the link never
  // carried. `mismatch` distinguishes "we need a key" from "that one is wrong".
  const [keyPrompt, setKeyPrompt] = useState<{
    code: RoomCode;
    mismatch: boolean;
  } | null>(null);
  // The serialized key, for the surfaces that display it. State rather than a
  // ref because it is rendered — and it is already in the address bar, so this
  // is no wider an exposure than the fragment it came from.
  const [roomKeyEncoded, setRoomKeyEncoded] = useState<string | null>(null);
  const [shareState, setShareState] = useState<ShareState>(() =>
    share?.error
      ? {
          phase: "error",
          message: SHARE_ERRORS[share.error] ?? SHARE_ERRORS.unreadable,
        }
      : { phase: "loading" },
  );
  const [shareRooms, setShareRooms] = useState<
    { code: RoomCode; tabId: string }[]
  >([]);

  // Hydration guard for theme-dependent rendering: false on the server and on
  // the first client render, true thereafter.
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  const { resolvedTheme, setTheme } = useTheme();
  const { push: pushToast } = useToasts();
  const notificationsOn = useSyncExternalStore(
    subscribeToNotifications,
    notificationsEnabled,
    () => false,
  );

  const senderIdRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);
  const confirmResetRef = useRef<number | null>(null);
  const clearConfirmResetRef = useRef<number | null>(null);
  const shareChannelRef = useRef<BroadcastChannel | null>(null);
  // Shared files wait here until the room can actually offer them.
  const queuedShareFilesRef = useRef<File[]>([]);
  const shareTabIdRef = useRef("");
  const shareDeliveryRef = useRef<{
    tabId: string;
    code: RoomCode;
    timer: number;
  } | null>(null);

  const presence = usePresence({ peerId, sendSignal: transport.sendSignal });

  const room = useRoomSession({
    pushToast,
    senderIdRef,
    onRealtimeOpen: () => {
      presence.announce();
      files.announce();
    },
    onRealtimeClose: () => presence.reset(),
    onSignal: (from, payload) => {
      presence.handleSignal(from, payload);
      files.handleSignal(from, payload);
    },
  });

  // After the room, which it needs the code of: every reference to `files`
  // above is inside a callback the room invokes later, never during this
  // render.
  const files = useFileTransfer({
    peerId,
    // The transport's own method, not a wrapper: useFileTransfer memoises on
    // this identity, and a fresh closure each render resets the manager in a
    // loop.
    sendSignal: transport.sendSignal,
    pushToast,
    // What a received file is tagged with, so the room it belongs to is what
    // decides whether this device keeps seeding it.
    roomCode: room.roomCode,
  });

  const editor = useClipEditor({
    pushToast,
    editorRef,
    onSubmit: () => void sendClip(),
  });

  useEffect(() => {
    senderIdRef.current = getSessionSenderId();
  }, []);

  // The header's edge treatment appears only once content is actually beneath
  // it. A sentinel costs nothing; a scroll listener would run on every frame.
  useEffect(() => {
    const sentinel = scrollSentinelRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const joinFromRoute = useEffectEvent((requestedRoom: string) => {
    void joinExistingRoom(requestedRoom, true);
  });

  useEffect(() => {
    const requestedRoom = normalizeRoomCode(initialRoomCode);

    if (!requestedRoom || room.initializedRoomRef.current === requestedRoom) {
      return;
    }

    room.initializedRoomRef.current = requestedRoom;
    joinFromRoute(requestedRoom);
  }, [initialRoomCode, room.initializedRoomRef]);

  useEffect(() => {
    const confirmReset = confirmResetRef;
    const clearConfirmReset = clearConfirmResetRef;
    return () => {
      clearTimer(confirmReset);
      clearTimer(clearConfirmReset);
    };
  }, []);

  useEffect(() => {
    // Dropping a file outside the panel would otherwise navigate away from the room.
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
      }
    };
    document.addEventListener("dragover", preventFileNavigation);
    document.addEventListener("drop", preventFileNavigation);
    return () => {
      document.removeEventListener("dragover", preventFileNavigation);
      document.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // OS share sheet. /share reads what the service worker parked and offers the
  // rooms open in other tabs; a room tab answers and takes the share. Without
  // BroadcastChannel only the create/join path is left, which still works.

  const inRoom = Boolean(room.roomCode) && !room.locked;

  const handleShareMessage = useEffectEvent((message: ShareMessage) => {
    const channel = shareChannelRef.current;
    const tabId = shareTabIdRef.current;
    switch (message.type) {
      case "probe":
        // Only a tab that is in a room takes shares, whichever page it loaded
        // as; the share page still choosing one is not.
        if (inRoom && room.roomCode) {
          channel?.postMessage({ type: "here", tabId, code: room.roomCode });
        }
        return;
      case "here":
        // One button per room: several tabs in the same room would all take it.
        if (share) {
          setShareRooms((current) =>
            current.some((room) => room.code === message.code)
              ? current
              : [...current, { code: message.code, tabId: message.tabId }],
          );
        }
        return;
      case "deliver":
        if (message.tabId === tabId && inRoom) {
          applyShare(message.share);
          channel?.postMessage({ type: "delivered", tabId });
        }
        return;
      case "delivered": {
        const pending = shareDeliveryRef.current;
        if (pending && pending.tabId === message.tabId) {
          window.clearTimeout(pending.timer);
          shareDeliveryRef.current = null;
          holdShare(null);
          setShareState({ phase: "delivered", code: pending.code });
        }
        return;
      }
    }
  });

  const probeForRooms = useEffectEvent(() => {
    if (share) {
      shareChannelRef.current?.postMessage({ type: "probe" });
    }
  });

  useEffect(() => {
    shareTabIdRef.current = createRandomId();
    if (typeof BroadcastChannel === "undefined") {
      return;
    }
    const channel = new BroadcastChannel(SHARE_CHANNEL);
    shareChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isShareMessage(event.data)) {
        handleShareMessage(event.data);
      }
    };
    // A room opened in another tab after this page loaded answers the next probe.
    window.addEventListener("focus", probeForRooms);
    return () => {
      window.removeEventListener("focus", probeForRooms);
      channel.close();
      shareChannelRef.current = null;
      const pending = shareDeliveryRef.current;
      if (pending) {
        window.clearTimeout(pending.timer);
        shareDeliveryRef.current = null;
      }
    };
  }, []);

  const receiveCachedShare = useEffectEvent((pending: PendingShare | null) => {
    holdShare(pending);
    setShareState(
      pending ? { phase: "ready", summary: describeShare(pending) } : { phase: "empty" },
    );
    probeForRooms();
  });

  const onSharePage = Boolean(share) && !share?.error;

  useEffect(() => {
    if (!onSharePage) {
      return;
    }
    let active = true;
    void claimCachedShare().then((pending) => {
      if (active) {
        receiveCachedShare(pending);
      }
    });
    return () => {
      active = false;
    };
  }, [onSharePage]);

  function sendShareToRoom(code: RoomCode) {
    const channel = shareChannelRef.current;
    const target = shareRooms.find((room) => room.code === code);
    // Taken and put straight back: the share stays held until a tab confirms,
    // so creating or joining a room still carries it if this one never does.
    const pending = takeHeldShare();
    holdShare(pending);
    if (!channel || !target || !pending || shareDeliveryRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      shareDeliveryRef.current = null;
      setShareRooms((current) => current.filter((room) => room.tabId !== target.tabId));
      pushToast(`Room ${code} didn't answer. Is that tab still open?`, "error");
    }, SHARE_DELIVERY_TIMEOUT_MS);
    shareDeliveryRef.current = { tabId: target.tabId, code, timer };
    channel.postMessage({ type: "deliver", tabId: target.tabId, share: pending });
  }

  function applyShare(pending: PendingShare) {
    if (pending.text) {
      editor.change(editor.text ? `${editor.text}\n${pending.text}` : pending.text);
      pushToast("Shared text is in the editor. Send it when you're ready.", "info");
    }
    if (pending.files.length > 0) {
      queuedShareFilesRef.current.push(...pending.files);
      if (room.realtimeReady) {
        offerQueuedShareFiles();
      }
    }
  }

  // A share held on /share until a room was created or joined. The room opens
  // in this same tab, so it is claimed as soon as the room is readable.
  const claimHeldShare = useEffectEvent(() => {
    const pending = takeHeldShare();
    if (pending) {
      applyShare(pending);
    }
  });

  useEffect(() => {
    if (inRoom) {
      claimHeldShare();
    }
  }, [inRoom]);

  function offerQueuedShareFiles() {
    const queued = queuedShareFilesRef.current;
    queuedShareFilesRef.current = [];
    shareFiles(queued.slice(0, MAX_FILES_PER_SHARE));
    if (queued.length > MAX_FILES_PER_SHARE) {
      pushToast(
        `Only the first ${MAX_FILES_PER_SHARE} shared files were offered.`,
        "info",
      );
    }
  }

  const offerQueuedOnceLive = useEffectEvent(() => {
    if (queuedShareFilesRef.current.length > 0) {
      offerQueuedShareFiles();
    }
  });

  useEffect(() => {
    if (inRoom && room.realtimeReady) {
      offerQueuedOnceLive();
    }
  }, [inRoom, room.realtimeReady]);

  function updateUrl(code: RoomCode | null, encodedKey: string | null) {
    // The fragment has to be restated on every replace, or the router drops it
    // — and the fragment is where the room key lives, so losing it locks the
    // tab out of its own room on the next navigation. Passed in rather than
    // read from state, because the first call comes before that state settles.
    // It stays a fragment and never becomes a path segment or a query
    // parameter: those are sent to the server, and this must not be.
    const fragment = code ? roomKeyFragment(encodedKey) : "";
    const path = code ? `/room/${code}` : "/";
    // Written through the History API, which the router follows, and never
    // navigated to. The landing page and the room page each render their own
    // copy of this component, so a navigation between them unmounts the one
    // holding the live room: the landing page flashes back, the socket drops,
    // and the room is joined a second time from the URL. The router also
    // remembers the page it loaded with its fragment still attached and
    // appends the one it is handed to that, which turns `#k=…` into
    // `#k=…#k=…` — a key that no longer parses, and so a room that opens
    // locked on the next reload.
    window.history.replaceState(null, "", `${path}${fragment}`);
  }

  function toggleTheme() {
    setTheme(resolvedTheme === "light" ? "dark" : "light");
  }

  async function toggleNotifications() {
    if (notificationsOn) {
      disableNotifications();
      pushToast("Notifications off.", "info");
      return;
    }

    const result = await enableNotifications();
    if (result === "on") {
      pushToast("You'll be notified of clips that arrive in the background.", "success");
    } else if (result === "denied") {
      pushToast(
        "Notifications are blocked. Allow them in the browser's site settings.",
        "info",
      );
    } else {
      pushToast("This browser does not support notifications.", "info");
    }
  }

  function closeOverlays() {
    setShowQrSheet(false);
    setShowDevices(false);
    setShowShortcuts(false);
    setShowPalette(false);
    setPlayingId(null);
  }

  /**
   * `secret` marks a key the user actually has to carry — a generated one. An
   * open room's key is derived from its code, so it is not put in the URL or
   * offered for copying: there would be nothing to keep.
   */
  async function hydrateRoom(
    nextRoomCode: RoomCode,
    key: RoomKey | null,
    secret: boolean,
  ) {
    try {
      await room.hydrate(nextRoomCode, key);
    } catch (error) {
      setRoomKeyEncoded(null);
      throw error;
    }
    const shareable = key && secret ? key.encoded : null;
    setRoomKeyEncoded(shareable);
    editor.reset();
    closeOverlays();
    setKeyPrompt(null);
    updateUrl(nextRoomCode, shareable);
  }

  /**
   * Two kinds of room. A private one generates a key here that is never sent,
   * so the server cannot read it; an open one derives its key from the room
   * code, so the code alone opens it and there is nothing extra to pass on —
   * at the cost of the server being able to derive that key too.
   */
  async function createRoom(privateRoom: boolean) {
    setIsBusy(true);
    try {
      if (privateRoom) {
        const key = await generateRoomKey();
        // The erase check has to go with the request that makes the room:
        // there is no later moment at which it can safely be set.
        const response = await createRoomRequest(
          key.check,
          undefined,
          key.eraseCheck,
        );
        await hydrateRoom(response.code, key, true);
        pushToast("Private room created — share the link or the key.", "success");
        return;
      }

      const response = await createRoomRequest();
      await hydrateRoom(
        response.code,
        await deriveOpenRoomKey(response.code),
        false,
      );
      pushToast("Open room created — the code is all anyone needs.", "success");
    } catch (error) {
      room.fail();
      pushToast(
        error instanceof Error ? error.message : "Could not create room.",
        "error",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function joinExistingRoom(nextRoomCode: string, fromLink = false) {
    const normalized = normalizeRoomCode(nextRoomCode);
    if (!validateRoomCode(normalized)) {
      pushToast("Enter a valid 6-character room code.", "info");
      return;
    }

    // A shared link carries the key in its fragment; a code read aloud or typed
    // in does not.
    const fragmentKey =
      typeof window === "undefined"
        ? null
        : parseRoomKeyFromHash(window.location.hash);
    const fromFragment = fragmentKey ? await importRoomKey(fragmentKey) : null;
    if (fromFragment) {
      await joinWithKey(normalized, fromFragment, fromLink, true);
      return;
    }

    // No key in hand, so ask the room which kind it is before picking one. An
    // open room's key comes from its code; a private one has to be unlocked,
    // and until it is, the room is joined but unreadable rather than refused.
    setIsBusy(true);
    let key: RoomKey | null;
    let secret = false;
    try {
      const peek = await connectRoom(normalized);
      if (peek.room.keyCheck) {
        key = null;
        secret = true;
      } else {
        key = await deriveOpenRoomKey(normalized);
      }
    } catch (error) {
      room.fail();
      pushToast(
        error instanceof Error ? error.message : "Room not found.",
        "error",
      );
      return;
    } finally {
      setIsBusy(false);
    }

    await joinWithKey(normalized, key, fromLink, secret);
  }

  async function joinWithKey(
    normalized: RoomCode,
    key: RoomKey | null,
    fromLink: boolean,
    secret: boolean,
  ) {
    setIsBusy(true);
    try {
      await hydrateRoom(normalized, key, secret);
      pushToast(
        key === null
          ? "Joined, but locked — enter the room key to read it."
          : fromLink
            ? "Joined room from link."
            : "Joined room.",
        key === null ? "info" : "success",
      );
    } catch (error) {
      if (error instanceof RoomKeyMismatchError) {
        // The room is real and reachable; only the key is wrong. Joining it
        // locked beats bouncing back to the landing page — the room is there,
        // the countdown runs, and the key can arrive by another route.
        await hydrateRoom(normalized, null, true).catch(() => {});
        setKeyPrompt({ code: normalized, mismatch: true });
        return;
      }
      room.fail();
      room.setRoomCode(null);
      updateUrl(null, null);
      pushToast(
        error instanceof Error ? error.message : "Room not found.",
        "error",
      );
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Leaving discards the room and its history with no way back, so it asks
   * once. The confirmation lapses on its own rather than sticking around as a
   * second thing to dismiss.
   */
  /**
   * Two taps, like leaving, and for a better reason: this deletes the room's
   * clips on every device, and there is nothing to undo it with.
   */
  function requestClearHistory() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      clearTimer(clearConfirmResetRef);
      clearConfirmResetRef.current = window.setTimeout(() => {
        setConfirmingClear(false);
        clearConfirmResetRef.current = null;
      }, CONFIRM_WINDOW_MS);
      return;
    }

    clearTimer(clearConfirmResetRef);
    setConfirmingClear(false);
    void room.clear().then((cleared) => {
      if (cleared) {
        pushToast("History cleared.", "success");
      }
    });
  }

  async function deleteHistoryItem(id: number) {
    if (await room.remove(id)) {
      pushToast("Clip deleted.", "success");
    }
  }

  function requestLeave() {
    if (!confirmingLeave) {
      setConfirmingLeave(true);
      clearTimer(confirmResetRef);
      confirmResetRef.current = window.setTimeout(() => {
        setConfirmingLeave(false);
        confirmResetRef.current = null;
      }, CONFIRM_WINDOW_MS);
      return;
    }

    clearTimer(confirmResetRef);
    setConfirmingLeave(false);
    leaveRoom();
  }

  function leaveRoom() {
    files.reset();
    room.leave();
    editor.reset();
    setJoinCode("");
    closeOverlays();
    setKeyPrompt(null);
    // Cleared before the URL is rewritten, so the fragment goes with it and
    // the key is not left sitting in the address bar of a room we have left.
    setRoomKeyEncoded(null);
    updateUrl(null, null);
    pushToast("Left room.", "info");
  }

  async function sendClip() {
    const text = editor.text.trim();
    // Silent: the Send button and the shortcut are both disabled in this
    // state, and an empty box does not need to be told it is empty.
    if (!text || text.length > MAX_CLIP_CHARS) {
      return;
    }

    setIsBusy(true);
    try {
      if (await room.send(text)) {
        editor.reset();
      }
    } finally {
      setIsBusy(false);
    }
  }

  function roomUrl(code: RoomCode, withKey: boolean) {
    return buildRoomUrl(
      code,
      window.location.href,
      withKey ? (roomKeyEncoded ?? undefined) : undefined,
    );
  }

  async function copyRoomLink(code: RoomCode) {
    try {
      await writeClipboard(roomUrl(code, true));
      pushToast("Room link copied!", "success");
    } catch {
      pushToast("Could not copy room link.", "error");
    }
  }

  /**
   * The link without its key, for sending the two through different channels.
   * A link that carries the key hands the whole room to whatever app forwards
   * it; split them and no single channel has both halves.
   */
  async function copyRoomLinkWithoutKey(code: RoomCode) {
    try {
      await writeClipboard(roomUrl(code, false));
      pushToast("Link copied without the key — send the key separately.", "success");
    } catch {
      pushToast("Could not copy room link.", "error");
    }
  }

  /** For the device that has to read a key out to one joining by code. */
  async function copyRoomKey() {
    if (!roomKeyEncoded) {
      return;
    }
    try {
      await writeClipboard(formatRoomKey(roomKeyEncoded));
      pushToast("Room key copied — share it only with people you trust.", "success");
    } catch {
      pushToast("Could not copy room key.", "error");
    }
  }

  async function submitRoomKey(encoded: string) {
    const key = await importRoomKey(encoded);
    if (!key) {
      setKeyPrompt((current) =>
        current ? { ...current, mismatch: true } : current,
      );
      return;
    }
    await joinWithKey(keyPrompt?.code ?? "", key, false, true);
  }

  async function shareRoom(code: RoomCode) {
    const url = roomUrl(code, true);

    if (navigator.share) {
      try {
        await navigator.share({
          title: "CLIPLINK room",
          // The link lives in `text`, not in the `url` field. Several targets
          // — Telegram among them — forward only `text`, which turned the
          // share into a room code with no way to reach it. Targets that build
          // a rich preview find the URL in the body just as well.
          text: `Join my CLIPLINK room ${code}\n${url}`,
        });
        return;
      } catch (error) {
        // Dismissing the share sheet rejects with AbortError. Deciding not to
        // share is not a failure, and saying so is a scold for using the
        // cancel button as intended.
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        // Anything else: fall through and put the link on the clipboard, which
        // is the outcome the user was after either way.
      }
    }

    try {
      await writeClipboard(url);
      pushToast("Room link copied!", "success");
    } catch {
      pushToast("Could not share the room link.", "error");
    }
  }

  async function copyHistoryItem(text: string) {
    try {
      await writeClipboard(text);
      pushToast("Clip copied!", "success");
    } catch {
      pushToast("Could not copy clip.", "error");
    }
  }

  function shareEntries(entries: ShareEntry[]) {
    if (entries.length === 0) {
      return;
    }
    if (!room.realtimeReady) {
      pushToast("File transfer needs a live connection.", "info");
      return;
    }
    files.offerFiles(entries);
  }

  function shareFiles(list: FileList | File[] | null) {
    shareEntries(list ? entriesFromFileList(list) : []);
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) {
      return;
    }
    event.preventDefault();
    shareFiles(pasted);
  }

  function hasDraggedFiles(event: ReactDragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = room.realtimeReady ? "copy" : "none";
    setDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    setDragActive(false);
    // Read before the handler returns: the DataTransfer empties afterwards.
    entriesFromDataTransfer(event.dataTransfer, MAX_FILES_PER_SHARE).then(
      shareEntries,
      () => pushToast("Could not read the dropped files.", "error"),
    );
  }

  const roomCode = room.roomCode;
  const joined = Boolean(roomCode);
  const latestIncoming = room.history.find(
    (clip) => clip.direction === "incoming",
  );
  // The player counts: its media keys (space, arrows) must not reach the
  // room's single-letter shortcuts.
  const sheetOpen =
    showQrSheet ||
    showDevices ||
    showShortcuts ||
    showPalette ||
    playingId !== null;
  const expiresIn = useRoomExpiry(room.expiresAt);
  const status = room.locked
    ? { label: "Locked", tone: "warn" as const }
    : statusFor(room.status, room.realtimeReady);
  const trimmedLength = editor.text.trim().length;
  const canSend =
    trimmedLength > 0 && trimmedLength <= MAX_CLIP_CHARS && !room.locked;

  const actions = createRoomActions({
    joined,
    realtimeReady: room.realtimeReady,
    hasText: Boolean(editor.text.trim()),
    canSend,
    hasUndo: Boolean(editor.clearedText),
    hasIncoming: Boolean(latestIncoming),
    canClearHistory: room.erasable && room.history.length > 0,
    clearHistory: requestClearHistory,
    send: () => void sendClip(),
    copyRoomLink: () => void copyRoomLink(roomCode!),
    copyRoomKey: () => void copyRoomKey(),
    copyRoomLinkWithoutKey: () => void copyRoomLinkWithoutKey(roomCode!),
    hasRoomKey: Boolean(roomKeyEncoded),
    locked: room.locked,
    enterRoomKey: () =>
      setKeyPrompt({ code: roomCode!, mismatch: false }),
    shareRoom: () => void shareRoom(roomCode!),
    openQr: () => setShowQrSheet(true),
    openDevices: () => setShowDevices(true),
    leave: requestLeave,
    attach: () => fileInputRef.current?.click(),
    attachFolder: () => folderInputRef.current?.click(),
    pasteFromDevice: () => void editor.pasteFromDevice(),
    clearEditor: editor.clear,
    undoClear: editor.undoClear,
    copyLatestIncoming: () =>
      void copyHistoryItem(latestIncoming?.text ?? ""),
    focusEditor: () => editor.focus(),
    toggleTheme,
    notificationsOn,
    toggleNotifications: () => void toggleNotifications(),
    openShortcuts: () => setShowShortcuts(true),
    openPalette: () => setShowPalette(true),
  });

  useShortcuts({
    actions,
    active: joined,
    blocked: sheetOpen,
    onDigit: (index) => {
      const clip = room.history[index];
      if (clip) {
        void copyHistoryItem(clip.text);
      }
    },
    // Escape unwinds the most recent thing the user started, innermost first.
    // Sheets are excluded here because each one handles its own Escape.
    onEscape: () => {
      if (confirmingLeave) {
        clearTimer(confirmResetRef);
        setConfirmingLeave(false);
        return;
      }
      if (confirmingClear) {
        clearTimer(clearConfirmResetRef);
        setConfirmingClear(false);
        return;
      }
      editor.blur();
    },
    onTypeahead: () => editor.focus(),
  });

  // Carries the key, because the code is drawn here rather than fetched from a
  // service that would be handed the URL to draw it.
  const roomShareUrl = roomCode
    ? buildRoomUrl(
        roomCode,
        typeof window !== "undefined" ? window.location.href : "",
        roomKeyEncoded ?? undefined,
      )
    : "";

  return (
    <>
      <div className="flex min-h-screen flex-col">
        <header
          data-scrolled={scrolled}
          // A translucent material with content scrolling beneath it. The
          // hairline appears only once there is something under the bar to
          // separate from; at rest the bar is part of the page.
          className="sticky top-0 z-30 flex items-center justify-between px-4 py-3 shadow-[0_1px_0_transparent] backdrop-blur-(--chrome-blur) backdrop-saturate-180 transition-shadow duration-200 data-[scrolled=true]:shadow-[0_1px_0_var(--border)] sm:px-5 md:px-8 md:py-4"
          style={headerSurfaceStyle}
        >
          <Wordmark />
          <div className="flex items-center gap-2 md:gap-3">
            {/* There is nothing to be connected to before a room exists, and
                "Offline" on the landing screen reads as a fault when none has
                happened. */}
            {joined ? (
              <Badge
                variant="secondary"
                className="h-7 gap-1.5 px-2.5 text-muted-foreground"
                aria-live="polite"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full transition-colors duration-200",
                    DOT_TONE[status.tone],
                  )}
                />
                {status.label}
              </Badge>
            ) : null}
            {joined ? (
              <Button
                variant="secondary"
                size="icon"
                aria-label="Keyboard shortcuts"
                aria-keyshortcuts="?"
                onClick={() => setShowShortcuts(true)}
              >
                <span aria-hidden="true" className="text-sm font-semibold">
                  ?
                </span>
              </Button>
            ) : null}
            {repoLink}
            <Button
              variant="secondary"
              size="icon"
              aria-label={
                mounted && resolvedTheme === "light"
                  ? "Switch to dark theme"
                  : "Switch to light theme"
              }
              aria-keyshortcuts="T"
              onClick={toggleTheme}
            >
              <IconTheme
                size={16}
                theme={mounted && resolvedTheme === "light" ? "light" : "dark"}
              />
            </Button>
          </div>
        </header>

        <div ref={scrollSentinelRef} aria-hidden="true" className="h-px" />

        <main className="flex flex-1 justify-center px-4 py-8 pb-12 md:px-6 md:py-16 md:pb-18">
          <div className="w-full max-w-3xl">
            {!joined && share ? (
              <ShareBanner
                state={shareState}
                rooms={shareRooms.map((room) => room.code)}
                onSendToRoom={sendShareToRoom}
              />
            ) : null}
            {!joined ? (
              <LandingView
                joinCode={joinCode}
                isBusy={isBusy}
                onJoinCodeChange={setJoinCode}
                onCreate={(privateRoom) => void createRoom(privateRoom)}
                onJoin={() => void joinExistingRoom(joinCode)}
              />
            ) : (
              <section className="flex w-full flex-col gap-5 md:gap-6">
                <RoomHeader
                  roomCode={roomCode!}
                  qrOpen={showQrSheet}
                  confirmingLeave={confirmingLeave}
                  onCopyLink={() => void copyRoomLink(roomCode!)}
                  onShare={() => void shareRoom(roomCode!)}
                  onOpenQr={() => setShowQrSheet(true)}
                  onLeave={requestLeave}
                  expiresIn={expiresIn}
                  deviceCount={presence.deviceCount}
                  devicesOpen={showDevices}
                  onOpenDevices={() => setShowDevices(true)}
                />

                <ClipEditor
                  editor={editor}
                  realtimeReady={room.realtimeReady}
                  locked={room.locked}
                  dragActive={dragActive}
                  isBusy={isBusy}
                  canSend={canSend}
                  arrival={room.arrivalId !== null}
                  fileInputRef={fileInputRef}
                  folderInputRef={folderInputRef}
                  editorRef={editorRef}
                  onSend={() => void sendClip()}
                  onFilesPicked={shareFiles}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onPaste={handlePaste}
                />

                <FileTransfers
                  items={files.items}
                  canTransfer={room.realtimeReady}
                  onDownload={files.request}
                  onDownloadAll={files.downloadAll}
                  onDownloadZip={files.downloadZip}
                  onCancel={files.cancel}
                  onSave={files.save}
                  onRevoke={files.revoke}
                  onDismiss={files.dismiss}
                  onPlay={setPlayingId}
                />

                <HistoryList
                  history={room.history}
                  arrivalId={room.arrivalId}
                  enteringIds={room.enteringIds}
                  onCopy={(text) => void copyHistoryItem(text)}
                  onDelete={
                    room.erasable
                      ? (id) => void deleteHistoryItem(id)
                      : undefined
                  }
                  onClear={room.erasable ? requestClearHistory : undefined}
                  confirmingClear={confirmingClear}
                />
              </section>
            )}
          </div>
        </main>
      </div>

      {joined ? (
        <QrSheet
          open={showQrSheet}
          roomCode={roomCode!}
          shareUrl={roomShareUrl}
          roomKey={formatRoomKey(roomKeyEncoded ?? "")}
          onClose={() => setShowQrSheet(false)}
          onCopyLink={() => void copyRoomLink(roomCode!)}
          onCopyKey={() => void copyRoomKey()}
          onShare={() => void shareRoom(roomCode!)}
        />
      ) : null}

      {joined ? (
        <DevicesSheet
          open={showDevices}
          devices={presence.devices}
          onClose={() => setShowDevices(false)}
        />
      ) : null}

      <KeyPrompt
        open={keyPrompt !== null}
        roomCode={keyPrompt?.code ?? ""}
        mismatch={keyPrompt?.mismatch ?? false}
        onClose={() => setKeyPrompt(null)}
        onSubmit={(value) => void submitRoomKey(value)}
      />

      <PlayerSheet
        item={
          playingId === null
            ? null
            : (files.items.find((item) => item.id === playingId) ?? null)
        }
        onClose={() => setPlayingId(null)}
      />

      <ShortcutsSheet
        open={showShortcuts}
        actions={actions}
        onClose={() => setShowShortcuts(false)}
      />

      {joined ? (
        <CommandPalette
          open={showPalette}
          actions={actions}
          onClose={() => setShowPalette(false)}
        />
      ) : null}

      {/* Above the sheets, as the old toast column was: a toast raised
          from inside a sheet must not be hidden behind its scrim. */}
      <Toaster position="bottom-center" visibleToasts={3} className="z-90!" />
    </>
  );
}
