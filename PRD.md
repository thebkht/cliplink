# CLIPLINK — Product Requirements Document

**Version**: 1.4  
**Status**: M2 complete  
**Author**: bkht  
**Date**: 2026-03-28  
**Last Updated**: 2026-03-28

---

## 1. Overview

CLIPLINK is a lightweight, zero-auth web service for syncing clipboard content across devices in real time. Users create a room, share a short code, and anything sent from one device is instantly available — and copied — on the other. No accounts, no install, no friction.

This PRD now reflects both the original product intent and the current implementation status in the deployed codebase.

---

## 2. Problem

Copying a URL, snippet, or chunk of text from one device to another is annoying. The common workarounds — emailing yourself, using Notes, texting yourself, AirDrop (Apple-only) — are all either slow, platform-locked, or require effort disproportionate to the task. There is no fast, universal, open-in-browser solution.

---

## 3. Goals

- Sync clipboard content between any two (or more) devices in under 500ms
- Require zero sign-up, zero install
- Work on any device with a modern browser
- Be shareable via a link or a 6-character room code

### Non-goals (v1)

- End-to-end encryption (planned for v2)
- File/image transfer
- Persistent history across sessions
- Mobile native apps

---

## 4. Users

**Primary**: Developers, power users, and anyone who regularly works across multiple devices (laptop + phone, two laptops, desktop + tablet).

**Secondary**: Anyone sharing a link or snippet with someone else in the same physical space — a fast, frictionless alternative to "just send it to me on Slack."

---

## 5. User Stories

| #   | Story                                                                               |
| --- | ----------------------------------------------------------------------------------- |
| 1   | As a user, I can create a new room instantly without signing up                     |
| 2   | As a user, I can join a room by entering a 6-character code                         |
| 3   | As a user, I can join a room by opening a shared URL                                |
| 4   | As a user, content I send is immediately available on all other devices in the room |
| 5   | As a user, incoming content is automatically copied to my clipboard                 |
| 6   | As a user, I can see a history of clips sent in the current session                 |
| 7   | As a user, I can copy any previous clip from history with one click                 |
| 8   | As a user, I can share the room link directly from within the app                   |

---

## 6. Features

### 6.0 Current Implementation Status

Implemented and deployed:

- Landing screen with create-room and join-by-code flows
- Room entry via `?room=XXXXXX`
- Room header with always-visible room code badge
- Text editor with live character count
- Send via button and `Cmd/Ctrl + Enter`
- "Paste from device" clipboard read action
- History list with `↑ OUT` / `↓ IN`, timestamps, preview, and one-click copy
- Toast notifications and subtle full-screen receive flash
- HTTP polling transport at 1.5s fallback
- API routes for room creation, room fetch, clip creation, and polling
- Session-local sender identity and session-local visible history
- Basic per-IP clip rate limiting in the API layer
- Cloudflare deployment via OpenNext
- Cloudflare KV-backed room storage in production
- SSE realtime stream with polling fallback and reconnect behavior
- QR code sharing from the room view
- Mobile-responsive landing and room layouts

Not yet implemented:

- Durable Object / WebSocket transport
- End-to-end encryption

### 6.1 Rooms

- Rooms are identified by a randomly generated 6-character alphanumeric code (e.g. `X7KP2M`)
- Rooms are ephemeral; server-side room state is designed to expire automatically after inactivity
- Any number of devices can join the same room
- No authentication required to create or join a room
- Rooms are accessible via `cliplink.app/?room=X7KP2M`

### 6.2 Send

- Users type or paste content into the editor
- Clicking **Send** (or pressing `Cmd/Ctrl + Enter`) broadcasts the clip to all peers in the room
- A "Paste from device" button pulls current clipboard content into the editor
- Character count is shown live

### 6.3 Receive

- Incoming clips are displayed in the history panel with direction indicator (↓ IN) and timestamp
- The latest incoming clip is automatically copied to the device clipboard (with browser permission)
- A subtle full-screen flash and toast notification confirms receipt
- History is limited to the last 20 clips in the current session
- If clipboard write is blocked, the clip still appears in history and manual copy remains available

### 6.4 History

- Each clip shows: direction (IN / OUT), timestamp, truncated preview, and a one-click copy button
- History is local to the session — cleared on page reload or room leave
- Outgoing clips are marked ↑ OUT; incoming are marked ↓ IN
- Visible history is capped to 20 items; stored room history is capped to 50 clips

### 6.5 Sharing

- Room code is always visible and clickable to copy the room link
- Shareable URL format: `cliplink.app/?room=XXXXXX`
- In-room QR code sharing is available for handoff between devices
- Visiting the URL directly drops the user into the room

---

## 7. Technical Architecture

### 7.1 Frontend

- Next.js 16 App Router application
- Interactive room experience implemented as a client component
- Navigator Clipboard API for auto-copy on receive
- SSE is the primary realtime transport in the deployed app
- HTTP polling remains in place as the fallback transport and compatibility layer
- Transport abstraction is in place so SSE can later be replaced by WebSockets in M4 without rewriting the room UI
- M0 prototype remains in `prototype.html` as the original single-file reference

### 7.2 Backend (v1 target)

| Layer     | Current implementation                     | Notes                                           |
| --------- | ------------------------------------------ | ----------------------------------------------- |
| Runtime   | Next.js App Router via OpenNext            | Deployed to Cloudflare Workers                  |
| Storage   | Cloudflare KV in production                 | In-memory fallback remains for local/dev        |
| Transport | SSE with polling fallback                   | SSE is live; polling remains for resilience     |
| Hosting   | Cloudflare Workers deployment               | OpenNext build/deploy pipeline is working       |

### 7.3 Data Model

```ts
// Room stored in KV under key: `room:{code}`
type Room = {
  code: string;
  createdAt: number;
  clips: Clip[];
};

type Clip = {
  id: number; // timestamp-based
  text: string;
  senderId: string; // anonymous random ID per session
  ts: number;
};
```

Room TTL in KV: **6 hours** from last activity. Clips capped at 50 per room.

Current implementation note: the storage adapter enforces clip caps and TTL semantics locally and now uses a real Cloudflare KV binding in production.

### 7.4 API Routes

| Method | Route                          | Description                             |
| ------ | ------------------------------ | --------------------------------------- |
| `POST` | `/rooms`                       | Create a new room, returns `{ code }`   |
| `GET`  | `/rooms/:code`                 | Get room data                           |
| `POST` | `/rooms/:code/clips`           | Send a new clip                         |
| `GET`  | `/rooms/:code/clips?after=:id` | Poll for new clips since `id`           |
| `GET`  | `/rooms/:code/stream`          | SSE stream for real-time updates (v1.1) |

Current implementation status:

- Implemented: `POST /rooms`, `GET /rooms/:code`, `POST /rooms/:code/clips`, `GET /rooms/:code/clips?after=:id`, `GET /rooms/:code/stream`

### 7.5 Transport upgrade path

The transport layer evolves in three stages. The client interface stays the same across all three — only the underlying connection mechanism changes.

```
M1  →  HTTP polling      (1.5s interval, stateless Workers + KV)
M2  →  SSE              (real-time push, still stateless Workers)
M4  →  WebSockets       (full-duplex, Cloudflare Durable Objects)
```

#### Stage 1 — HTTP Polling (M1)

Client polls `GET /rooms/:code/clips?after=:id` every 1.5 seconds. Simple, stateless, works with plain KV. Latency: up to 1.5s.

#### Stage 2 — Server-Sent Events (M2)

SSE is a long-lived HTTP GET that allows the server to push events to the client. It fits CLIPLINK's asymmetric model cleanly:

- Clips are **sent** via `POST /rooms/:code/clips` (client → server, unchanged)
- New clips are **pushed** via `GET /rooms/:code/stream` SSE stream (server → client)

SSE works with stateless Cloudflare Workers using a `TransformStream`. No Durable Objects needed. The Worker holds the stream open and flushes a new event whenever a clip is written to KV (polled internally at ~200ms or triggered via KV notification). Latency: ~200–300ms.

```ts
// Worker SSE handler sketch
return new Response(readable, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  },
});
```

SSE reconnects automatically on drop (built into the browser `EventSource` API), and the client falls back to polling while retrying the stream. This is the current launch transport.

#### Stage 3 — WebSockets via Durable Objects (M4)

When usage justifies it, WebSockets replace SSE for true full-duplex, sub-100ms delivery.

```
Browser A ──WS──┐
Browser B ──WS──┤── Durable Object (room:X7KP2M) ──── KV (persistence)
Browser C ──WS──┘
```

Each room maps to a single **Durable Object** instance, co-located at one edge node globally. All devices in that room maintain a persistent WebSocket connection to that DO. When a clip arrives, the DO broadcasts it to all connected sockets in a single loop — no polling, no KV read on receive.

```ts
// DO broadcast sketch
async broadcast(clip: Clip) {
  for (const [id, socket] of this.sessions) {
    socket.send(JSON.stringify({ type: 'clip', data: clip }));
  }
}
```

Latency: ~50–80ms cross-device. Cost: Durable Objects are billed per request + duration — negligible at low scale, non-trivial at high concurrency. Defer until polling/SSE becomes a bottleneck.

#### Comparison

|                 | Polling       | SSE            | WebSocket         |
| --------------- | ------------- | -------------- | ----------------- |
| Latency         | ~750ms avg    | ~200ms         | ~50ms             |
| Infrastructure  | Workers + KV  | Workers + KV   | Workers + KV + DO |
| Complexity      | Low           | Medium         | High              |
| Stateful server | No            | No             | Yes (DO)          |
| Full-duplex     | No            | No             | Yes               |
| Browser support | Universal     | Universal      | Universal         |
| Recommended for | M1 (validate) | M2–M3 (launch) | M4 (scale)        |

---

## 8. Security & Privacy

- Room codes are randomly generated with ~40 bits of entropy — guessing is not practical
- No user data is stored; `senderId` is a random string generated client-side per session
- Rooms and clips are designed to expire automatically via TTL-backed storage
- No logs retained beyond Cloudflare's default request logging
- HTTPS enforced at the edge
- v2 consideration: optional end-to-end encryption using WebCrypto, key derived from room code + user passphrase
- Current implementation includes basic per-IP clip creation rate limiting

---

## 9. Performance Targets

| Metric                               | Target                   | Transport |
| ------------------------------------ | ------------------------ | --------- |
| Clip delivery latency (same region)  | < 200ms                  | SSE       |
| Clip delivery latency (same region)  | < 80ms                   | WebSocket |
| Clip delivery latency (cross-region) | < 500ms                  | SSE       |
| Clip delivery latency (cross-region) | < 150ms                  | WebSocket |
| Page load (cold)                     | < 1s on 3G               | —         |
| Worker cold start                    | 0ms (Cloudflare)         | —         |
| Time to first room                   | < 3s including page load | —         |

---

## 10. UX Requirements

- No modals, no onboarding, no tooltips — the interface is self-evident
- One primary action per screen (Create Room on landing; Send on room view)
- Confirmation of all async actions via toast (never silent)
- Works without clipboard permission granted (manual copy fallback)
- Room code badge always visible, always one click to copy the link
- Mobile-responsive at all breakpoints

---

## 11. Milestones

| Milestone          | Scope                                                                        | Target  |
| ------------------ | ---------------------------------------------------------------------------- | ------- |
| **M0** — Prototype | Single HTML file, localStorage backend, cross-tab sync                       | Done    |
| **M1** — Alpha     | HTTP polling app flow, room APIs, deployable Cloudflare-backed MVP           | Complete |
| **M2** — Beta      | SSE for real-time push, mobile polish, QR code for room link                 | Complete |
| **M3** — Launch    | Custom domain, rate limiting, abuse protection, optional room expiry control | 3 weeks |
| **M4** — v2        | WebSocket via Durable Objects, E2E encryption option, file/image support     | TBD     |

M1 shipped:

- Product UI migrated from prototype into the Next app
- Polling-based room sync implemented
- API surface implemented
- Rate limiting implemented at a basic level
- Cloudflare KV bound in production
- OpenNext Cloudflare build/deploy pipeline working
- Real cross-device production behavior validated sufficiently to ship M1

M2 shipped:

- SSE stream endpoint added and deployed
- Client-side SSE subscription added with polling fallback and retry behavior
- QR code sharing added to the room view
- Mobile layout tightened for landing and in-room flows

---

## 12. Open Questions

- Should rooms support a passphrase for access control, or is code-based access sufficient for v1?
- Is 6 hours still the right room TTL, or should production use 24 hours?
- Is the current default rate limit of 60 clips/min/IP sufficient in production?
- Should the room creator have any elevated permissions (e.g. ability to clear history)?
- When does SSE become a bottleneck? Define the concurrency threshold that triggers the DO/WebSocket migration (suggested: >500 concurrent rooms)
- Should the deployed app keep the current local-session history behavior, or add optional room restore on reload later?

---

## 13. Out of Scope (v1)

- Accounts, authentication, or persistent history
- File or image transfer
- Syntax highlighting or rich text
- Mobile native apps (iOS / Android)
- End-to-end encryption
- Collaborative editing (not a doc editor)
