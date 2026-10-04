import { createHttpClient, resolveBaseUrl } from "./http.ts";
import type {
  RoomCode,
  SealedTransport,
  TransportOptions,
  WsClientMessage,
  WsServerMessage,
} from "./types.ts";

/**
 * `WebSocket.OPEN` as the spec fixes it. Read from the constant rather than the
 * constructor because the constructor may be an injected one — Node's `ws`, a
 * test double — and only the numeric value is guaranteed across them.
 */
const OPEN = 1;

/** `https:` → `wss:`, `http:` → `ws:`, for the socket URL under the same origin. */
function toSocketOrigin(baseUrl: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export function createWebSocketTransport(
  options: TransportOptions,
): SealedTransport {
  const http = createHttpClient(options);

  let socketCleanup: (() => void) | null = null;
  let activeSocket: WebSocket | null = null;

  return {
    connect: http.connectRoom,
    sendClip: http.sendClipRequest,
    pollClips: http.pollClipsRequest,
    eraseClips: http.eraseClipsRequest,

    streamClips(roomCode: RoomCode, afterId, peerId, handlers) {
      // Resolved here rather than at construction: a browser transport is built
      // at module scope, which is also evaluated during server rendering.
      const SocketImpl = options.WebSocket ?? globalThis.WebSocket;
      if (typeof SocketImpl === "undefined") {
        return null;
      }

      socketCleanup?.();

      const params = new URLSearchParams({
        after: String(afterId),
        peer: peerId,
      });
      const socketUrl = toSocketOrigin(resolveBaseUrl(options.baseUrl));
      socketUrl.pathname = `/rooms/${roomCode}/socket`;
      socketUrl.search = params.toString();

      const socket = new SocketImpl(socketUrl.toString());
      activeSocket = socket;
      let isClosed = false;

      const fail = () => {
        if (isClosed) {
          return;
        }
        isClosed = true;
        if (activeSocket === socket) {
          activeSocket = null;
        }
        socket.close();
        handlers.onDisconnect("error");
      };

      const handleMessage = (event: MessageEvent<string>) => {
        try {
          // Node's `ws` may hand over a Buffer where a browser gives a string.
          const message = JSON.parse(String(event.data)) as WsServerMessage;
          if (message.type === "ready") {
            handlers.onOpen?.(
              typeof message.eraseGen === "number" ? message.eraseGen : undefined,
            );
            return;
          }
          if (message.type === "removed") {
            const { ids, gen } = message;
            if (
              Array.isArray(ids) &&
              ids.every((id) => typeof id === "number") &&
              typeof gen === "number"
            ) {
              handlers.onRemoved?.(ids, gen);
            }
            return;
          }
          if (message.type === "clip") {
            handlers.onClips([message.clip]);
            return;
          }
          if (message.type === "signal") {
            handlers.onSealedSignal?.(message.from, message.sealed);
            return;
          }
          if (message.type === "peer-left") {
            handlers.onPeerLeft?.(message.from);
            return;
          }
          if (message.type === "error") {
            fail();
          }
        } catch {
          fail();
        }
      };

      socket.addEventListener("message", handleMessage);
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);

      socketCleanup = () => {
        isClosed = true;
        if (activeSocket === socket) {
          activeSocket = null;
        }
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("error", fail);
        socket.removeEventListener("close", fail);
        socket.close();
        socketCleanup = null;
      };

      return () => {
        socketCleanup?.();
        handlers.onDisconnect("closed");
      };
    },

    canSend() {
      return activeSocket?.readyState === OPEN;
    },

    sendSealedSignal(sealed, to) {
      if (!activeSocket || activeSocket.readyState !== OPEN) {
        return false;
      }
      const message: WsClientMessage = { type: "signal", to, sealed };
      activeSocket.send(JSON.stringify(message));
      return true;
    },

    disconnect() {
      socketCleanup?.();
    },
  };
}
