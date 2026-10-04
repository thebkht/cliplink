import { createHash, timingSafeEqual } from "node:crypto";

import { deriveOpenRoomKey } from "@thebkht/cliplink";

/**
 * The server's half of deleting clips.
 *
 * A room is created with the hash of a token only its key holders can derive.
 * Deleting means presenting the token, which is hashed and compared here — so
 * holding the room code is not enough, and the server stores nothing that
 * would let it, or anyone who took its data, mint a token of their own.
 */

/** What the creator's `eraseCheck` is: SHA-256 of the token, base64url. */
function hashEraseToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export function eraseTokenMatches(token: string, eraseCheck: string) {
  const presented = Buffer.from(hashEraseToken(token));
  const expected = Buffer.from(eraseCheck);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/**
 * The erase check for an open room, which the server works out for itself.
 *
 * An open room's key is derived from its code, and the creator does not know
 * the code until the room exists — so it cannot send a check with the request
 * that creates it. The server can derive that key by design (that is what
 * makes the room open, and why it is not end-to-end), so it derives the check
 * too. Deleting from an open room is therefore open to anyone with the code,
 * exactly as reading it is.
 */
export async function openRoomEraseCheck(code: string) {
  return (await deriveOpenRoomKey(code)).eraseCheck;
}

/** `Authorization: Bearer <token>`, or null. */
export function readBearerToken(request: Request) {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer (\S+)$/.exec(header) : null;
  return match ? match[1] : null;
}
