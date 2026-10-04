import {
  errorResponse,
  noStoreJson,
  storageErrorResponse,
} from "@/lib/cliplink/errors";
import { storage } from "@/lib/cliplink/storage";
import type { GetRoomResponse } from "@/lib/cliplink/types";
import { validateRoomCode } from "@/lib/cliplink/validation";

type RoomRouteContext = {
  params: Promise<{ code: string }>;
};

export async function GET(
  _request: Request,
  context: RoomRouteContext,
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  let room;
  let expiresAt: number | null = null;
  try {
    room = await storage.getRoom(code);
    // A read, not a refresh — see StorageAdapter.getRoomExpiresAt.
    expiresAt = room ? await storage.getRoomExpiresAt(code) : null;
  } catch (error) {
    return storageErrorResponse(error);
  }

  if (!room) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  const response: GetRoomResponse = {
    room: {
      code: room.code,
      createdAt: room.createdAt,
      ttlSeconds: room.ttlSeconds,
      ...(room.keyCheck === null ? {} : { keyCheck: room.keyCheck }),
      ...(expiresAt === null ? {} : { expiresAt }),
      // Whether, never what: the check itself is the server's alone.
      erasable: room.eraseCheck !== null,
      eraseGen: room.eraseGen,
    },
    clips: room.clips,
  };

  return noStoreJson(response);
}
