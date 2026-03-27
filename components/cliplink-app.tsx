"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  MAX_SESSION_HISTORY,
  POLL_INTERVAL_MS,
} from "@/lib/cliplink/constants";
import { readClipboard, writeClipboard } from "@/lib/cliplink/clipboard";
import {
  formatCharCount,
  formatHistoryTime,
  truncatePreview,
} from "@/lib/cliplink/format";
import { createPollingTransport, createRoomRequest } from "@/lib/cliplink/http";
import { buildRoomUrl, normalizeRoomCode } from "@/lib/cliplink/room-code";
import { getSessionSenderId } from "@/lib/cliplink/session";
import type { RoomCode, RoomStatus, SessionClip } from "@/lib/cliplink/types";
import { validateRoomCode } from "@/lib/cliplink/validation";

type ToastTone = "success" | "info" | "error";

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ThemeMode = "dark" | "light";

const transport = createPollingTransport();
const THEME_STORAGE_KEY = "cliplink:theme";

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

function statusLabel(status: RoomStatus) {
  switch (status) {
    case "live":
      return "LIVE";
    case "syncing":
      return "SYNCING";
    case "error":
      return "ERROR";
    default:
      return "OFFLINE";
  }
}

function IconPlus() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 5V19M5 12H19"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="9"
        y="9"
        width="13"
        height="13"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function IconTheme({ theme }: { theme: ThemeMode }) {
  if (theme === "light") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 3V5M12 19V21M4.93 4.93L6.34 6.34M17.66 17.66L19.07 19.07M3 12H5M19 12H21M4.93 19.07L6.34 17.66M17.66 6.34L19.07 4.93M16 12A4 4 0 1 1 8 12A4 4 0 0 1 16 12Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function CliplinkApp() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [roomCode, setRoomCode] = useState<RoomCode | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [editorText, setEditorText] = useState("");
  const [history, setHistory] = useState<SessionClip[]>([]);
  const [status, setStatus] = useState<RoomStatus>("offline");
  const [isBusy, setIsBusy] = useState(false);
  const [flashActive, setFlashActive] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [theme, setTheme] = useState<ThemeMode>("dark");

  const senderIdRef = useRef("");
  const lastSeenIdRef = useRef(0);
  const roomCodeRef = useRef<RoomCode | null>(null);
  const pollingRef = useRef<number | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const syncResetRef = useRef<number | null>(null);
  const initializedRoomRef = useRef<string | null>(null);

  useEffect(() => {
    senderIdRef.current = getSessionSenderId();
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
      return;
    }

    document.documentElement.dataset.theme = "dark";
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  const joinFromSearchParams = useEffectEvent((requestedRoom: string) => {
    void joinExistingRoom(requestedRoom, true);
  });

  useEffect(() => {
    const requestedRoom = normalizeRoomCode(searchParams.get("room"));

    if (!requestedRoom || initializedRoomRef.current === requestedRoom) {
      return;
    }

    initializedRoomRef.current = requestedRoom;
    joinFromSearchParams(requestedRoom);
  }, [searchParams]);

  useEffect(() => {
    return () => {
      stopPolling();
      stopStream();
      clearSyncReset();
      transport.disconnect();
    };
  }, []);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      roomCodeRef.current
    ) {
      event.preventDefault();
      void sendClip();
    }
  });

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function pushToast(message: string, tone: ToastTone = "info") {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 2500);
  }

  function updateUrl(code: RoomCode | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (code) {
      next.set("room", code);
    } else {
      next.delete("room");
    }

    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  function clearSyncReset() {
    if (syncResetRef.current) {
      window.clearTimeout(syncResetRef.current);
      syncResetRef.current = null;
    }
  }

  function markSyncing() {
    clearSyncReset();
    setStatus("syncing");
    syncResetRef.current = window.setTimeout(() => {
      setStatus("live");
      syncResetRef.current = null;
    }, 600);
  }

  function triggerFlash() {
    setFlashActive(false);
    window.requestAnimationFrame(() => {
      setFlashActive(true);
      window.setTimeout(() => setFlashActive(false), 300);
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

  function applyIncomingClips(clips: SessionClip[]) {
    if (clips.length === 0) {
      return;
    }

    setHistory((current) => mergeHistory(current, clips));
    setStatus("live");
    triggerFlash();
    const latest = clips[0];
    void autoCopyIncoming(latest.text);
  }

  function startRealtime(nextRoomCode: RoomCode) {
    stopPolling();
    stopStream();
    const cleanup = transport.streamClips(nextRoomCode, lastSeenIdRef.current, {
      onClips: (clips) => {
        const incoming = clips
          .filter((clip) => clip.senderId !== senderIdRef.current)
          .map((clip) => ({
            ...clip,
            direction: "incoming" as const,
          }));

        for (const clip of clips) {
          lastSeenIdRef.current = Math.max(lastSeenIdRef.current, clip.id);
        }

        applyIncomingClips(incoming.reverse());
      },
      onDisconnect: (reason) => {
        streamCleanupRef.current = null;
        if (reason === "error" && roomCodeRef.current === nextRoomCode) {
          startPolling(nextRoomCode);
          pushToast("Realtime connection dropped. Falling back to polling.", "info");
        }
      },
    });

    if (!cleanup) {
      startPolling(nextRoomCode);
      return;
    }

    streamCleanupRef.current = cleanup;
  }

  async function copyRoomLink(code: RoomCode) {
    try {
      const url = buildRoomUrl(code, window.location.href);
      await writeClipboard(url);
      pushToast("Room link copied!", "success");
    } catch {
      pushToast("Could not copy room link.", "error");
    }
  }

  async function shareRoom(code: RoomCode) {
    const url = buildRoomUrl(code, window.location.href);

    try {
      if (navigator.share) {
        await navigator.share({
          title: "CLIPLINK room",
          text: `Join my CLIPLINK room: ${code}`,
          url,
        });
        pushToast("Room link shared!", "success");
        return;
      }

      await writeClipboard(url);
      pushToast("Room link copied!", "success");
    } catch {
      pushToast("Could not share the room link.", "error");
    }
  }

  async function autoCopyIncoming(text: string) {
    try {
      await writeClipboard(text);
      pushToast("Received clip — copied!", "success");
    } catch {
      pushToast("Received clip. Clipboard access was blocked.", "info");
    }
  }

  async function hydrateRoom(nextRoomCode: RoomCode) {
    const response = await transport.connect(nextRoomCode);
    const nextHistory = sortClipsNewestFirst(
      response.clips.map((clip) => ({
        ...clip,
        direction:
          clip.senderId === senderIdRef.current ? "outgoing" : "incoming",
      })),
    ).slice(0, MAX_SESSION_HISTORY);

    setRoomCode(nextRoomCode);
    setHistory(nextHistory);
    setStatus("live");
    setEditorText("");
    lastSeenIdRef.current = response.clips.reduce(
      (highest, clip) => Math.max(highest, clip.id),
      0,
    );
    updateUrl(nextRoomCode);
    startRealtime(nextRoomCode);
  }

  async function createRoom() {
    setIsBusy(true);
    try {
      const response = await createRoomRequest();
      await hydrateRoom(response.code);
      pushToast("Room created!", "success");
    } catch (error) {
      setStatus("error");
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

    setIsBusy(true);
    try {
      await hydrateRoom(normalized);
      pushToast(
        fromLink ? "Joined room from link." : "Joined room.",
        "success",
      );
    } catch (error) {
      setStatus("error");
      setRoomCode(null);
      updateUrl(null);
      pushToast(
        error instanceof Error ? error.message : "Room not found.",
        "error",
      );
    } finally {
      setIsBusy(false);
    }
  }

  function leaveRoom() {
    stopPolling();
    stopStream();
    clearSyncReset();
    transport.disconnect();
    setRoomCode(null);
    setHistory([]);
    setEditorText("");
    setJoinCode("");
    setStatus("offline");
    lastSeenIdRef.current = 0;
    updateUrl(null);
    pushToast("Left room.", "info");
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

      if (response.clips.length > 0) {
        lastSeenIdRef.current = response.clips.reduce(
          (highest, clip) => Math.max(highest, clip.id),
          lastSeenIdRef.current,
        );
      }

      if (incoming.length === 0) {
        return;
      }

      const additions: SessionClip[] = incoming.map((clip) => ({
        ...clip,
        direction: "incoming",
      }));

      applyIncomingClips(additions.reverse());
    } catch (error) {
      setStatus("error");
      pushToast(
        error instanceof Error ? error.message : "Polling failed.",
        "error",
      );
    }
  }

  async function sendClip() {
    if (!roomCodeRef.current) {
      return;
    }

    const text = editorText.trim();
    if (!text) {
      pushToast("Nothing to send.", "info");
      return;
    }

    setIsBusy(true);
    try {
      const response = await transport.sendClip(roomCodeRef.current, {
        text,
        senderId: senderIdRef.current,
      });

      const sessionClip: SessionClip = {
        ...response.clip,
        direction: "outgoing",
      };

      setHistory((current) => mergeHistory(current, [sessionClip]));
      setEditorText("");
      lastSeenIdRef.current = Math.max(lastSeenIdRef.current, response.clip.id);
      markSyncing();
      pushToast("Sent!", "success");
    } catch (error) {
      setStatus("error");
      pushToast(
        error instanceof Error ? error.message : "Could not send clip.",
        "error",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function pasteFromDevice() {
    try {
      const text = await readClipboard();
      setEditorText(text);
    } catch {
      pushToast(
        "Clipboard access denied. Paste manually with Ctrl/Cmd+V.",
        "info",
      );
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

  const joined = Boolean(roomCode);

  return (
    <>
      <div className="cliplink-shell">
        <header className="cliplink-header">
          <div className="cliplink-logo">
            CLIP<span>LINK</span>
          </div>
          <div className="header-actions">
            <div className="status-pill" aria-live="polite">
              <div
                className={`status-dot ${status === "offline" ? "" : status}`}
              />
              <span>{statusLabel(status)}</span>
            </div>
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
            >
              <IconTheme theme={theme} />
              {/* {theme === "dark" ? "Light" : "Dark"} */}
            </button>
          </div>
        </header>

        <main className="cliplink-main">
          <div className="cliplink-stage">
            {!joined ? (
              <section className="landing-view">
                <div className="hero-copy">
                  <h1>
                    Copy here.
                    <em>Paste anywhere.</em>
                  </h1>
                  <p>
                    Create a room. Share the code.
                    <br />
                    Your clipboard, synced across devices.
                  </p>
                </div>

                <div className="action-stack">
                  <button
                    className="btn btn-primary"
                    onClick={() => void createRoom()}
                    disabled={isBusy}
                  >
                    <IconPlus />
                    New Room
                  </button>

                  <div className="divider">or join existing</div>

                  <div className="button-row">
                    <input
                      className="code-input"
                      type="text"
                      inputMode="text"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={6}
                      placeholder="Enter code"
                      value={joinCode}
                      onChange={(event) =>
                        setJoinCode(normalizeRoomCode(event.target.value))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void joinExistingRoom(joinCode);
                        }
                      }}
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={() => void joinExistingRoom(joinCode)}
                      disabled={isBusy}
                    >
                      Join
                    </button>
                  </div>

                  <p className="inline-note">
                    No sign-up, no install, no saved history. Rooms expire after
                    6 hours of inactivity.
                  </p>
                </div>
              </section>
            ) : (
              <section className="room-view">
                <div className="room-header">
                  <div className="room-code-display">
                    <span className="room-label">Room</span>
                    <button
                      className="room-code-badge"
                      type="button"
                      title="Copy room link"
                      onClick={() => void copyRoomLink(roomCode!)}
                    >
                      {roomCode}
                    </button>
                  </div>

                  <div className="room-actions">
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => void shareRoom(roomCode!)}
                    >
                      <IconCopy />
                      Share Link
                    </button>
                    <button
                      className="icon-btn danger"
                      type="button"
                      onClick={leaveRoom}
                    >
                      Leave
                    </button>
                  </div>
                </div>

                <div className="clip-panel">
                  <div className="panel-toolbar">
                    <span className="panel-label">Clipboard</span>
                    <div className="panel-tools">
                      <button
                        className="tool-btn"
                        type="button"
                        onClick={() => void pasteFromDevice()}
                      >
                        Paste from device
                      </button>
                      <button
                        className="tool-btn"
                        type="button"
                        onClick={() => setEditorText("")}
                      >
                        Clear
                      </button>
                      <button
                        className="tool-btn accent"
                        type="button"
                        onClick={() => void sendClip()}
                        disabled={isBusy}
                      >
                        Send ↑
                      </button>
                    </div>
                  </div>

                  <textarea
                    className="editor"
                    value={editorText}
                    placeholder="Type or paste anything here, then hit Send to sync it across devices..."
                    onChange={(event) => setEditorText(event.target.value)}
                  />
                  <div className="char-count">
                    {formatCharCount(editorText.length)}
                  </div>
                </div>

                <div className="history-section">
                  <div className="section-label">History</div>
                  <div className="history-list">
                    {history.length === 0 ? (
                      <div className="empty-state">
                        No clips yet. Send something.
                      </div>
                    ) : (
                      history.map((clip) => (
                        <div
                          key={clip.id}
                          className={`history-item ${clip.direction}`}
                        >
                          <div className="history-meta">
                            <span className="history-dir">
                              {clip.direction === "incoming" ? "↓ IN" : "↑ OUT"}
                            </span>
                            <span className="history-time">
                              {formatHistoryTime(clip.ts)}
                            </span>
                          </div>
                          <div className="history-text">
                            {truncatePreview(clip.text)}
                          </div>
                          <button
                            className="history-copy"
                            type="button"
                            onClick={() => void copyHistoryItem(clip.text)}
                          >
                            copy
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>

      <div className={`screen-flash ${flashActive ? "active" : ""}`} />
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </>
  );
}
