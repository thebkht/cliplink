/**
 * The limits and shapes that define the wire, as opposed to the ones that
 * merely tune a deployment.
 *
 * Everything here is agreed between two clients that may be running different
 * builds — a browser tab opened last week and a CLI installed today — so a
 * change to any of it is a protocol change. Storage caps, rate limits, and UI
 * ceilings are not: they live in the app, where they can move freely.
 */

export const ROOM_CODE_LENGTH = 6;
export const ROOM_TTL_SECONDS = 60 * 60 * 6;
export const MIN_ROOM_TTL_SECONDS = 60 * 60;
export const MAX_ROOM_TTL_SECONDS = 60 * 60 * 24;
export const POLL_INTERVAL_MS = 1500;
export const MAX_CLIP_CHARS = 20_000;
/**
 * The server sees only ciphertext, so it caps that instead. Sized from the
 * worst case the client can legitimately produce: MAX_CLIP_CHARS of 4-byte
 * UTF-8, plus nonce and tag, base64'd. The plaintext limit is still the real
 * one and is enforced in the editor, where the text is legible.
 */
export const MAX_CLIP_CIPHERTEXT_CHARS = 110_000;
/** Characters in a serialized room key — 32 bytes at 5 bits per character. */
export const ROOM_KEY_CHARS = 52;
/** Characters in the key's fingerprint — 8 bytes at 5 bits per character. */
export const ROOM_KEY_CHECK_CHARS = 13;
/**
 * A device's display name. Short enough to sit beside a history row, and a
 * bound a peer's name has to meet before it is shown.
 */
export const MAX_DEVICE_NAME_CHARS = 40;
/**
 * Sealed clip metadata — a name and a device id. Sized from the worst case
 * (MAX_DEVICE_NAME_CHARS of 4-byte UTF-8, a 64-character id, JSON, nonce and
 * tag, base64'd) with room to grow.
 */
export const MAX_CLIP_META_CHARS = 1024;
/** Characters in an erase token — 32 bytes at 5 bits per character. */
export const ERASE_TOKEN_CHARS = 52;
/** Characters in an erase check — a SHA-256 digest, base64url without padding. */
export const ERASE_CHECK_CHARS = 43;
/**
 * Clips one delete request may name. Above any room's stored cap, so "delete
 * these" can always say all of them, and still a bound on the request.
 */
export const MAX_ERASE_IDS = 100;
// Sealing inflates a signal by base64's 4/3 plus a nonce and a tag, and an SDP
// offer already approached the old 16 KB ceiling. Left there, the socket's
// maxPayload would have dropped large offers with no error to see.
export const MAX_SIGNAL_BYTES = 24 * 1024;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_FILE_NAME_CHARS = 255;

/** A sealed payload: the version prefix plus base64url. */
export const CIPHERTEXT_PATTERN = /^v1\.[A-Za-z0-9_-]+$/;
