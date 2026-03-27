import type {
  ApiError,
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

    disconnect() {},
  };
}

export async function createRoomRequest() {
  const response = await fetch("/rooms", {
    method: "POST",
  });
  return parseResponse<CreateRoomResponse>(response);
}
