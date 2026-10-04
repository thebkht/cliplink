import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpClient, resolveBaseUrl } from "../src/http.ts";
import { createWebSocketTransport } from "../src/ws.ts";
import type { WsServerMessage } from "../src/types.ts";

const BASE = "https://cliplink.example";

type Call = { url: string; init?: RequestInit };

function recordingFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("resolveBaseUrl", () => {
  it("passes a string through", () => {
    assert.equal(resolveBaseUrl(BASE), BASE);
  });

  it("calls a function every time, so a lazy origin stays lazy", () => {
    let origin = "https://first.example";
    const lazy = () => origin;
    assert.equal(resolveBaseUrl(lazy), "https://first.example");
    origin = "https://second.example";
    assert.equal(resolveBaseUrl(lazy), "https://second.example");
  });
});

describe("createHttpClient", () => {
  it("addresses the configured origin rather than a relative path", async () => {
    const { calls, fetchImpl } = recordingFetch({ room: {}, clips: [] });
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await client.connectRoom("X7KP2M");

    assert.equal(calls[0].url, `${BASE}/rooms/X7KP2M`);
  });

  it("resolves a lazy origin at call time", async () => {
    const { calls, fetchImpl } = recordingFetch({ clips: [] });
    let origin = "https://first.example";
    const client = createHttpClient({ baseUrl: () => origin, fetch: fetchImpl });

    await client.pollClipsRequest("X7KP2M", 0);
    origin = "https://second.example";
    await client.pollClipsRequest("X7KP2M", 7);

    assert.equal(calls[0].url, "https://first.example/rooms/X7KP2M/clips?after=0");
    assert.equal(calls[1].url, "https://second.example/rooms/X7KP2M/clips?after=7");
  });

  it("posts a clip as JSON", async () => {
    const { calls, fetchImpl } = recordingFetch({ clip: { id: 1 } });
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await client.sendClipRequest("X7KP2M", { text: "v1.abc", senderId: "abcdef" });

    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      text: "v1.abc",
      senderId: "abcdef",
    });
  });

  it("omits keyCheck for an open room, which has nothing to check", async () => {
    const { calls, fetchImpl } = recordingFetch({ code: "X7KP2M" });
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await client.createRoomRequest();

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {});
  });

  it("sends keyCheck and ttlSeconds when given", async () => {
    const { calls, fetchImpl } = recordingFetch({ code: "X7KP2M" });
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await client.createRoomRequest("HQTVJ4C81PPB4", 3600);

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      keyCheck: "HQTVJ4C81PPB4",
      ttlSeconds: 3600,
    });
  });

  it("sends the erase check after the other two, when given", async () => {
    const { calls, fetchImpl } = recordingFetch({ code: "X7KP2M" });
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await client.createRoomRequest("HQTVJ4C81PPB4", undefined, "check");

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      keyCheck: "HQTVJ4C81PPB4",
      eraseCheck: "check",
    });
  });

  it("deletes with the token in a header, and the selector as the body", async () => {
    const { calls, fetchImpl } = recordingFetch({ ids: [4], gen: 1 });
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    const response = await client.eraseClipsRequest("X7KP2M", "TOKEN", { ids: [4] });

    assert.equal(calls[0].url, `${BASE}/rooms/X7KP2M/clips`);
    assert.equal(calls[0].init?.method, "DELETE");
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer TOKEN",
    );
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { ids: [4] });
    assert.equal(String(calls[0].url).includes("TOKEN"), false);
    assert.deepEqual(response, { ids: [4], gen: 1 });
  });

  it("reports a refusal that came back with no JSON, as an older server's would", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 405,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    })) as unknown as typeof globalThis.fetch;
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await assert.rejects(
      client.eraseClipsRequest("X7KP2M", "TOKEN", { ids: [4] }),
      /refused the request \(405\)/,
    );
  });

  it("throws the API's own message rather than a status code", async () => {
    const { fetchImpl } = recordingFetch(
      { error: "Room not found", code: "room_not_found" },
      404,
    );
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await assert.rejects(client.connectRoom("X7KP2M"), /Room not found/);
  });

  it("prefers details over error when the API sends both", async () => {
    const { fetchImpl } = recordingFetch(
      { error: "Bad request", code: "invalid", details: "ttlSeconds too large" },
      400,
    );
    const client = createHttpClient({ baseUrl: BASE, fetch: fetchImpl });

    await assert.rejects(client.connectRoom("X7KP2M"), /ttlSeconds too large/);
  });
});

/** Enough of the WebSocket surface for the transport to drive. */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
  }

  emit(type: string, event: unknown) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  deliver(message: WsServerMessage) {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

function connect(baseUrl: string) {
  const transport = createWebSocketTransport({
    baseUrl,
    WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
  });
  const events: string[] = [];
  const clips: number[] = [];
  const signals: string[] = [];

  const cleanup = transport.streamClips("X7KP2M", 12, "peer-abcdef", {
    onOpen: () => events.push("open"),
    onClips: (incoming) => clips.push(...incoming.map((clip) => clip.id)),
    onSealedSignal: (from, sealed) => signals.push(`${from}:${sealed}`),
    onPeerLeft: (from) => events.push(`left:${from}`),
    onDisconnect: (reason) => events.push(`disconnect:${reason}`),
  });

  return { transport, cleanup, events, clips, signals, socket: FakeSocket.last! };
}

describe("createWebSocketTransport", () => {
  it("upgrades https to wss against the configured origin", () => {
    const { socket } = connect(BASE);
    assert.equal(
      socket.url,
      "wss://cliplink.example/rooms/X7KP2M/socket?after=12&peer=peer-abcdef",
    );
  });

  it("uses ws for a plain-http origin, so local dev connects", () => {
    const { socket } = connect("http://localhost:3000");
    assert.match(socket.url, /^ws:\/\/localhost:3000\//);
  });

  it("reports ready, clips, signals and peer-left to their handlers", () => {
    const { socket, events, clips, signals } = connect(BASE);

    socket.deliver({ type: "ready" });
    socket.deliver({
      type: "clip",
      clip: { id: 13, text: "v1.abc", senderId: "abcdef", ts: 1 },
    });
    socket.deliver({ type: "signal", from: "peer-other", sealed: "v1.xyz" });
    socket.deliver({ type: "peer-left", from: "peer-other" });

    assert.deepEqual(events, ["open", "left:peer-other"]);
    assert.deepEqual(clips, [13]);
    assert.deepEqual(signals, ["peer-other:v1.xyz"]);
  });

  it("passes the deletion count on ready, and removals, to their handlers", () => {
    const transport = createWebSocketTransport({
      baseUrl: BASE,
      WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
    });
    const seen: unknown[] = [];
    transport.streamClips("X7KP2M", 0, "peer-abcdef", {
      onOpen: (eraseGen) => seen.push(["open", eraseGen]),
      onClips: () => {},
      onRemoved: (ids, gen) => seen.push(["removed", ids, gen]),
      onDisconnect: (reason) => seen.push(["disconnect", reason]),
    });
    const socket = FakeSocket.last!;

    socket.deliver({ type: "ready", eraseGen: 3 });
    socket.deliver({ type: "removed", ids: [7, 8], gen: 4 });
    socket.deliver({ type: "ready" });

    assert.deepEqual(seen, [
      ["open", 3],
      ["removed", [7, 8], 4],
      ["open", undefined],
    ]);
  });

  it("ignores a malformed removal rather than acting on it or dropping the socket", () => {
    const { socket, events } = connect(BASE);
    socket.emit("message", { data: JSON.stringify({ type: "removed", ids: "all", gen: 1 }) });
    socket.emit("message", { data: JSON.stringify({ type: "removed", ids: [1] }) });
    assert.deepEqual(events, []);
  });

  it("ignores a frame type it does not know, as a tab from before it existed must", () => {
    const { socket, events, clips } = connect(BASE);
    socket.emit("message", { data: JSON.stringify({ type: "from-the-future", x: 1 }) });
    socket.deliver({ type: "ready" });
    assert.deepEqual(events, ["open"]);
    assert.deepEqual(clips, []);
  });

  it("treats a server error message as a disconnect", () => {
    const { socket, events } = connect(BASE);
    socket.deliver({ type: "error", reason: "room_not_found" });
    assert.deepEqual(events, ["disconnect:error"]);
    assert.ok(socket.closed);
  });

  it("treats an unparseable frame as a disconnect rather than throwing", () => {
    const { socket, events } = connect(BASE);
    socket.emit("message", { data: "{" });
    assert.deepEqual(events, ["disconnect:error"]);
  });

  it("reports a disconnect only once", () => {
    const { socket, events } = connect(BASE);
    socket.emit("error", {});
    socket.emit("close", {});
    assert.deepEqual(events, ["disconnect:error"]);
  });

  it("will not send a signal before the socket is open", () => {
    const { transport, socket } = connect(BASE);
    assert.equal(transport.canSend(), false);
    assert.equal(transport.sendSealedSignal("v1.abc"), false);
    assert.deepEqual(socket.sent, []);
  });

  it("sends a signal once open", () => {
    const { transport, socket } = connect(BASE);
    socket.open();

    assert.equal(transport.canSend(), true);
    assert.equal(transport.sendSealedSignal("v1.abc", "peer-other"), true);
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: "signal",
      to: "peer-other",
      sealed: "v1.abc",
    });
  });

  it("closes the socket and reports a clean disconnect on cleanup", () => {
    const { cleanup, socket, events } = connect(BASE);
    cleanup?.();
    assert.ok(socket.closed);
    assert.deepEqual(events, ["disconnect:closed"]);
  });

  it("returns null when there is no WebSocket to use", () => {
    const transport = createWebSocketTransport({
      baseUrl: BASE,
      WebSocket: undefined,
    });
    const original = globalThis.WebSocket;
    // @ts-expect-error — removing the global is the condition under test.
    delete globalThis.WebSocket;
    try {
      const cleanup = transport.streamClips("X7KP2M", 0, "peer-abcdef", {
        onClips: () => {},
        onDisconnect: () => {},
      });
      assert.equal(cleanup, null);
    } finally {
      globalThis.WebSocket = original;
    }
  });
});
