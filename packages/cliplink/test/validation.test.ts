import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRandomPeerId, createRandomSenderId } from "../src/cli/identity.ts";
import {
  MAX_CLIP_CHARS,
  MAX_CLIP_CIPHERTEXT_CHARS,
  MAX_CLIP_META_CHARS,
  MAX_DEVICE_NAME_CHARS,
  MAX_ERASE_IDS,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_ROOM_TTL_SECONDS,
  MAX_SIGNAL_BYTES,
  MIN_ROOM_TTL_SECONDS,
  ROOM_KEY_CHECK_CHARS,
  ROOM_TTL_SECONDS,
} from "../src/protocol.ts";
import {
  normalizeDeviceName,
  parseClientMessage,
  parseClipMeta,
  parseEraseRequest,
  validateEraseCheck,
  validateEraseToken,
  parseSignalPayload,
  validateClipCiphertext,
  validateClipMeta,
  validateClipText,
  validateKeyCheck,
  validatePeerId,
  validateRoomCode,
  validateRoomTtl,
  validateSenderId,
} from "../src/validation.ts";

/** Not strings, and not undefined or null either: what a hostile or buggy client sends. */
const NOT_STRINGS = [42, true, {}, [], ["v1.abc"]];

describe("validateRoomCode", () => {
  it("accepts six uppercase letters and digits", () => {
    assert.equal(validateRoomCode("X7KP2M"), true);
    assert.equal(validateRoomCode("ABCDEF"), true);
    assert.equal(validateRoomCode("234567"), true);
  });

  it("rejects the wrong length", () => {
    assert.equal(validateRoomCode(""), false);
    assert.equal(validateRoomCode("X7KP2"), false);
    assert.equal(validateRoomCode("X7KP2MA"), false);
  });

  it("rejects lowercase, punctuation and whitespace", () => {
    assert.equal(validateRoomCode("x7kp2m"), false);
    assert.equal(validateRoomCode("X7KP-M"), false);
    assert.equal(validateRoomCode("X7KP2 "), false);
    assert.equal(validateRoomCode("X7KP2\n"), false);
  });

  it("is anchored, so a valid code inside a longer string does not pass", () => {
    assert.equal(validateRoomCode("../X7KP2M"), false);
    assert.equal(validateRoomCode("X7KP2M/../"), false);
  });
});

describe("validateClipCiphertext", () => {
  it("accepts a sealed clip and hands the text back", () => {
    assert.deepEqual(validateClipCiphertext("v1.abc_-XYZ019"), {
      ok: true,
      text: "v1.abc_-XYZ019",
    });
  });

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, ...NOT_STRINGS]) {
      assert.deepEqual(validateClipCiphertext(value), {
        ok: false,
        message: "Clip must be encrypted before it is sent.",
      });
    }
  });

  it("rejects plaintext, so a client that forgot to encrypt cannot store it", () => {
    for (const value of ["hello", "", "v1.", "v2.abc", "V1.abc", " v1.abc"]) {
      assert.equal(validateClipCiphertext(value).ok, false, JSON.stringify(value));
    }
  });

  it("rejects characters outside base64url, padding included", () => {
    for (const value of ["v1.ab=", "v1.ab+c", "v1.ab/c", "v1.ab c", "v1.ab\n", "v1.é"]) {
      assert.equal(validateClipCiphertext(value).ok, false, JSON.stringify(value));
    }
  });

  it("accepts a ciphertext exactly at the size cap and rejects one over it", () => {
    const atCap = `v1.${"a".repeat(MAX_CLIP_CIPHERTEXT_CHARS - 3)}`;
    assert.equal(atCap.length, MAX_CLIP_CIPHERTEXT_CHARS);
    assert.equal(validateClipCiphertext(atCap).ok, true);

    assert.deepEqual(validateClipCiphertext(`${atCap}a`), {
      ok: false,
      message: "Encrypted clip is too large.",
    });
  });
});

describe("validateClipText", () => {
  it("returns the text trimmed", () => {
    assert.deepEqual(validateClipText("  hello \n"), { ok: true, text: "hello" });
  });

  it("keeps inner whitespace and line breaks", () => {
    assert.deepEqual(validateClipText("a\n\n  b"), { ok: true, text: "a\n\n  b" });
  });

  it("rejects empty and whitespace-only text", () => {
    for (const value of ["", "   ", "\n\t "]) {
      assert.deepEqual(validateClipText(value), {
        ok: false,
        message: "Clip text cannot be empty.",
      });
    }
  });

  it("applies the character limit to the trimmed text", () => {
    const atLimit = "a".repeat(MAX_CLIP_CHARS);
    assert.equal(validateClipText(atLimit).ok, true);
    // Padding does not count against the limit: it is trimmed before sending.
    assert.equal(validateClipText(`  ${atLimit}\n`).ok, true);

    const over = validateClipText(`${atLimit}a`);
    assert.equal(over.ok, false);
    // The number is locale-formatted, so match the sentence rather than the digits.
    assert.match((over as { message: string }).message, /^Clip text exceeds the .+ character limit\.$/);
  });
});

describe("validateKeyCheck", () => {
  const VALID = "HQTVJ4C81PPB4";

  it("treats a missing fingerprint as fine: an open room has none", () => {
    assert.deepEqual(validateKeyCheck(undefined), { ok: true, keyCheck: undefined });
    assert.deepEqual(validateKeyCheck(null), { ok: true, keyCheck: undefined });
  });

  it("accepts a fingerprint of the right length and alphabet", () => {
    assert.equal(VALID.length, ROOM_KEY_CHECK_CHARS);
    assert.deepEqual(validateKeyCheck(VALID), { ok: true, keyCheck: VALID });
  });

  it("rejects the wrong length", () => {
    for (const value of ["", VALID.slice(1), `${VALID}A`]) {
      assert.deepEqual(validateKeyCheck(value), {
        ok: false,
        message: "Invalid key fingerprint.",
      });
    }
  });

  it("rejects lowercase and punctuation", () => {
    assert.equal(validateKeyCheck(VALID.toLowerCase()).ok, false);
    assert.equal(validateKeyCheck("HQTVJ4C81PP-4").ok, false);
    assert.equal(validateKeyCheck("HQTVJ4C81PP4 ").ok, false);
  });

  it("rejects anything that is not a string", () => {
    for (const value of NOT_STRINGS) {
      assert.equal(validateKeyCheck(value).ok, false, JSON.stringify(value));
    }
  });
});

describe("validateSenderId", () => {
  it("wants at least six characters once trimmed", () => {
    assert.equal(validateSenderId("abcdef"), true);
    assert.equal(validateSenderId("abcde"), false);
    assert.equal(validateSenderId("  abcde  "), false);
    assert.equal(validateSenderId("      "), false);
    assert.equal(validateSenderId(""), false);
  });

  it("does not throw on a value that is not a string", () => {
    for (const value of [undefined, null, ...NOT_STRINGS]) {
      assert.equal(validateSenderId(value as never), false);
    }
  });
});

describe("validateRoomTtl", () => {
  it("falls back to the default when none is given", () => {
    assert.deepEqual(validateRoomTtl(undefined), { ok: true, ttlSeconds: ROOM_TTL_SECONDS });
    assert.deepEqual(validateRoomTtl(null), { ok: true, ttlSeconds: ROOM_TTL_SECONDS });
  });

  it("accepts both ends of the range", () => {
    assert.deepEqual(validateRoomTtl(MIN_ROOM_TTL_SECONDS), {
      ok: true,
      ttlSeconds: MIN_ROOM_TTL_SECONDS,
    });
    assert.deepEqual(validateRoomTtl(MAX_ROOM_TTL_SECONDS), {
      ok: true,
      ttlSeconds: MAX_ROOM_TTL_SECONDS,
    });
  });

  it("rejects one second either side of the range, naming the bounds", () => {
    const expected = `ttlSeconds must be between ${MIN_ROOM_TTL_SECONDS} and ${MAX_ROOM_TTL_SECONDS}.`;
    assert.deepEqual(validateRoomTtl(MIN_ROOM_TTL_SECONDS - 1), { ok: false, message: expected });
    assert.deepEqual(validateRoomTtl(MAX_ROOM_TTL_SECONDS + 1), { ok: false, message: expected });
    assert.equal(validateRoomTtl(0).ok, false);
    assert.equal(validateRoomTtl(-3600).ok, false);
  });

  it("floors a fractional value before checking the range", () => {
    assert.deepEqual(validateRoomTtl(MIN_ROOM_TTL_SECONDS + 0.9), {
      ok: true,
      ttlSeconds: MIN_ROOM_TTL_SECONDS,
    });
    // 3599.9 floors to 3599, which is out of range even though it rounds into it.
    assert.equal(validateRoomTtl(MIN_ROOM_TTL_SECONDS - 0.1).ok, false);
  });

  it("rejects what is not a finite number", () => {
    for (const value of ["3600", NaN, Infinity, -Infinity, {}, [], true]) {
      assert.deepEqual(validateRoomTtl(value), {
        ok: false,
        message: "ttlSeconds must be a number.",
      });
    }
  });
});

describe("validatePeerId", () => {
  it("wants eight to sixty-four characters of letters, digits, underscore and dash", () => {
    assert.equal(validatePeerId("abcd1234"), true);
    assert.equal(validatePeerId("peer_id-01"), true);
    assert.equal(validatePeerId("a".repeat(64)), true);
  });

  it("rejects either side of the length bounds", () => {
    assert.equal(validatePeerId("a".repeat(7)), false);
    assert.equal(validatePeerId("a".repeat(65)), false);
    assert.equal(validatePeerId(""), false);
  });

  it("rejects characters that could be read as anything but an id", () => {
    for (const value of ["peer id 01", "peer.id.01", "peer/id/01", "peer\nid01", "péer1234"]) {
      assert.equal(validatePeerId(value), false, JSON.stringify(value));
    }
  });

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, ...NOT_STRINGS]) {
      assert.equal(validatePeerId(value), false);
    }
  });
});

describe("ids the CLI mints", () => {
  // The CLI and the server are versioned separately, so the shape one
  // generates and the other accepts is a contract, not a coincidence.
  it("are accepted as peer and sender ids", () => {
    for (let index = 0; index < 20; index += 1) {
      assert.equal(validatePeerId(createRandomPeerId()), true);
      assert.equal(validateSenderId(createRandomSenderId()), true);
    }
  });
});

describe("parseSignalPayload", () => {
  const OFFER = {
    type: "file-offer",
    offerId: "offer-1234",
    name: "notes.txt",
    size: 1_024,
    mime: "text/plain",
  };

  it("accepts hello-ack and rebuilds it from the one field it knows", () => {
    assert.deepEqual(parseSignalPayload({ type: "hello-ack", smuggled: "x" }), {
      type: "hello-ack",
    });
  });

  it("accepts a presence signal and rebuilds it from the fields it knows", () => {
    assert.deepEqual(
      parseSignalPayload({
        type: "presence",
        name: "  Work\nlaptop ",
        peer: "peer-abcdef",
        smuggled: "x",
      }),
      { type: "presence", name: "Work laptop", peer: "peer-abcdef" },
    );
  });

  it("rejects a presence signal with no usable name or no valid peer", () => {
    for (const value of [
      { type: "presence", peer: "peer-abcdef" },
      { type: "presence", name: "   ", peer: "peer-abcdef" },
      { type: "presence", name: 42, peer: "peer-abcdef" },
      { type: "presence", name: "Laptop" },
      { type: "presence", name: "Laptop", peer: "short" },
    ]) {
      assert.equal(parseSignalPayload(value), null, JSON.stringify(value));
    }
  });

  it("hands file signals to the file-transfer parser", () => {
    assert.deepEqual(parseSignalPayload({ type: "hello" }), { type: "hello" });
    assert.deepEqual(parseSignalPayload(OFFER), OFFER);
  });

  it("drops fields the protocol does not define", () => {
    assert.deepEqual(parseSignalPayload({ ...OFFER, evil: "<script>" }), OFFER);
  });

  it("rejects anything that is not an object with a known type", () => {
    for (const value of [null, undefined, "hello", 42, [], [{ type: "hello" }], {}, { type: "nope" }]) {
      assert.equal(parseSignalPayload(value), null, JSON.stringify(value));
    }
  });

  it("refuses a peer's claim that another peer left", () => {
    // peer-left is the server's to originate. If a peer could forge one, it
    // could make everyone else drop a transfer with someone still connected.
    assert.equal(parseSignalPayload({ type: "peer-left", from: "peer-abcdef" }), null);
    assert.equal(parseSignalPayload({ type: "peer-left" }), null);
  });

  it("enforces the file-size and name limits this package passes down", () => {
    assert.deepEqual(parseSignalPayload({ ...OFFER, size: MAX_FILE_BYTES }), {
      ...OFFER,
      size: MAX_FILE_BYTES,
    });
    assert.equal(parseSignalPayload({ ...OFFER, size: MAX_FILE_BYTES + 1 }), null);
    assert.equal(parseSignalPayload({ ...OFFER, size: 0 }), null);

    assert.notEqual(parseSignalPayload({ ...OFFER, name: "n".repeat(MAX_FILE_NAME_CHARS) }), null);
    assert.equal(parseSignalPayload({ ...OFFER, name: "n".repeat(MAX_FILE_NAME_CHARS + 1) }), null);
  });

  it("bounds an SDP by the signal size cap", () => {
    const description = (sdp: string) => ({
      type: "rtc-description",
      transferId: "transfer-1234",
      description: { type: "offer", sdp },
    });

    assert.notEqual(parseSignalPayload(description("s".repeat(MAX_SIGNAL_BYTES))), null);
    assert.equal(parseSignalPayload(description("s".repeat(MAX_SIGNAL_BYTES + 1))), null);
    assert.equal(parseSignalPayload(description("")), null);
  });
});

describe("parseClientMessage", () => {
  const SEALED = "v1.abc_-XYZ019";

  it("accepts a sealed signal addressed to a peer", () => {
    assert.deepEqual(
      parseClientMessage(JSON.stringify({ type: "signal", to: "peer-abcdef", sealed: SEALED })),
      { type: "signal", to: "peer-abcdef", sealed: SEALED },
    );
  });

  it("accepts a broadcast, which names no peer", () => {
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: "signal", sealed: SEALED })), {
      type: "signal",
      to: undefined,
      sealed: SEALED,
    });
  });

  it("passes on only the fields it knows", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: "signal", sealed: SEALED, from: "peer-spoofed", admin: true }),
    );
    assert.deepEqual(parsed, { type: "signal", to: undefined, sealed: SEALED });
    assert.equal(Object.hasOwn(parsed ?? {}, "from"), false);
  });

  it("rejects what is not JSON, or not a JSON object", () => {
    for (const raw of ["", "{", "not json", "null", "42", '"signal"', "[]", '[{"type":"signal"}]']) {
      assert.equal(parseClientMessage(raw), null, raw);
    }
  });

  it("rejects any type but signal", () => {
    for (const type of ["hello", "clip", "SIGNAL", "", null, 1]) {
      assert.equal(parseClientMessage(JSON.stringify({ type, sealed: SEALED })), null);
    }
    assert.equal(parseClientMessage(JSON.stringify({ sealed: SEALED })), null);
  });

  it("rejects an address that is not a valid peer id, null included", () => {
    for (const to of ["short", "peer id 01", "peer/../01", "a".repeat(65), "", null, 12345678, {}]) {
      assert.equal(
        parseClientMessage(JSON.stringify({ type: "signal", to, sealed: SEALED })),
        null,
        JSON.stringify(to),
      );
    }
  });

  it("rejects a payload that is missing, empty, or not ciphertext", () => {
    for (const sealed of [undefined, null, "", "hello", "v2.abc", "v1.", "v1.a=b", 42, {}, ["v1.abc"]]) {
      assert.equal(
        parseClientMessage(JSON.stringify({ type: "signal", sealed })),
        null,
        JSON.stringify(sealed),
      );
    }
  });

  it("caps the raw message at the signal size limit, envelope included", () => {
    const rawWith = (bodyChars: number) =>
      JSON.stringify({ type: "signal", sealed: `v1.${"a".repeat(bodyChars)}` });

    // The limit applies to the frame as received, so the largest body that
    // fits is whatever the JSON envelope leaves over.
    const room = MAX_SIGNAL_BYTES - rawWith(0).length;
    assert.equal(rawWith(room).length, MAX_SIGNAL_BYTES);
    assert.notEqual(parseClientMessage(rawWith(room)), null);
    assert.equal(parseClientMessage(rawWith(room + 1)), null);
  });
});

describe("validateClipMeta", () => {
  it("accepts a clip with no metadata, as older clients send", () => {
    assert.deepEqual(validateClipMeta(undefined), { ok: true, meta: undefined });
    assert.deepEqual(validateClipMeta(null), { ok: true, meta: undefined });
  });

  it("accepts ciphertext up to the cap, and nothing longer", () => {
    const atCap = `v1.${"a".repeat(MAX_CLIP_META_CHARS - 3)}`;
    assert.deepEqual(validateClipMeta(atCap), { ok: true, meta: atCap });
    assert.equal(validateClipMeta(`${atCap}a`).ok, false);
  });

  it("rejects what is not ciphertext, plaintext metadata included", () => {
    for (const value of [...NOT_STRINGS, "", "Laptop", '{"name":"Laptop"}', "v2.abc"]) {
      assert.equal(validateClipMeta(value).ok, false, JSON.stringify(value));
    }
  });
});

describe("normalizeDeviceName", () => {
  it("collapses a name to one trimmed line", () => {
    assert.equal(normalizeDeviceName("  Work \t laptop\n"), "Work laptop");
  });

  it("strips control and invisible formatting characters", () => {
    assert.equal(normalizeDeviceName("Lap\u0000top\u202E"), "Lap top");
  });

  it("cuts at the cap by character, not by UTF-16 unit", () => {
    const name = normalizeDeviceName("😀".repeat(MAX_DEVICE_NAME_CHARS + 5));
    assert.equal(name, "😀".repeat(MAX_DEVICE_NAME_CHARS));
  });

  it("returns null when nothing is left to show", () => {
    for (const value of [...NOT_STRINGS, undefined, null, "", "  \n ", "\u200B"]) {
      assert.equal(normalizeDeviceName(value), null, JSON.stringify(value));
    }
  });
});

describe("parseClipMeta", () => {
  it("keeps a name and a well-formed device id, and nothing else", () => {
    assert.deepEqual(
      parseClipMeta({ name: " Phone ", device: "device-0123456789", evil: "x" }),
      { name: "Phone", device: "device-0123456789" },
    );
  });

  it("keeps the name of a sender that carries no device id", () => {
    assert.deepEqual(parseClipMeta({ name: "ci-runner" }), { name: "ci-runner" });
    assert.deepEqual(parseClipMeta({ name: "ci-runner", device: "no" }), {
      name: "ci-runner",
    });
  });

  it("rejects metadata with no usable name", () => {
    for (const value of [null, "Phone", [], {}, { name: "" }, { device: "device-0123456789" }]) {
      assert.equal(parseClipMeta(value), null, JSON.stringify(value));
    }
  });
});

describe("validateEraseCheck", () => {
  const CHECK = "Ca6ZOdTofvJOYgKCvsgPRUjF1gi8VSMS_zwj2pgY5SA";

  it("accepts a room created with none, as older clients create them", () => {
    assert.deepEqual(validateEraseCheck(undefined), { ok: true, eraseCheck: undefined });
    assert.deepEqual(validateEraseCheck(null), { ok: true, eraseCheck: undefined });
  });

  it("accepts a base64url SHA-256 digest and nothing of another shape", () => {
    assert.deepEqual(validateEraseCheck(CHECK), { ok: true, eraseCheck: CHECK });
    for (const value of [...NOT_STRINGS, "", CHECK.slice(1), `${CHECK}a`, CHECK.replace("_", "/")]) {
      assert.equal(validateEraseCheck(value).ok, false, JSON.stringify(value));
    }
  });
});

describe("validateEraseToken", () => {
  const TOKEN = "9S40T3JBEMJG4C2XR5MXMM5RQ6H904A1ZRH302S6A6J54HV4EFD0";

  it("accepts a token of the right length and alphabet only", () => {
    assert.equal(validateEraseToken(TOKEN), true);
    for (const value of [...NOT_STRINGS, null, undefined, "", TOKEN.slice(1), TOKEN.toLowerCase(), `${TOKEN}0`]) {
      assert.equal(validateEraseToken(value), false, JSON.stringify(value));
    }
  });
});

describe("parseEraseRequest", () => {
  it("accepts a list of clip ids, without repeats", () => {
    assert.deepEqual(parseEraseRequest({ ids: [3, 1, 3] }), { ids: [3, 1] });
  });

  it("accepts a bound to delete up to", () => {
    assert.deepEqual(parseEraseRequest({ upTo: 1_791_081_574_654_977 }), {
      upTo: 1_791_081_574_654_977,
    });
  });

  it("keeps only the selector", () => {
    assert.deepEqual(parseEraseRequest({ ids: [1], everything: true }), { ids: [1] });
  });

  it("rejects a request that names nothing, both, too much, or what is not a clip id", () => {
    const tooMany = Array.from({ length: MAX_ERASE_IDS + 1 }, (_, index) => index + 1);
    for (const value of [
      null,
      [],
      {},
      { ids: [] },
      { ids: tooMany },
      { ids: [1], upTo: 2 },
      { ids: ["1"] },
      { ids: [0] },
      { ids: [-1] },
      { ids: [1.5] },
      { ids: [2 ** 53] },
      { upTo: 0 },
      { upTo: "all" },
      { upTo: Number.POSITIVE_INFINITY },
    ]) {
      assert.equal(parseEraseRequest(value), null, JSON.stringify(value));
    }
  });
});
