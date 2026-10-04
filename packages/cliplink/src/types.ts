import type { FileSignal, PeerId } from "@thebkht/rtc-file-transfer";

export type RoomCode = string;

/** Who sent a clip, as the sender described itself. Only ever sealed on the wire. */
export type ClipMeta = {
  name: string;
  /**
   * A mark the sending browser can recompute and nobody else can forge, so its
   * own clips read as sent after a reload. Opaque to every other reader, and
   * absent from senders that keep no identity, like the CLI.
   */
  device?: string;
};

export type Clip = {
  id: number;
  text: string;
  senderId: string;
  ts: number;
  /** `from`, sealed. What the server stores and relays; it cannot open it. */
  meta?: string;
  /** Opened from `meta` by the encrypted transport. Never on the wire. */
  from?: ClipMeta;
};

export type Room = {
  code: RoomCode;
  createdAt: number;
  /** The room's configured lifetime. Every write resets the clock to this. */
  ttlSeconds: number;
  /**
   * Fingerprint of the room key, or null for a room created before one was
   * set. One-way, so holding it lets the server tell a joiner their key is
   * wrong without being any closer to holding the key.
   */
  keyCheck: string | null;
  clips: Clip[];
};

export type SessionClipDirection = "incoming" | "outgoing";

export type SessionClip = Clip & {
  direction: SessionClipDirection;
};

export type RoomStatus = "offline" | "live" | "syncing" | "error";

export type ApiError = {
  error: string;
  code: string;
  details?: string;
};

export type CreateRoomRequest = {
  ttlSeconds?: number;
  /** Fingerprint of the key the creator generated. Never the key itself. */
  keyCheck?: string;
  /**
   * Hash of the creator's erase token. A room created without one can never
   * have clips deleted: there is no later moment at which it can be set,
   * because by then anyone with the room code could set it.
   */
  eraseCheck?: string;
};

export type CreateRoomResponse = {
  code: RoomCode;
  ttlSeconds: number;
};

export type GetRoomResponse = {
  room: {
    code: RoomCode;
    createdAt: number;
    /**
     * The room's configured lifetime. Writes reset the expiry to this many
     * seconds out, which lets a client that sees someone else's clip arrive
     * recompute the new deadline without asking the server for it again.
     */
    ttlSeconds: number;
    /** Lets a joiner be told their key is wrong before any clip arrives. */
    keyCheck?: string;
    /**
     * When the room expires, in epoch ms. Optional so that a backend which
     * cannot answer degrades to hiding the countdown rather than failing.
     */
    expiresAt?: number;
    /** Whether the room was created with an erase check, and so can delete. */
    erasable?: boolean;
    /** See `PollClipsResponse.eraseGen`. */
    eraseGen?: number;
  };
  clips: Clip[];
};

export type CreateClipRequest = {
  text: string;
  senderId: string;
  /** `from`, sealed by the encrypted transport. */
  meta?: string;
  /** Plaintext side only: the encrypted transport seals it into `meta`. */
  from?: ClipMeta;
};

export type CreateClipResponse = {
  clip: Clip;
  /** The refreshed expiry, since writing extends the room's TTL. */
  expiresAt?: number;
};

export type PollClipsResponse = {
  clips: Clip[];
  /**
   * How many times clips have been deleted from this room. A poll can only
   * ever return additions, so this is how a client learns something was taken
   * away: a count higher than the one it last saw. Absent from a server that
   * predates deletion, which is not the same as zero.
   */
  eraseGen?: number;
  /**
   * Plaintext side only: clips the encrypted transport found to be gone, having
   * noticed `eraseGen` move and compared against the room.
   */
  removed?: number[];
};

/** Which clips to delete: these, or everything up to and including an id. */
export type EraseClipsRequest = { ids: number[] } | { upTo: number };

export type EraseClipsResponse = {
  /** The clips this request actually removed. Empty if they were already gone. */
  ids: number[];
  /** The room's `eraseGen` afterwards. */
  gen: number;
};

export type StreamDisconnectReason = "error" | "closed";

export type {
  FileOffer,
  PeerId,
  RtcCandidate,
  RtcDescription,
} from "@thebkht/rtc-file-transfer";

/**
 * How a transport reaches the server. The browser passes its own origin; a CLI
 * passes whichever deployment it was pointed at, and supplies `fetch` and
 * `WebSocket` implementations when the globals are not the ones to use.
 */
export type TransportOptions = {
  /**
   * Origin the room API is served from, e.g. `https://cliplink.thebkht.com`.
   *
   * A function is resolved per call rather than once at construction, which is
   * what lets a browser transport be built at module scope: the module is
   * evaluated during server rendering, where `window.location` does not exist
   * yet, and the origin is only ever needed later in the tab.
   */
  baseUrl: string | (() => string);
  fetch?: typeof globalThis.fetch;
  WebSocket?: typeof globalThis.WebSocket;
};

/**
 * Ephemeral signaling messages relayed between peers over the room socket.
 * They are fanned out through Redis pub/sub and never persisted; file bytes
 * themselves travel peer-to-peer over WebRTC data channels.
 */
export type SignalPayload =
  | FileSignal
  /** Reply to `hello`, so a peer with no open offers still announces itself. */
  | { type: "hello-ack" }
  /**
   * A peer's display name. `peer` repeats the sender's id inside the seal,
   * because the `from` beside a signal is the server's word and this is not.
   */
  | { type: "presence"; name: string; peer: PeerId };

/**
 * What the server relays. Sealed envelopes carry an encrypted `SignalPayload`
 * the server cannot read; `peer-left` is the one signal the server originates
 * itself, which is exactly why it cannot be sealed — the server has no key.
 * Keeping it a separate kind is honest about that, rather than letting one
 * message type sometimes be readable and sometimes not.
 */
export type SignalEnvelope =
  | { kind: "sealed"; from: PeerId; to?: PeerId; sealed: string }
  | { kind: "peer-left"; from: PeerId };

export type WsClientMessage = {
  type: "signal";
  to?: PeerId;
  sealed: string;
};

export type WsServerMessage =
  | { type: "ready"; eraseGen?: number }
  | { type: "clip"; clip: Clip }
  | { type: "removed"; ids: number[]; gen: number }
  | { type: "signal"; from: PeerId; sealed: string }
  | { type: "peer-left"; from: PeerId }
  | { type: "error"; reason: string };

/**
 * The wire side of the transport, which deals only in ciphertext: clip `text`
 * is sealed, and signals are opaque strings. `encrypted-transport.ts` adapts
 * one of these into the plaintext `TransportClient` the UI consumes, so the
 * UI's retry and backoff state machine never learns that encryption happened.
 */
export type SealedTransport = {
  connect: (roomCode: RoomCode) => Promise<GetRoomResponse>;
  sendClip: (
    roomCode: RoomCode,
    payload: CreateClipRequest,
  ) => Promise<CreateClipResponse>;
  pollClips: (roomCode: RoomCode, afterId: number) => Promise<PollClipsResponse>;
  /** `token` is the room key's erase token, which is what authorises it. */
  eraseClips: (
    roomCode: RoomCode,
    token: string,
    request: EraseClipsRequest,
  ) => Promise<EraseClipsResponse>;
  streamClips: (
    roomCode: RoomCode,
    afterId: number,
    peerId: PeerId,
    handlers: {
      /** `eraseGen` is the room's count as the socket's backlog was read. */
      onOpen?: (eraseGen?: number) => void;
      onClips: (clips: Clip[]) => void;
      onRemoved?: (ids: number[], gen: number) => void;
      onSealedSignal?: (from: PeerId, sealed: string) => void;
      /** Server-originated, and so the one signal that arrives unsealed. */
      onPeerLeft?: (from: PeerId) => void;
      onDisconnect: (reason: StreamDisconnectReason) => void;
    },
  ) => (() => void) | null;
  /** Synchronous, so a caller can know there is a socket before it seals. */
  canSend: () => boolean;
  sendSealedSignal: (sealed: string, to?: PeerId) => boolean;
  disconnect: () => void;
};

export type TransportClient = {
  connect: (roomCode: RoomCode) => Promise<GetRoomResponse>;
  sendClip: (
    roomCode: RoomCode,
    payload: CreateClipRequest,
  ) => Promise<CreateClipResponse>;
  pollClips: (roomCode: RoomCode, afterId: number) => Promise<PollClipsResponse>;
  /** Deletes clips for the whole room. Resolves with the ids that are gone. */
  eraseClips: (
    roomCode: RoomCode,
    request: EraseClipsRequest,
  ) => Promise<EraseClipsResponse>;
  streamClips: (
    roomCode: RoomCode,
    afterId: number,
    peerId: PeerId,
    handlers: {
      onOpen?: () => void;
      onClips: (clips: Clip[]) => void;
      /** Clips deleted from the room, by any device, this one included. */
      onRemoved?: (ids: number[]) => void;
      onSignal?: (from: PeerId, payload: SignalPayload) => void;
      onDisconnect: (reason: StreamDisconnectReason) => void;
    },
  ) => (() => void) | null;
  /** Returns false when there is no open realtime socket to carry the signal. */
  sendSignal: (payload: SignalPayload, to?: PeerId) => boolean;
  disconnect: () => void;
};
