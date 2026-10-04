# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub Security Advisories:
[Report a vulnerability →](https://github.com/thebkht/cliplink/security/advisories/new)

Please include what you found, how to reproduce it, and what an attacker could do with it. Expect an initial response within a few days — this is a solo-maintained project, so please be patient.

## Threat model

CLIPLINK makes some deliberate tradeoffs that look like vulnerabilities but are known, documented design decisions. Please read these before reporting.

**Rooms are unauthenticated by design, but not readable by code alone.** A room is a random 6-character alphanumeric code. Anyone with the code can join the room, see that clips exist and see file offers arrive — but not read any of it without the room key, which is separate and never reaches the server. No accounts, no install, share a code. Ephemerality (rooms expire on a TTL) and per-IP rate limiting (a 60-token bucket refilling at 1/second, shared across instances through Redis) are the other mitigations.

**Clips and file signaling are encrypted, in one of two modes.** AES-GCM-256 either way. The 32 bytes of key material feed HKDF, giving separate subkeys for clips and for signaling, and the room code is additional data on every message, so a ciphertext lifted from one room cannot be replayed into another.

- **Private rooms** are end-to-end encrypted. The key is generated in the browser and never transmitted: it travels in the URL fragment, which browsers do not send to the server, or is read out and typed in. We cannot read these rooms.
- **Open rooms** derive their key from the room code, so the code alone opens them. The server receives the code in order to route anything, and can therefore derive the key — **this is encryption at rest and in transit, not end-to-end.** It protects against anyone holding the stored data without the code; it does not protect against us. Choose a private room for anything that matters.

The room key is never placed in a path segment or a query parameter, only in the fragment. Paths and query strings travel to the server in the request line and are written to its access logs.

**What the server can still see.** Encryption is not invisibility. The server holds, and an attacker who takes it would hold: the room code, clip IDs and timestamps, sender IDs, the size of each ciphertext, peer IDs, and the timing and volume of traffic. It also holds a one-way fingerprint of the room key, which lets it tell a joiner their key is wrong without being any closer to holding the key. It holds the hash of the room's erase token from creation, and the token itself once someone has deleted a clip with it; the token is a separate one-way derivation from the key, so it authorises deleting and nothing else. It does **not** hold clip text, device names, file names, file sizes, or SDP. A device's name, and the mark a browser attaches to its own clips to recognise them later, travel only sealed with the room key; the server sees that a clip carries metadata and how large it is, and nothing of what it says.

**The QR code carries the key, and is drawn locally.** It used to be fetched from a third-party service with the URL in a query string, which would have handed that service the key. The symbol is now encoded in the browser and drawn as an SVG, so nothing leaves the device to produce it and scanning opens the room in one step. When link and key should travel separately, "copy link without key" splits them.

**Encryption is confidentiality and integrity, not a transcript.** Each message is independently sealed. Replay and reordering of signaling messages by a malicious server are not prevented. Clip IDs are server-assigned.

**A lost key is a lost private room.** There is no recovery, by design — nobody who could perform one exists. A room joined without its key opens in a locked state: clips arrive and are visibly unreadable, and sending is disabled until a key is supplied.

**Files are peer-to-peer and never stored.** File transfer runs over WebRTC data channels directly between browsers. The server relays signaling messages only — it never sees, buffers, or stores file bytes. A file offer exists only while the sender's tab is open. Note that WebRTC exposes peer IP addresses to the other party, as it does in any WebRTC application.

**Rate limiting fails open.** If Redis is unreachable, requests are allowed through rather than rejected. This is a deliberate availability choice for an ephemeral, low-stakes service. Limits are token buckets — a burst size and a refill rate — so capacity regenerates continuously rather than resetting on a clock boundary. Clips allow a burst of 60 per room per IP refilling at 1/second; room creation allows 10 refilling at 1 per 10 seconds.

## What we do want to hear about

- Cross-room data leakage — any way to read clips, files, or signaling from a room you do not have the code for
- Room code predictability beyond brute force against the rate limiter
- XSS, injection, or SSRF in the app or API routes
- Ways to bypass the rate limiter, or to make a room outlive its TTL
- Signaling-channel abuse: forging, replaying, or hijacking a peer's WebRTC negotiation
- Anything that turns the server into a relay for file bytes or arbitrary traffic
- Dependency vulnerabilities that are actually reachable from this code

## Supported versions

Only the latest `main` and the currently deployed version are supported. There are no backports.
