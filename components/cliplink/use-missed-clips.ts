"use client";

import { useEffect, useRef } from "react";

import {
  clearUnreadBadge,
  closeClipNotification,
  isPageAttended,
  setUnreadBadge,
  showClipNotification,
} from "@/lib/cliplink/attention";
import { writeClipboard } from "@/lib/cliplink/clipboard";
import type { RoomCode } from "@/lib/cliplink/types";

import { dismissToast, type PushToast } from "./use-toasts";

const COPY_PROMPT_ID = "missed-clip";

type MissedClips = {
  roomCode: RoomCode;
  /** The newest clip's text, or null when this device could not read it. */
  text: string | null;
  /** Which clip `text` is, so it can be let go of if that clip is deleted. */
  clipId: number;
  count: number;
};

/**
 * Clips that arrived while the tab was hidden or unfocused. The browser
 * refuses a clipboard write from there, so the arrival is marked and the copy
 * waits for the tab to be looked at again.
 *
 * Only the newest clip is kept: the clipboard holds one thing, and it is the
 * same one the foreground path would have left there.
 */
export function useMissedClips({ pushToast }: { pushToast: PushToast }) {
  const missedRef = useRef<MissedClips | null>(null);
  /** The clip a standing "Copy" toast is holding the text of, if one is up. */
  const offeredIdRef = useRef<number | null>(null);
  const pushToastRef = useRef(pushToast);
  useEffect(() => {
    pushToastRef.current = pushToast;
  });

  useEffect(() => {
    async function copyFromToast(text: string) {
      try {
        await writeClipboard(text);
        pushToastRef.current("Clip copied!", "success");
      } catch {
        pushToastRef.current("Could not copy clip.", "error");
      }
    }

    async function copyOnReturn(text: string, clipId: number) {
      try {
        await writeClipboard(text);
        pushToastRef.current(
          "Copied the clip that arrived while you were away.",
          "success",
          { unprompted: true },
        );
      } catch {
        // Safari and Firefox want a click before they will write, and coming
        // back to a tab is not one. The button is, so the toast waits for it.
        offeredIdRef.current = clipId;
        pushToastRef.current("A clip arrived while you were away.", "info", {
          unprompted: true,
          persistent: true,
          id: COPY_PROMPT_ID,
          action: { label: "Copy", onClick: () => void copyFromToast(text) },
        });
      }
    }

    function handleReturn() {
      const missed = missedRef.current;
      if (!missed || !isPageAttended()) {
        return;
      }
      missedRef.current = null;
      clearUnreadBadge();
      void closeClipNotification(missed.roomCode);
      // An offer to copy an older clip is out of date either way.
      dismissToast(COPY_PROMPT_ID);
      if (missed.text !== null) {
        void copyOnReturn(missed.text, missed.clipId);
      }
    }

    window.addEventListener("focus", handleReturn);
    document.addEventListener("visibilitychange", handleReturn);
    return () => {
      window.removeEventListener("focus", handleReturn);
      document.removeEventListener("visibilitychange", handleReturn);
      clearUnreadBadge();
    };
  }, []);

  function hold(
    roomCode: RoomCode,
    clip: { id: number; text: string | null },
    arrived: number,
  ) {
    const count = (missedRef.current?.count ?? 0) + arrived;
    missedRef.current = { roomCode, text: clip.text, clipId: clip.id, count };
    setUnreadBadge(count);
    void showClipNotification(roomCode, count);
  }

  function reset() {
    // The offer holds the text of a clip from a room that has been left.
    dismissToast(COPY_PROMPT_ID);
    const missed = missedRef.current;
    if (!missed) {
      return;
    }
    missedRef.current = null;
    clearUnreadBadge();
    void closeClipNotification(missed.roomCode);
  }

  /**
   * A deleted clip must not be copied on return, nor offered by a toast that
   * is still holding its text. The arrival itself stays marked: something did
   * come in while the tab was away.
   */
  function drop(ids: number[]) {
    const missed = missedRef.current;
    if (missed && missed.text !== null && ids.includes(missed.clipId)) {
      missedRef.current = { ...missed, text: null };
    }
    if (offeredIdRef.current !== null && ids.includes(offeredIdRef.current)) {
      offeredIdRef.current = null;
      dismissToast(COPY_PROMPT_ID);
    }
  }

  return { hold, drop, reset };
}
