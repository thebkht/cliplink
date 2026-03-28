export type RoomCode = string;

export type Clip = {
  id: number;
  text: string;
  senderId: string;
  ts: number;
};

export type Room = {
  code: RoomCode;
  createdAt: number;
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

export type CreateRoomResponse = {
  code: RoomCode;
};

export type GetRoomResponse = {
  room: {
    code: RoomCode;
    createdAt: number;
  };
  clips: Clip[];
};

export type CreateClipRequest = {
  text: string;
  senderId: string;
};

export type CreateClipResponse = {
  clip: Clip;
};

export type PollClipsResponse = {
  clips: Clip[];
};

export type StreamDisconnectReason = "error" | "closed";

export type TransportClient = {
  connect: (roomCode: RoomCode) => Promise<GetRoomResponse>;
  sendClip: (
    roomCode: RoomCode,
    payload: CreateClipRequest,
  ) => Promise<CreateClipResponse>;
  pollClips: (roomCode: RoomCode, afterId: number) => Promise<PollClipsResponse>;
  streamClips: (
    roomCode: RoomCode,
    afterId: number,
    handlers: {
      onOpen?: () => void;
      onClips: (clips: Clip[]) => void;
      onDisconnect: (reason: StreamDisconnectReason) => void;
    },
  ) => (() => void) | null;
  disconnect: () => void;
};
