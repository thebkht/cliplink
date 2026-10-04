import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";

import {
  decryptClipText,
  encryptClipText,
  generateRoomKey,
  openClipMeta,
  openSignal,
  sealClipMeta,
  sealSignal,
  type RoomKey,
} from "../src/crypto.ts";
import {
  createEncryptedTransport,
  RoomKeyMismatchError,
  UNDECRYPTABLE_TEXT,
} from "../src/encrypted-transport.ts";
import { CIPHERTEXT_PATTERN } from "../src/protocol.ts";
import type { Clip, GetRoomResponse, SealedTransport, SignalPayload } from "../src/types.ts";
import { settle, waitFor } from "./support.ts";

const ROOM = "X7KP2M";
const OTHER_ROOM = "Q2W3E4";
const PEER = "peer-abcdef";

type Handlers = Parameters<SealedTransport["streamClips"]>[3];

/**
 * The wire half of the seam: a `SealedTransport` that records what it is asked
 * and lets a test push messages up through the handlers it was given. It only
 * ever sees ciphertext, which is the point — the tests assert on that.
 */
function fakeWire() {
  const state = {
    room: { code: ROOM, createdAt: 0, ttlSeconds: 21_600 } as GetRoomResponse["room"],
    roomClips: [] as Clip[],
    polled: [] as Clip[],
    pollArgs: [] as Array<{ code: string; afterId: number }>,
    canSend: true,
    sentClips: [] as Array<{
      code: string;
      text: string;
      senderId: string;
      meta?: string;
      from?: unknown;
    }>,
    sentSignals: [] as Array<{ sealed: string; to?: string }>,
    pollGen: undefined as number | undefined,
    connects: 0,
    erases: [] as Array<{ code: string; token: string; request: unknown }>,
    eraseResponse: { ids: [] as number[], gen: 0 },
    streamArgs: null as { code: string; afterId: number; peerId: string } | null,
    handlers: null as Handlers | null,
    streamReturn: (() => {}) as (() => void) | null,
    disconnects: 0,
  };

  const wire: SealedTransport = {
    async connect() {
      state.connects += 1;
      return { room: state.room, clips: state.roomClips };
    },
    async eraseClips(code, token, request) {
      state.erases.push({ code, token, request });
      return state.eraseResponse;
    },
    async sendClip(code, payload) {
      state.sentClips.push({ code, ...payload });
      return {
        clip: {
          id: 9,
          text: payload.text,
          senderId: payload.senderId,
          ts: 1_700_000_000,
          ...(payload.meta ? { meta: payload.meta } : {}),
        },
        expiresAt: 4_242,
      };
    },
    async pollClips(code, afterId) {
      state.pollArgs.push({ code, afterId });
      return {
        clips: state.polled,
        ...(state.pollGen === undefined ? {} : { eraseGen: state.pollGen }),
      };
    },
    streamClips(code, afterId, peerId, handlers) {
      state.streamArgs = { code, afterId, peerId };
      state.handlers = handlers;
      return state.streamReturn;
    },
    canSend: () => state.canSend,
    sendSealedSignal(sealed, to) {
      state.sentSignals.push({ sealed, to });
      return true;
    },
    disconnect() {
      state.disconnects += 1;
    },
  };

  return { wire, state };
}

describe("createEncryptedTransport", () => {
  let key: RoomKey;
  let otherKey: RoomKey;

  before(async () => {
    key = await generateRoomKey();
    otherKey = await generateRoomKey();
  });

  const clip = (id: number, text: string): Clip => ({
    id,
    text,
    senderId: "someone-else",
    ts: 1_700_000_000 + id,
  });

  const sealedClip = async (id: number, text: string, under = key, room = ROOM) =>
    clip(id, await encryptClipText(under, room, text));

  /** A transport over a fresh fake wire, with the room key loaded unless told otherwise. */
  function setup({ withKey = true } = {}) {
    const { wire, state } = fakeWire();
    const transport = createEncryptedTransport(wire);
    if (withKey) {
      transport.setRoomKey(ROOM, key);
    }
    return { transport, wire, state };
  }

  /** Streams with a recording `onSignal`, and returns what it heard. */
  function stream(transport: ReturnType<typeof setup>["transport"]) {
    const signals: Array<{ from: string; payload: SignalPayload }> = [];
    const clips: Clip[][] = [];
    const events: string[] = [];
    const cleanup = transport.streamClips(ROOM, 5, "peer-me-12345", {
      onOpen: () => events.push("open"),
      onClips: (incoming) => clips.push(incoming),
      onSignal: (from, payload) => signals.push({ from, payload }),
      onDisconnect: (reason) => events.push(`disconnect:${reason}`),
    });
    return { signals, clips, events, cleanup };
  }

  describe("connect", () => {
    it("opens every clip the room already holds and leaves the rest of each intact", async () => {
      const { transport, state } = setup();
      state.roomClips = [await sealedClip(1, "first"), await sealedClip(2, "second — ünïcode ✓")];

      const response = await transport.connect(ROOM);

      assert.deepEqual(
        response.clips.map(({ id, text, senderId, ts }) => ({ id, text, senderId, ts })),
        [
          { id: 1, text: "first", senderId: "someone-else", ts: 1_700_000_001 },
          { id: 2, text: "second — ünïcode ✓", senderId: "someone-else", ts: 1_700_000_002 },
        ],
      );
      assert.equal(response.room.code, ROOM);
    });

    it("substitutes a placeholder for a clip it cannot open, rather than dropping it", async () => {
      const { transport, state } = setup();
      state.roomClips = [
        await sealedClip(1, "readable"),
        await sealedClip(2, "wrong key", otherKey),
        await sealedClip(3, "wrong room", key, OTHER_ROOM),
        clip(4, "v1.notreallyciphertext"),
        clip(5, "plain text that was never encrypted"),
        await sealedClip(6, "also readable"),
      ];

      const { clips } = await transport.connect(ROOM);

      assert.deepEqual(
        clips.map((entry) => [entry.id, entry.text]),
        [
          [1, "readable"],
          [2, UNDECRYPTABLE_TEXT],
          [3, UNDECRYPTABLE_TEXT],
          [4, UNDECRYPTABLE_TEXT],
          [5, UNDECRYPTABLE_TEXT],
          [6, "also readable"],
        ],
      );
    });

    it("throws RoomKeyMismatchError when the key is not the one the room was made with", async () => {
      const { transport, state } = setup();
      state.room = { ...state.room, keyCheck: otherKey.check };
      state.roomClips = [await sealedClip(1, "unreachable")];

      await assert.rejects(transport.connect(ROOM), (error: unknown) => {
        assert.ok(error instanceof RoomKeyMismatchError);
        assert.equal(error.name, "RoomKeyMismatchError");
        assert.match(error.message, /does not match this room/);
        return true;
      });
    });

    it("connects when the room's fingerprint matches the key", async () => {
      const { transport, state } = setup();
      state.room = { ...state.room, keyCheck: key.check };
      state.roomClips = [await sealedClip(1, "hello")];

      const { clips } = await transport.connect(ROOM);
      assert.equal(clips[0].text, "hello");
    });

    it("connects to a room with no fingerprint, an open or older one, whatever the key", async () => {
      const { transport, state } = setup();
      assert.equal(state.room.keyCheck, undefined);
      await assert.doesNotReject(transport.connect(ROOM));
    });

    it("with no key loaded, reads nothing and still does not throw", async () => {
      const { transport, state } = setup({ withKey: false });
      state.room = { ...state.room, keyCheck: key.check };
      state.roomClips = [await sealedClip(1, "hello")];

      const { clips } = await transport.connect(ROOM);
      assert.deepEqual(
        clips.map((entry) => entry.text),
        [UNDECRYPTABLE_TEXT],
      );
    });

    it("stops reading once the key is cleared", async () => {
      const { transport, state } = setup();
      state.roomClips = [await sealedClip(1, "hello")];
      assert.equal((await transport.connect(ROOM)).clips[0].text, "hello");

      transport.clearRoomKey();
      assert.equal((await transport.connect(ROOM)).clips[0].text, UNDECRYPTABLE_TEXT);
    });
  });

  describe("sendClip", () => {
    it("refuses to send without a key, and sends nothing", async () => {
      const { transport, state } = setup({ withKey: false });

      await assert.rejects(
        transport.sendClip(ROOM, { text: "secret", senderId: "cli-sender-1" }),
        /no key is loaded/,
      );
      assert.equal(state.sentClips.length, 0);
    });

    it("refuses after the key is cleared", async () => {
      const { transport, state } = setup();
      transport.clearRoomKey();

      await assert.rejects(transport.sendClip(ROOM, { text: "secret", senderId: "cli-sender-1" }));
      assert.equal(state.sentClips.length, 0);
    });

    it("puts only ciphertext on the wire, which the room key opens", async () => {
      const { transport, state } = setup();

      await transport.sendClip(ROOM, { text: "the secret text", senderId: "cli-sender-1" });

      const [sent] = state.sentClips;
      assert.equal(sent.code, ROOM);
      assert.equal(sent.senderId, "cli-sender-1");
      assert.match(sent.text, CIPHERTEXT_PATTERN);
      assert.equal(sent.text.includes("secret"), false);
      assert.equal(await decryptClipText(key, ROOM, sent.text), "the secret text");
    });

    it("seals afresh each time, so the same text never repeats on the wire", async () => {
      const { transport, state } = setup();

      await transport.sendClip(ROOM, { text: "same", senderId: "cli-sender-1" });
      await transport.sendClip(ROOM, { text: "same", senderId: "cli-sender-1" });

      assert.notEqual(state.sentClips[0].text, state.sentClips[1].text);
    });

    it("hands back the plaintext it was given, so the sender's own row is readable", async () => {
      const { transport } = setup();

      const response = await transport.sendClip(ROOM, { text: "mine", senderId: "cli-sender-1" });

      assert.equal(response.clip.text, "mine");
      assert.equal(response.clip.id, 9);
      assert.equal(response.clip.senderId, "cli-sender-1");
      assert.equal(response.expiresAt, 4_242);
    });
  });

  describe("deleting clips", () => {
    /** Joined to a room holding clips 1–3, at the given deletion count. */
    async function joined(eraseGen: number | undefined = 0) {
      const made = setup();
      made.state.room = { ...made.state.room, erasable: true, eraseGen };
      made.state.roomClips = await Promise.all([
        sealedClip(1, "one"),
        sealedClip(2, "two"),
        sealedClip(3, "three"),
      ]);
      await made.transport.connect(ROOM);
      made.state.connects = 0;
      return made;
    }

    /** What the room holds from now on, as the server would report it. */
    const serverNow = async (
      state: ReturnType<typeof setup>["state"],
      ids: number[],
      eraseGen: number,
    ) => {
      state.room = { ...state.room, eraseGen };
      state.roomClips = await Promise.all(ids.map((id) => sealedClip(id, `clip ${id}`)));
    };

    it("presents the room key's erase token, and never the key", async () => {
      const { transport, state } = await joined();
      state.eraseResponse = { ids: [2], gen: 1 };

      const response = await transport.eraseClips(ROOM, { ids: [2] });

      assert.deepEqual(state.erases, [
        { code: ROOM, token: key.eraseToken, request: { ids: [2] } },
      ]);
      assert.notEqual(key.eraseToken, key.encoded);
      assert.deepEqual(response, { ids: [2], gen: 1 });
    });

    it("refuses to delete without a key, and asks the server nothing", async () => {
      const { transport, state } = setup({ withKey: false });

      await assert.rejects(transport.eraseClips(ROOM, { ids: [1] }), /no key is loaded/);
      assert.equal(state.erases.length, 0);
    });

    it("reports a removal the socket announces", async () => {
      const { transport, state } = await joined();
      const removed: number[][] = [];
      transport.streamClips(ROOM, 3, "peer-me-12345", {
        onClips: () => {},
        onRemoved: (ids) => removed.push(ids),
        onDisconnect: () => {},
      });

      state.handlers?.onRemoved?.([2], 1);

      assert.deepEqual(removed, [[2]]);
      assert.equal(state.connects, 0, "an in-order removal needs no second look");
    });

    it("does not deliver a clip whose removal arrived while it was being opened", async () => {
      const { transport, state } = await joined();
      const { clips } = stream(transport);

      state.handlers?.onClips([await sealedClip(4, "burned at once")]);
      state.handlers?.onRemoved?.([4], 1);
      state.handlers?.onClips([await sealedClip(5, "after")]);
      await waitFor(() => clips.length === 2, "both batches");

      assert.deepEqual(
        clips.map((batch) => batch.map((entry) => entry.id)),
        [[], [5]],
      );
    });

    it("finds what a poll could not say was deleted, by the count moving", async () => {
      const { transport, state } = await joined();
      await serverNow(state, [1, 3], 1);
      state.polled = [];
      state.pollGen = 1;

      const response = await transport.pollClips(ROOM, 3);

      assert.deepEqual(response.removed, [2]);
      assert.equal(state.connects, 1);
    });

    it("looks once per deletion, not once per poll", async () => {
      const { transport, state } = await joined();
      await serverNow(state, [1, 3], 1);
      state.pollGen = 1;

      await transport.pollClips(ROOM, 3);
      const again = await transport.pollClips(ROOM, 3);

      assert.equal(state.connects, 1);
      assert.equal("removed" in again, false);
    });

    it("takes a poll with no count as no information, not as a count of zero", async () => {
      const { transport, state } = await joined(2);
      state.pollGen = undefined;

      const response = await transport.pollClips(ROOM, 3);

      assert.equal(state.connects, 0);
      assert.equal("removed" in response, false);
    });

    it("does not count a clip the same poll delivered as missing", async () => {
      const { transport, state } = await joined();
      const four = await sealedClip(4, "new");
      state.polled = [four];
      state.pollGen = 1;
      state.room = { ...state.room, eraseGen: 1 };
      state.roomClips = [await sealedClip(1, "one"), await sealedClip(3, "three"), four];

      const response = await transport.pollClips(ROOM, 3);

      assert.deepEqual(response.removed, [2]);
      assert.deepEqual(response.clips.map((entry) => entry.id), [4]);
    });

    it("keeps polling when the look itself fails, and tries again next time", async () => {
      const { transport, state, wire } = await joined();
      state.pollGen = 1;
      const connect = wire.connect;
      wire.connect = async () => {
        throw new Error("offline");
      };

      const first = await transport.pollClips(ROOM, 3);
      assert.equal("removed" in first, false);

      wire.connect = connect;
      await serverNow(state, [1, 3], 1);
      const second = await transport.pollClips(ROOM, 3);
      assert.deepEqual(second.removed, [2]);
    });

    it("catches up on reconnect, when the socket's backlog cannot mention a deletion", async () => {
      const { transport, state } = await joined();
      const removed: number[][] = [];
      const events: string[] = [];
      transport.streamClips(ROOM, 3, "peer-me-12345", {
        onOpen: () => events.push("open"),
        onClips: () => {},
        onRemoved: (ids) => removed.push(ids),
        onDisconnect: () => {},
      });
      await serverNow(state, [3], 2);

      state.handlers?.onOpen?.(2);
      await waitFor(() => removed.length === 1, "the catch-up");

      assert.deepEqual(events, ["open"]);
      assert.deepEqual(removed, [[1, 2]]);
    });

    it("looks again when a removal arrives having skipped one", async () => {
      const { transport, state } = await joined();
      const removed: number[][] = [];
      transport.streamClips(ROOM, 3, "peer-me-12345", {
        onClips: () => {},
        onRemoved: (ids) => removed.push(ids),
        onDisconnect: () => {},
      });
      await serverNow(state, [3], 2);

      state.handlers?.onRemoved?.([2], 2);
      await waitFor(() => removed.length === 2, "the missed removal");

      assert.deepEqual(removed, [[2], [1]]);
    });

    it("reports what else had gone when its own delete reveals a gap", async () => {
      const { transport, state } = await joined();
      await serverNow(state, [3], 2);
      state.eraseResponse = { ids: [2], gen: 2 };

      const response = await transport.eraseClips(ROOM, { ids: [2] });

      assert.deepEqual([...response.ids].sort(), [1, 2]);
    });

    it("starts over from a fresh connect", async () => {
      const { transport, state } = await joined();
      state.handlers = null;
      await serverNow(state, [7], 5);
      await transport.connect(ROOM);
      state.connects = 0;
      state.pollGen = 5;

      const response = await transport.pollClips(ROOM, 7);

      assert.equal(state.connects, 0);
      assert.equal("removed" in response, false);
    });
  });

  describe("clip metadata", () => {
    const FROM = { name: "Work laptop", device: "device-0123456789" };

    it("seals who sent a clip, bound to that clip's text, and keeps the plaintext off the wire", async () => {
      const { transport, state } = setup();

      await transport.sendClip(ROOM, { text: "hi", senderId: "cli-sender-1", from: FROM });

      const [sent] = state.sentClips;
      assert.equal(sent.from, undefined);
      assert.ok(sent.meta);
      assert.match(sent.meta, CIPHERTEXT_PATTERN);
      assert.equal(JSON.stringify(sent).includes("Work laptop"), false);
      assert.deepEqual(await openClipMeta(key, ROOM, sent.text, sent.meta), FROM);
    });

    it("sends no metadata when the caller names no sender", async () => {
      const { transport, state } = setup();

      await transport.sendClip(ROOM, { text: "hi", senderId: "cli-sender-1" });

      assert.equal("meta" in state.sentClips[0], false);
    });

    it("never forwards metadata the caller sealed itself", async () => {
      const { transport, state } = setup();

      await transport.sendClip(ROOM, { text: "hi", senderId: "cli-sender-1", meta: "v1.forged" });

      assert.equal("meta" in state.sentClips[0], false);
    });

    it("hands the sender back its own name, not the sealed form", async () => {
      const { transport } = setup();

      const response = await transport.sendClip(ROOM, {
        text: "hi",
        senderId: "cli-sender-1",
        from: FROM,
      });

      assert.deepEqual(response.clip.from, FROM);
      assert.equal("meta" in response.clip, false);
    });

    it("opens the sender of a clip it receives", async () => {
      const { transport, state } = setup();
      const sealed = await sealedClip(1, "first");
      state.roomClips = [{ ...sealed, meta: await sealClipMeta(key, ROOM, sealed.text, FROM) }];

      const { clips } = await transport.connect(ROOM);

      assert.deepEqual(clips[0].from, FROM);
      assert.equal("meta" in clips[0], false);
      assert.equal(clips[0].text, "first");
    });

    it("leaves a clip from an older client unattributed and readable", async () => {
      const { transport, state } = setup();
      state.roomClips = [await sealedClip(1, "first")];

      const { clips } = await transport.connect(ROOM);

      assert.equal("from" in clips[0], false);
      assert.equal(clips[0].text, "first");
    });

    it("drops a sender the server wrote in plaintext", async () => {
      const { transport, state } = setup();
      state.roomClips = [{ ...(await sealedClip(1, "first")), from: { name: "Forged" } }];

      const { clips } = await transport.connect(ROOM);

      assert.equal("from" in clips[0], false);
    });

    it("drops metadata lifted from another clip, and still reads the text", async () => {
      const { transport, state } = setup();
      const [first, second] = await Promise.all([sealedClip(1, "first"), sealedClip(2, "second")]);
      state.roomClips = [
        { ...second, meta: await sealClipMeta(key, ROOM, first.text, FROM) },
      ];

      const { clips } = await transport.connect(ROOM);

      assert.equal("from" in clips[0], false);
      assert.equal(clips[0].text, "second");
    });

    it("drops metadata that opens to something other than a sender", async () => {
      const { transport, state } = setup();
      const sealed = await sealedClip(1, "first");
      state.roomClips = [
        { ...sealed, meta: await sealClipMeta(key, ROOM, sealed.text, { name: "" }) },
      ];

      const { clips } = await transport.connect(ROOM);

      assert.equal("from" in clips[0], false);
    });

    it("opens no sender without a key", async () => {
      const { transport, state } = setup({ withKey: false });
      const sealed = await sealedClip(1, "first");
      state.roomClips = [{ ...sealed, meta: await sealClipMeta(key, ROOM, sealed.text, FROM) }];

      const { clips } = await transport.connect(ROOM);

      assert.equal(clips[0].text, UNDECRYPTABLE_TEXT);
      assert.equal("from" in clips[0], false);
      assert.equal("meta" in clips[0], false);
    });
  });

  describe("pollClips", () => {
    it("opens what the poll returns, and asks the wire for the same cursor", async () => {
      const { transport, state } = setup();
      state.polled = [await sealedClip(7, "polled"), await sealedClip(8, "nope", otherKey)];

      const { clips } = await transport.pollClips(ROOM, 6);

      assert.deepEqual(state.pollArgs, [{ code: ROOM, afterId: 6 }]);
      assert.deepEqual(
        clips.map((entry) => [entry.id, entry.text]),
        [
          [7, "polled"],
          [8, UNDECRYPTABLE_TEXT],
        ],
      );
    });
  });

  describe("streamClips", () => {
    it("passes the stream's arguments through and returns the wire's cleanup", () => {
      const { transport, state } = setup();
      const cleanup = () => {};
      state.streamReturn = cleanup;

      assert.equal(stream(transport).cleanup, cleanup);
      assert.deepEqual(state.streamArgs, { code: ROOM, afterId: 5, peerId: "peer-me-12345" });
    });

    it("passes on a null cleanup, which is how a caller learns there is no WebSocket", () => {
      const { transport, state } = setup();
      state.streamReturn = null;

      assert.equal(stream(transport).cleanup, null);
    });

    it("forwards open and disconnect untouched", () => {
      const { transport, state } = setup();
      const { events } = stream(transport);

      state.handlers?.onOpen?.();
      state.handlers?.onDisconnect("error");
      state.handlers?.onDisconnect("closed");

      assert.deepEqual(events, ["open", "disconnect:error", "disconnect:closed"]);
    });

    it("opens streamed clips before handing them up", async () => {
      const { transport, state } = setup();
      const { clips } = stream(transport);

      state.handlers?.onClips([await sealedClip(6, "streamed"), await sealedClip(7, "x", otherKey)]);
      await waitFor(() => clips.length === 1, "the streamed clips");

      assert.deepEqual(
        clips[0].map((entry) => entry.text),
        ["streamed", UNDECRYPTABLE_TEXT],
      );
    });

    describe("signals", () => {
      const deliver = async (
        state: ReturnType<typeof setup>["state"],
        payload: unknown,
        { under = key, room = ROOM } = {},
      ) => {
        state.handlers?.onSealedSignal?.(PEER, await sealSignal(under, room, payload));
      };

      it("delivers a presence signal from the peer it names", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "presence", name: "Phone", peer: PEER });
        await waitFor(() => signals.length === 1, "the signal");

        assert.deepEqual(signals, [
          { from: PEER, payload: { type: "presence", name: "Phone", peer: PEER } },
        ]);
      });

      it("drops a presence signal that names a peer other than its sender", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "presence", name: "Impostor", peer: "peer-someone-else" });
        await deliver(state, { type: "hello-ack" });
        await waitFor(() => signals.length === 1, "the signal after it");

        assert.deepEqual(signals, [{ from: PEER, payload: { type: "hello-ack" } }]);
      });

      it("opens a sealed signal and delivers it with the peer it came from", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "hello-ack" });
        await waitFor(() => signals.length === 1, "the signal");

        assert.deepEqual(signals, [{ from: PEER, payload: { type: "hello-ack" } }]);
      });

      it("rebuilds the payload from the fields the protocol defines", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "hello", smuggled: "<script>" });
        await waitFor(() => signals.length === 1, "the signal");

        assert.deepEqual(signals[0].payload, { type: "hello" });
      });

      it("drops a signal it cannot open", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "hello" }, { under: otherKey });
        await deliver(state, { type: "hello" }, { room: OTHER_ROOM });
        state.handlers?.onSealedSignal?.(PEER, "v1.notreallyciphertext");
        state.handlers?.onSealedSignal?.(PEER, "garbage");
        // A clip's ciphertext, replayed as a signal: the subkeys differ, so it must not open.
        state.handlers?.onSealedSignal?.(PEER, await encryptClipText(key, ROOM, '{"type":"hello-ack"}'));
        // A good one behind them, so there is something to wait for.
        await deliver(state, { type: "hello-ack" });
        await waitFor(() => signals.length >= 1, "the good signal");
        await settle();

        assert.deepEqual(signals, [{ from: PEER, payload: { type: "hello-ack" } }]);
      });

      it("drops a signal that opens but is not one the protocol defines", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "no-such-signal" });
        await deliver(state, "just a string");
        await deliver(state, null);
        await deliver(state, { type: "file-offer", offerId: "short", name: "x", size: 1, mime: "" });
        await deliver(state, { type: "hello-ack" });
        await waitFor(() => signals.length >= 1, "the good signal");
        await settle();

        assert.deepEqual(signals, [{ from: PEER, payload: { type: "hello-ack" } }]);
      });

      it("will not deliver a peer's claim that someone left", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        await deliver(state, { type: "peer-left", from: "peer-victim-01" });
        await deliver(state, { type: "hello-ack" });
        await waitFor(() => signals.length >= 1, "the good signal");
        await settle();

        assert.deepEqual(signals, [{ from: PEER, payload: { type: "hello-ack" } }]);
      });

      it("delivers the server's own peer-left, which arrives unsealed", () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        state.handlers?.onPeerLeft?.("peer-gone-0001");

        assert.deepEqual(signals, [{ from: "peer-gone-0001", payload: { type: "peer-left" } }]);
      });

      it("reads the key when the signal arrives, not when the stream began", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);

        transport.setRoomKey(ROOM, otherKey);
        await deliver(state, { type: "hello-ack" }, { under: otherKey });
        await waitFor(() => signals.length === 1, "the signal");

        assert.equal(signals[0].payload.type, "hello-ack");
      });

      it("hears nothing with no key loaded", async () => {
        const { transport, state } = setup();
        const { signals } = stream(transport);
        const sealed = await sealSignal(key, ROOM, { type: "hello-ack" });

        transport.clearRoomKey();
        state.handlers?.onSealedSignal?.(PEER, sealed);
        await settle();

        assert.deepEqual(signals, []);
      });

      it("copes with a caller that gave no onSignal", async () => {
        const { transport, state } = setup();
        transport.streamClips(ROOM, 0, "peer-me-12345", {
          onClips: () => {},
          onDisconnect: () => {},
        });

        state.handlers?.onSealedSignal?.(PEER, await sealSignal(key, ROOM, { type: "hello-ack" }));
        state.handlers?.onPeerLeft?.(PEER);
        await settle();
      });
    });
  });

  describe("sendSignal", () => {
    it("says no when there is no key", () => {
      const { transport, state } = setup({ withKey: false });
      assert.equal(transport.sendSignal({ type: "hello" }), false);
      assert.equal(state.sentSignals.length, 0);
    });

    it("says no when the socket cannot carry it, so the caller can try again later", async () => {
      const { transport, state } = setup();
      state.canSend = false;

      assert.equal(transport.sendSignal({ type: "hello" }), false);
      await settle();
      assert.equal(state.sentSignals.length, 0);
    });

    it("answers at once, then seals and sends", async () => {
      const { transport, state } = setup();

      assert.equal(transport.sendSignal({ type: "hello-ack" }, "peer-target-01"), true);
      assert.equal(state.sentSignals.length, 0, "nothing is on the wire before sealing finishes");

      await waitFor(() => state.sentSignals.length === 1, "the sealed signal");
      const [sent] = state.sentSignals;
      assert.equal(sent.to, "peer-target-01");
      assert.match(sent.sealed, CIPHERTEXT_PATTERN);
      assert.deepEqual(await openSignal(key, ROOM, sent.sealed), { type: "hello-ack" });
    });

    it("broadcasts when no peer is named", async () => {
      const { transport, state } = setup();
      transport.sendSignal({ type: "hello" });
      await waitFor(() => state.sentSignals.length === 1, "the sealed signal");
      assert.equal(state.sentSignals[0].to, undefined);
    });

    it("keeps send order even when an earlier signal is slower to seal", async () => {
      // An ICE candidate overtaking the description it belongs to breaks the
      // handshake. Make the first seal the slow one; without the chain, the
      // others would overtake it.
      const { transport, state } = setup();
      const original = crypto.subtle.encrypt.bind(crypto.subtle);
      let calls = 0;
      const slowFirst = mock.method(
        crypto.subtle,
        "encrypt",
        async (...args: Parameters<typeof original>) => {
          calls += 1;
          if (calls === 1) {
            await settle(40);
          }
          return original(...args);
        },
      );

      try {
        transport.sendSignal({ type: "hello" }, "peer-first-001");
        transport.sendSignal({ type: "hello-ack" }, "peer-second-01");
        transport.sendSignal({ type: "hello" }, "peer-third-001");
        await waitFor(() => state.sentSignals.length === 3, "all three signals");
      } finally {
        slowFirst.mock.restore();
      }

      assert.deepEqual(
        state.sentSignals.map((sent) => sent.to),
        ["peer-first-001", "peer-second-01", "peer-third-001"],
      );
      const opened = await Promise.all(state.sentSignals.map((sent) => openSignal(key, ROOM, sent.sealed)));
      assert.deepEqual(opened, [{ type: "hello" }, { type: "hello-ack" }, { type: "hello" }]);
    });

    it("drops a signal that cannot be sealed without stalling those behind it", async () => {
      const { transport, state } = setup();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      // JSON.stringify throws on this, inside the seal.
      assert.equal(transport.sendSignal(cyclic as unknown as SignalPayload, "peer-doomed-01"), true);
      assert.equal(transport.sendSignal({ type: "hello-ack" }, "peer-after-001"), true);
      await waitFor(() => state.sentSignals.length >= 1, "the signal behind the bad one");
      await settle();

      assert.deepEqual(
        state.sentSignals.map((sent) => sent.to),
        ["peer-after-001"],
      );
    });
  });

  describe("disconnect", () => {
    it("disconnects the wire", () => {
      const { transport, state } = setup();
      transport.disconnect();
      assert.equal(state.disconnects, 1);
    });
  });
});
