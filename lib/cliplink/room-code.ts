import { ROOM_CODE_LENGTH } from "@/lib/cliplink/constants";

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeRoomCode(value: string | null | undefined) {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function isValidRoomCode(value: string) {
  return ROOM_CODE_PATTERN.test(value);
}

export function generateRoomCode() {
  return Array.from({ length: ROOM_CODE_LENGTH }, () => {
    const index = Math.floor(Math.random() * CODE_ALPHABET.length);
    return CODE_ALPHABET[index];
  }).join("");
}

export function buildRoomUrl(code: string, origin: string) {
  const url = new URL(origin);
  url.searchParams.set("room", code);
  return url.toString();
}
