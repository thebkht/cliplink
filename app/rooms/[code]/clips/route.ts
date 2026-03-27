import { errorResponse, noStoreJson } from "@/lib/cliplink/errors";
import { checkRateLimit, getClientIp } from "@/lib/cliplink/rate-limit";
import { createClipId, storage } from "@/lib/cliplink/storage";
import type {
  CreateClipRequest,
  CreateClipResponse,
  PollClipsResponse,
} from "@/lib/cliplink/types";
import {
  validateClipText,
  validateRoomCode,
  validateSenderId,
} from "@/lib/cliplink/validation";

export async function GET(
  request: Request,
  context: RouteContext<"/rooms/[code]/clips">,
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
  const afterId = Number.isFinite(after) && after >= 0 ? after : 0;
  const clips = await storage.getClipsAfter(code, afterId);

  if (!clips) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  const response: PollClipsResponse = { clips };
  return noStoreJson(response);
}

export async function POST(
  request: Request,
  context: RouteContext<"/rooms/[code]/clips">,
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit(`${clientIp}:${code}`);
  if (!rateLimit.ok) {
    return errorResponse(
      429,
      "rate_limited",
      "Too many clips sent. Please wait a moment and try again.",
      `Retry after ${rateLimit.retryAfterSeconds} seconds.`,
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

  const validatedText = validateClipText(payload.text);
  if (!validatedText.ok) {
    return errorResponse(400, "invalid_clip_text", validatedText.message);
  }

  const clip = {
    id: createClipId(),
    text: validatedText.text,
    senderId: payload.senderId,
    ts: Date.now(),
  };

  const room = await storage.appendClip(code, clip);
  if (!room) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  const response: CreateClipResponse = { clip };
  return noStoreJson(response, { status: 201 });
}
