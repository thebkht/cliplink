import type {
  ApiError,
  Clip,
  CreateClipRequest,
  CreateClipResponse,
  CreateRoomResponse,
  GetRoomResponse,
  PollClipsResponse,
  RoomCode,
  TransportClient,
} from "@/lib/cliplink/types";

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T | ApiError;

  if (!response.ok) {
    const error = payload as ApiError;
    throw new Error(error.details ?? error.error);
  }

  return payload as T;
}

export function createPollingTransport(): TransportClient {
  let streamCleanup: (() => void) | null = null;

  return {
    async connect(roomCode: RoomCode) {
      const response = await fetch(`/rooms/${roomCode}`, {
        cache: "no-store",
      });
      return parseResponse<GetRoomResponse>(response);
    },

    async sendClip(roomCode, payload: CreateClipRequest) {
      const response = await fetch(`/rooms/${roomCode}/clips`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      return parseResponse<CreateClipResponse>(response);
    },

    async pollClips(roomCode, afterId) {
      const response = await fetch(`/rooms/${roomCode}/clips?after=${afterId}`, {
        cache: "no-store",
      });
      return parseResponse<PollClipsResponse>(response);
    },

    streamClips(roomCode, afterId, handlers) {
      if (typeof window === "undefined" || typeof EventSource === "undefined") {
        return null;
      }

      streamCleanup?.();

      const source = new EventSource(
        `/rooms/${roomCode}/stream?after=${encodeURIComponent(String(afterId))}`,
      );

      const handleClip = (event: MessageEvent<string>) => {
        try {
          const clip = JSON.parse(event.data) as Clip;
          handlers.onClips([clip]);
        } catch {
          handlers.onDisconnect("error");
        }
      };

      const handleDisconnect = () => {
        source.close();
        handlers.onDisconnect("error");
      };

      source.addEventListener("clip", handleClip as EventListener);
      source.onerror = handleDisconnect;

      streamCleanup = () => {
        source.removeEventListener("clip", handleClip as EventListener);
        source.close();
        streamCleanup = null;
      };

      return () => {
        streamCleanup?.();
        handlers.onDisconnect("closed");
      };
    },

    disconnect() {
      streamCleanup?.();
    },
  };
}

export async function createRoomRequest() {
  const response = await fetch("/rooms", {
    method: "POST",
  });
  return parseResponse<CreateRoomResponse>(response);
}
