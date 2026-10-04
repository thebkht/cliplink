import { experimental_upgradeWebSocket } from "@vercel/functions";

import {
  MAX_SIGNAL_BYTES,
  SIGNAL_RATE_MAX_MESSAGES,
  SIGNAL_RATE_WINDOW_MS,
} from "@/lib/cliplink/constants";
import { publishSignal, subscribeRoom } from "@/lib/cliplink/pubsub";
import { storage } from "@/lib/cliplink/storage";
import type {
  Clip,
  EraseClipsResponse,
  WsServerMessage,
} from "@/lib/cliplink/types";
import {
  parseClientMessage,
  validatePeerId,
  validateRoomCode,
} from "@/lib/cliplink/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return new Response("Invalid room code", { status: 400 });
  }

  const url = new URL(request.url);
  const afterParam = Number(url.searchParams.get("after") ?? "0");
  const initialAfterId =
    Number.isFinite(afterParam) && afterParam >= 0 ? afterParam : 0;

  // Peers without a valid id still receive clips; they just can't signal.
  const peerParam = url.searchParams.get("peer");
  const peerId = validatePeerId(peerParam) ? peerParam : null;

  return experimental_upgradeWebSocket(
    (ws) => {
      let closed = false;
      let lastSentId = initialAfterId;
      let backlogFlushed = false;
      const buffered: Clip[] = [];
      const bufferedErases: EraseClipsResponse[] = [];
      let signalWindowStart = Date.now();
      let signalCount = 0;

      const send = (message: WsServerMessage) => {
        if (closed) {
          return;
        }
        ws.send(JSON.stringify(message));
      };

      const sendClip = (clip: Clip) => {
        send({ type: "clip", clip });
        if (clip.id > lastSentId) {
          lastSentId = clip.id;
        }
      };

      // Subscribe before reading backlog so no clip published mid-fetch is lost.
      const sendErase = ({ ids, gen }: EraseClipsResponse) => {
        send({ type: "removed", ids, gen });
      };

      const unsubscribe = subscribeRoom(code, {
        // Held until the backlog is out, like clips: a removal sent ahead of
        // the clip it removes would be undone by the clip arriving after it.
        onErase: (erased) => {
          if (closed) {
            return;
          }
          if (!backlogFlushed) {
            bufferedErases.push(erased);
            return;
          }
          sendErase(erased);
        },
        onClip: (clip) => {
          if (closed) {
            return;
          }
          if (!backlogFlushed) {
            buffered.push(clip);
            return;
          }
          if (clip.id > lastSentId) {
            sendClip(clip);
          }
        },
        onSignal: (envelope) => {
          if (!peerId || envelope.from === peerId) {
            return;
          }
          if (envelope.kind === "peer-left") {
            send({ type: "peer-left", from: envelope.from });
            return;
          }
          if (envelope.to !== undefined && envelope.to !== peerId) {
            return;
          }
          // Relayed verbatim. The payload is sealed to the room key, which the
          // server does not have and is not meant to.
          send({ type: "signal", from: envelope.from, sealed: envelope.sealed });
        },
      });

      const allowSignal = () => {
        const now = Date.now();
        if (now - signalWindowStart >= SIGNAL_RATE_WINDOW_MS) {
          signalWindowStart = now;
          signalCount = 0;
        }
        signalCount += 1;
        return signalCount <= SIGNAL_RATE_MAX_MESSAGES;
      };

      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (closed || !peerId || isBinary || !Buffer.isBuffer(data) || !allowSignal()) {
          return;
        }

        const message = parseClientMessage(data.toString("utf8"));
        if (!message) {
          return;
        }

        void publishSignal(code, {
          kind: "sealed",
          from: peerId,
          to: message.to,
          sealed: message.sealed,
        });
      });

      void (async () => {
        try {
          const backlog = await storage.getClipsAfter(code, initialAfterId);
          if (!backlog) {
            send({ type: "error", reason: "room_not_found" });
            closed = true;
            ws.close();
            return;
          }

          for (const clip of backlog.clips) {
            sendClip(clip);
          }

          backlogFlushed = true;
          for (const clip of buffered) {
            if (clip.id > lastSentId) {
              sendClip(clip);
            }
          }
          buffered.length = 0;
          for (const erased of bufferedErases) {
            sendErase(erased);
          }
          bufferedErases.length = 0;

          // The count as the backlog was read. A backlog holds no deletions,
          // so this is how a reconnecting client learns it missed one.
          send({ type: "ready", eraseGen: backlog.eraseGen });
        } catch (error) {
          console.error("WebSocket backlog fetch failed", error);
          send({ type: "error", reason: "internal_error" });
          closed = true;
          ws.close();
        }
      })();

      ws.on("close", () => {
        closed = true;
        unsubscribe();
        if (peerId) {
          // Lets other peers drop this peer's file offers even if the tab
          // crashed. The one signal the server originates, and so the one it
          // cannot seal — it has no key.
          void publishSignal(code, { kind: "peer-left", from: peerId });
        }
      });
    },
    { maxPayload: MAX_SIGNAL_BYTES },
  );
}
