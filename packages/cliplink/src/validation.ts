import { parseFileSignal } from "@thebkht/rtc-file-transfer";

import {
  CIPHERTEXT_PATTERN,
  ERASE_CHECK_CHARS,
  ERASE_TOKEN_CHARS,
  MAX_CLIP_CHARS,
  MAX_CLIP_META_CHARS,
  MAX_CLIP_CIPHERTEXT_CHARS,
  MAX_DEVICE_NAME_CHARS,
  MAX_ERASE_IDS,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_ROOM_TTL_SECONDS,
  MAX_SIGNAL_BYTES,
  MIN_ROOM_TTL_SECONDS,
  ROOM_KEY_CHECK_CHARS,
  ROOM_TTL_SECONDS,
} from "./protocol.ts";
import { isValidRoomCode } from "./room-code.ts";
import type {
  ClipMeta,
  EraseClipsRequest,
  SignalPayload,
  WsClientMessage,
} from "./types.ts";

const MAX_ID_CHARS = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateRoomCode(code: string) {
  return isValidRoomCode(code);
}

/**
 * All the server can check. It holds ciphertext it cannot open, so "is this
 * well-formed and within bounds" is the whole of its say — the non-empty and
 * length rules that matter are enforced on the plaintext, in the editor.
 */
export function validateClipCiphertext(text: unknown) {
  if (typeof text !== "string" || !CIPHERTEXT_PATTERN.test(text)) {
    return {
      ok: false as const,
      message: "Clip must be encrypted before it is sent.",
    };
  }

  if (text.length > MAX_CLIP_CIPHERTEXT_CHARS) {
    return {
      ok: false as const,
      message: "Encrypted clip is too large.",
    };
  }

  return { ok: true as const, text };
}

/**
 * Sealed like the text, so the same is true of it: shape and size are all the
 * server can vouch for. Absent is fine — older clients send none.
 */
export function validateClipMeta(input: unknown) {
  if (input === undefined || input === null) {
    return { ok: true as const, meta: undefined };
  }

  if (
    typeof input !== "string" ||
    input.length > MAX_CLIP_META_CHARS ||
    !CIPHERTEXT_PATTERN.test(input)
  ) {
    return { ok: false as const, message: "Invalid clip metadata." };
  }

  return { ok: true as const, meta: input };
}

/**
 * A name as it may be shown: one line, no control characters, bounded. Null
 * when nothing is left, so a caller falls back rather than showing a blank.
 */
export function normalizeDeviceName(input: unknown) {
  if (typeof input !== "string") {
    return null;
  }

  const name = [...input.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()]
    .slice(0, MAX_DEVICE_NAME_CHARS)
    .join("")
    .trim();
  return name || null;
}

/** Rebuilds opened metadata from the fields we recognise, or rejects it. */
export function parseClipMeta(input: unknown): ClipMeta | null {
  if (!isRecord(input)) {
    return null;
  }

  const name = normalizeDeviceName(input.name);
  if (!name) {
    return null;
  }

  return validatePeerId(input.device) ? { name, device: input.device } : { name };
}

/** Plaintext rules, for the client that can still see the plaintext. */
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

const BASE32_PATTERN = /^[0-9A-Z]+$/;

/**
 * The fingerprint the creator derived from their key. The server stores and
 * echoes it; it cannot check that it corresponds to anything, only that it is
 * the right shape to be a fingerprint at all.
 */
export function validateKeyCheck(input: unknown) {
  if (input === undefined || input === null) {
    return { ok: true as const, keyCheck: undefined };
  }

  if (
    typeof input !== "string" ||
    input.length !== ROOM_KEY_CHECK_CHARS ||
    !BASE32_PATTERN.test(input)
  ) {
    return { ok: false as const, message: "Invalid key fingerprint." };
  }

  return { ok: true as const, keyCheck: input };
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The hash of the creator's erase token. As with the key fingerprint, the
 * server can check the shape and nothing more.
 */
export function validateEraseCheck(input: unknown) {
  if (input === undefined || input === null) {
    return { ok: true as const, eraseCheck: undefined };
  }

  if (
    typeof input !== "string" ||
    input.length !== ERASE_CHECK_CHARS ||
    !BASE64URL_PATTERN.test(input)
  ) {
    return { ok: false as const, message: "Invalid erase check." };
  }

  return { ok: true as const, eraseCheck: input };
}

export function validateEraseToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === ERASE_TOKEN_CHARS &&
    BASE32_PATTERN.test(value)
  );
}

function isClipId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Rebuilt from the one selector it carries; anything else is rejected. */
export function parseEraseRequest(input: unknown): EraseClipsRequest | null {
  if (!isRecord(input)) {
    return null;
  }

  if (Array.isArray(input.ids)) {
    const { ids } = input;
    return input.upTo === undefined &&
      ids.length > 0 &&
      ids.length <= MAX_ERASE_IDS &&
      ids.every(isClipId)
      ? { ids: [...new Set(ids)] }
      : null;
  }

  return input.ids === undefined && isClipId(input.upTo)
    ? { upTo: input.upTo }
    : null;
}

export function validateSenderId(senderId: string) {
  return typeof senderId === "string" && senderId.trim().length >= 6;
}

export function validateRoomTtl(input: unknown) {
  if (input === undefined || input === null) {
    return { ok: true as const, ttlSeconds: ROOM_TTL_SECONDS };
  }

  if (typeof input !== "number" || !Number.isFinite(input)) {
    return {
      ok: false as const,
      message: "ttlSeconds must be a number.",
    };
  }

  const ttlSeconds = Math.floor(input);
  if (ttlSeconds < MIN_ROOM_TTL_SECONDS || ttlSeconds > MAX_ROOM_TTL_SECONDS) {
    return {
      ok: false as const,
      message: `ttlSeconds must be between ${MIN_ROOM_TTL_SECONDS} and ${MAX_ROOM_TTL_SECONDS}.`,
    };
  }

  return {
    ok: true as const,
    ttlSeconds,
  };
}

export function validatePeerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= MAX_ID_CHARS &&
    ID_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * Runs in the browser now, on a payload that has just been decrypted. The
 * server relays signals it cannot read, so this — rebuilding a payload from
 * only the fields we recognise — is the client's job and no longer the
 * server's.
 */
export function parseSignalPayload(input: unknown): SignalPayload | null {
  if (isRecord(input) && input.type === "hello-ack") {
    return { type: "hello-ack" };
  }
  if (isRecord(input) && input.type === "presence") {
    const name = normalizeDeviceName(input.name);
    return name && validatePeerId(input.peer)
      ? { type: "presence", name, peer: input.peer }
      : null;
  }
  return parseFileSignal(input, {
    maxFileBytes: MAX_FILE_BYTES,
    maxNameChars: MAX_FILE_NAME_CHARS,
    maxSdpChars: MAX_SIGNAL_BYTES,
  });
}

/**
 * Parses a raw message a client sent over the room socket.
 *
 * The payload is sealed, so the server's say is limited to shape: a bounded,
 * well-formed ciphertext addressed to a valid peer. Inspecting the signal
 * itself is no longer possible here and no longer belongs here — the client
 * does it in `parseSignalPayload`, after decryption.
 */
export function parseClientMessage(raw: string): WsClientMessage | null {
  if (raw.length > MAX_SIGNAL_BYTES) {
    return null;
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(input) || input.type !== "signal") {
    return null;
  }

  if (input.to !== undefined && !validatePeerId(input.to)) {
    return null;
  }

  if (
    !isBoundedString(input.sealed, MAX_SIGNAL_BYTES) ||
    !CIPHERTEXT_PATTERN.test(input.sealed)
  ) {
    return null;
  }

  return { type: "signal", to: input.to, sealed: input.sealed };
}
