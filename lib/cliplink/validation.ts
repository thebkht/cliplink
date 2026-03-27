import { MAX_CLIP_CHARS } from "@/lib/cliplink/constants";
import { isValidRoomCode } from "@/lib/cliplink/room-code";

export function validateRoomCode(code: string) {
  return isValidRoomCode(code);
}

export function validateClipText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false as const,
      message: "Clip text cannot be empty.",
    };
  }

  if (trimmed.length > MAX_CLIP_CHARS) {
    return {
      ok: false as const,
      message: `Clip text exceeds the ${MAX_CLIP_CHARS.toLocaleString()} character limit.`,
    };
  }

  return {
    ok: true as const,
    text: trimmed,
  };
}

export function validateSenderId(senderId: string) {
  return typeof senderId === "string" && senderId.trim().length >= 6;
}
