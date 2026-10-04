import type {
  ApiError,
  CreateClipRequest,
  CreateClipResponse,
  CreateRoomResponse,
  EraseClipsRequest,
  EraseClipsResponse,
  GetRoomResponse,
  PollClipsResponse,
  RoomCode,
  TransportOptions,
} from "./types.ts";

/** Resolved per call, so a lazy origin stays lazy. See `TransportOptions`. */
export function resolveBaseUrl(baseUrl: TransportOptions["baseUrl"]) {
  return typeof baseUrl === "function" ? baseUrl() : baseUrl;
}

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: T | ApiError;
  try {
    payload = (await response.json()) as T | ApiError;
  } catch {
    // A route the server does not have answers with no JSON at all — which is
    // what a deployment from before a request existed does with it.
    throw new Error(
      response.ok
        ? "The server sent a response that could not be read."
        : `The server refused the request (${response.status}).`,
    );
  }

  if (!response.ok) {
    const error = payload as ApiError;
    throw new Error(error.details ?? error.error);
  }

  return payload as T;
}

export type HttpClient = {
  connectRoom: (roomCode: RoomCode) => Promise<GetRoomResponse>;
  sendClipRequest: (
    roomCode: RoomCode,
    payload: CreateClipRequest,
  ) => Promise<CreateClipResponse>;
  pollClipsRequest: (
    roomCode: RoomCode,
    afterId: number,
  ) => Promise<PollClipsResponse>;
  eraseClipsRequest: (
    roomCode: RoomCode,
    token: string,
    request: EraseClipsRequest,
  ) => Promise<EraseClipsResponse>;
  createRoomRequest: (
    keyCheck?: string,
    ttlSeconds?: number,
    eraseCheck?: string,
  ) => Promise<CreateRoomResponse>;
};

/**
 * The room REST API, bound to one origin.
 *
 * A browser could address these paths relatively, but a CLI cannot, so the
 * origin is a parameter rather than an assumption. `fetch` is injectable for
 * the same reason a transport is: so a caller can supply one with its own
 * timeouts or agent without this module knowing about either.
 */
export function createHttpClient({
  baseUrl,
  fetch: fetchImpl = globalThis.fetch,
}: TransportOptions): HttpClient {
  const url = (path: string) => new URL(path, resolveBaseUrl(baseUrl)).toString();

  return {
    async connectRoom(roomCode) {
      const response = await fetchImpl(url(`/rooms/${roomCode}`), {
        cache: "no-store",
      });
      return parseResponse<GetRoomResponse>(response);
    },

    async sendClipRequest(roomCode, payload) {
      const response = await fetchImpl(url(`/rooms/${roomCode}/clips`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      return parseResponse<CreateClipResponse>(response);
    },

    async pollClipsRequest(roomCode, afterId) {
      const response = await fetchImpl(
        url(`/rooms/${roomCode}/clips?after=${afterId}`),
        { cache: "no-store" },
      );
      return parseResponse<PollClipsResponse>(response);
    },

    async eraseClipsRequest(roomCode, token, request) {
      const response = await fetchImpl(url(`/rooms/${roomCode}/clips`), {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        // A delete started as a tab closes should still land.
        keepalive: true,
      });
      return parseResponse<EraseClipsResponse>(response);
    },

    /**
     * `keyCheck` is the fingerprint of a generated key, never the key — so a
     * joiner can be told their key is wrong without the server being any closer
     * to holding it. Omitted for an open room, whose key comes from the code and
     * which therefore has nothing to check against. `eraseCheck` is omitted
     * there too: the server derives an open room's for itself.
     */
    async createRoomRequest(keyCheck, ttlSeconds, eraseCheck) {
      const body: Record<string, unknown> = {};
      if (keyCheck) {
        body.keyCheck = keyCheck;
      }
      if (ttlSeconds !== undefined) {
        body.ttlSeconds = ttlSeconds;
      }
      if (eraseCheck) {
        body.eraseCheck = eraseCheck;
      }

      const response = await fetchImpl(url("/rooms"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return parseResponse<CreateRoomResponse>(response);
    },
  };
}
