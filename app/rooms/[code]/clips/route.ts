import {
  errorResponse,
  noStoreJson,
  rateLimitResponse,
  storageErrorResponse,
} from "@/lib/cliplink/errors";
import { eraseTokenMatches, readBearerToken } from "@/lib/cliplink/erase";
import { publishClip, publishErase } from "@/lib/cliplink/pubsub";
import {
  clipRateLimit,
  eraseRateLimit,
  getClientIp,
} from "@/lib/cliplink/rate-limit";
import { createClipId, storage } from "@/lib/cliplink/storage";
import type {
  CreateClipRequest,
  CreateClipResponse,
  EraseClipsResponse,
  PollClipsResponse,
} from "@/lib/cliplink/types";
import {
  parseEraseRequest,
  validateClipCiphertext,
  validateClipMeta,
  validateEraseToken,
  validateRoomCode,
  validateSenderId,
} from "@/lib/cliplink/validation";

type RoomRouteContext = {
  params: Promise<{ code: string }>;
};

export async function GET(
  request: Request,
  context: RoomRouteContext,
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
  const afterId = Number.isFinite(after) && after >= 0 ? after : 0;

  let found;
  try {
    found = await storage.getClipsAfter(code, afterId);
  } catch (error) {
    return storageErrorResponse(error);
  }

  if (!found) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  const response: PollClipsResponse = found;
  return noStoreJson(response);
}

/**
 * Deletes clips for everyone in the room. Authorised by the room's erase
 * token, which only a key holder can derive — the room code alone is not
 * enough. Idempotent: deleting what is already gone succeeds and removes
 * nothing.
 */
export async function DELETE(request: Request, context: RoomRouteContext) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  // Before the token is looked at, so guessing one is rate limited too.
  const rateLimit = await eraseRateLimit.check(`${getClientIp(request)}:${code}`);
  if (!rateLimit.ok) {
    return rateLimitResponse(
      "Too many deletions. Please wait a moment and try again.",
      rateLimit.retryAfterSeconds,
    );
  }

  const token = readBearerToken(request);
  if (!validateEraseToken(token)) {
    return errorResponse(401, "invalid_erase_token", "A valid erase token is required.");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  const eraseRequest = parseEraseRequest(payload);
  if (!eraseRequest) {
    return errorResponse(
      400,
      "invalid_erase_request",
      "Name the clips to delete, or the id to delete up to.",
    );
  }

  let erased;
  try {
    const room = await storage.getRoom(code);
    if (!room) {
      return errorResponse(404, "room_not_found", "Room not found.");
    }
    if (room.eraseCheck === null) {
      return errorResponse(
        403,
        "erase_unavailable",
        "Clips in this room cannot be deleted.",
      );
    }
    if (!eraseTokenMatches(token, room.eraseCheck)) {
      return errorResponse(403, "invalid_erase_token", "That token does not open this room.");
    }

    erased = await storage.eraseClips(code, eraseRequest);
  } catch (error) {
    return storageErrorResponse(error);
  }

  if (!erased) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  if (erased.ids.length > 0) {
    await publishErase(code, erased);
  }

  const response: EraseClipsResponse = erased;
  return noStoreJson(response);
}

export async function POST(
  request: Request,
  context: RoomRouteContext,
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  const clientIp = getClientIp(request);
  const rateLimit = await clipRateLimit.check(`${clientIp}:${code}`);
  if (!rateLimit.ok) {
    return rateLimitResponse(
      "Too many clips sent. Please wait a moment and try again.",
      rateLimit.retryAfterSeconds,
    );
  }

  let payload: CreateClipRequest;
  try {
    payload = (await request.json()) as CreateClipRequest;
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  if (!validateSenderId(payload.senderId)) {
    return errorResponse(400, "invalid_sender_id", "Invalid sender id.");
  }

  const validatedText = validateClipCiphertext(payload.text);
  if (!validatedText.ok) {
    return errorResponse(400, "invalid_clip_text", validatedText.message);
  }

  const validatedMeta = validateClipMeta(payload.meta);
  if (!validatedMeta.ok) {
    return errorResponse(400, "invalid_clip_meta", validatedMeta.message);
  }

  const clip = {
    id: createClipId(),
    text: validatedText.text,
    senderId: payload.senderId,
    ts: Date.now(),
    // Sealed like the text. Stored and relayed, never opened here.
    ...(validatedMeta.meta ? { meta: validatedMeta.meta } : {}),
  };

  let room;
  try {
    room = await storage.appendClip(code, clip);
  } catch (error) {
    return storageErrorResponse(error);
  }

  if (!room) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  await publishClip(code, clip);

  // The append just extended the TTL, so the client's copy is already stale.
  // Returning it here beats making every sender follow up with a second call.
  let expiresAt: number | null = null;
  try {
    expiresAt = await storage.getRoomExpiresAt(code);
  } catch {
    // The clip is stored; a missing countdown is not worth failing the send.
  }

  const response: CreateClipResponse = {
    clip,
    ...(expiresAt === null ? {} : { expiresAt }),
  };
  return noStoreJson(response, { status: 201 });
}
