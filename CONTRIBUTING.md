# Contributing to CLIPLINK

Thanks for taking the time. CLIPLINK is a small project, so the process is light.

## Before you start

For anything beyond a bug fix or a typo, **open an issue first**. CLIPLINK is deliberately narrow in scope — zero auth, ephemeral, no accounts, no persistence — and a quick conversation saves you writing code that does not fit that shape.

Explicit non-goals: user accounts, persistent history across sessions, server-side file storage, and native mobile apps.

## Setup

Requires **Node.js >= 20.9** and **pnpm** (see [`.nvmrc`](.nvmrc); `corepack enable` gets you the right pnpm).

```bash
pnpm install
pnpm dev
```

No Redis, no Vercel account, no environment file. Without credentials the app uses an in-memory store (`lib/cliplink/storage.ts`) and a process-local event bus (`lib/cliplink/pubsub.ts`). That covers most development.

You need real Upstash credentials only when your change touches cross-instance behavior — pub/sub fan-out or atomic rate limiting. Copy `.env.example` to `.env.local` and fill it in.

## Before you push

CI runs exactly these, so run them locally first:

```bash
pnpm -F @thebkht/rtc-file-transfer test
pnpm -F @thebkht/rtc-file-transfer build
pnpm -F @thebkht/cliplink test
pnpm -F @thebkht/cliplink build
pnpm lint
pnpm type-check
pnpm build
```

The packages are tested and built first, and on their own: they are published, and a tarball must not depend on the app compiling. Running them needs Node 22, which is what `.nvmrc` pins.

Both workspace packages have test suites. The app itself has **no test suite yet** — adding one is on the roadmap and PRs that start it are very welcome. In the meantime, describe how you verified your change by hand.

**New behaviour in `packages/` comes with tests.** A change that adds to or alters what a package does adds or updates a test in that package's `test/` directory, and a bug fix adds the test that would have caught it. Changes to the app, until it has a suite, describe their manual verification instead.

## Manual verification

Most of CLIPLINK is about two devices talking, so most changes need two clients. Two browser tabs work for text sync; two separate browsers (or a phone on the same network) are better for file transfer.

Worth checking depending on what you touched:

- **Transport changes** — verify both paths. Kill the WebSocket (offline the network briefly in DevTools) and confirm the room degrades to polling and recovers.
- **File transfer** — file transfer requires the WebSocket transport; Attach and Download are disabled on the polling fallback. Test an offer, a download, a withdrawal, and a late joiner seeing an open offer.
- **Room lifecycle** — TTL is refreshed on write, not on read. A passively polling tab must not keep a room alive forever.

## The file-transfer package

`packages/rtc-file-transfer` is published to npm as `@thebkht/rtc-file-transfer`, so two rules bind it that don't bind the app:

- **No runtime dependencies, and nothing cliplink-specific.** No env vars, no room concepts, no toast copy. If a change needs something from the app, the app passes it in.
- **Wire protocol v1 is permanent.** Every version has to interoperate with every other, in both directions. `test/manager.test.ts` pins that with a pair of tests against a manager created as `capabilities: []`, which is what a 0.1.0 peer looks like on the wire. Keep them passing.

Adding a protocol feature therefore looks like this:

1. Add a name to `Capability` in `src/protocol.ts`. Senders advertise it in `file-offer.caps` and receivers in `file-request.caps`; the feature runs only when it appears in both.
2. Carry anything new in optional fields, and validate them in `src/parse.ts`. `parseFileSignal` rebuilds signals from known fields only, so a peer that doesn't know a field drops it — which is exactly how old peers stay compatible.
3. Never change what an existing field means, and never make one required.
4. Cover the mixed pairing: the new feature on one side and not the other has to degrade, not fail.

The package's public API follows semver, so renaming an export or an option is a major. New failure codes and new `FileItem` fields are minors.

`packages/cliplink` — the room protocol — is bound the same way, with one difference: there is no capability handshake, because a room is not a pair of peers. A tab loaded before a deploy, a CLI installed last month and a server instance still running the previous build all share a room with the newest client. Adding to the protocol looks like this:

1. New fields are optional, on requests and responses both. An absent field means "this side predates it", which is not the same as zero or false — a poll with no `eraseGen` says nothing about deletions.
2. A new socket frame or sealed signal gets a new `type`. Old clients drop types they do not know; a new meaning for an existing type reaches them as the old one.
3. Server-to-server messages get a new pub/sub channel. The clip channel carries a bare clip, and an instance from before your change relays whatever it finds there as one.
4. Anything a client learns from the server about another client is sealed, or it is not sent. Seal it under its own HKDF subkey and bind it to what it describes, as `sealClipMeta` does, so it cannot be moved somewhere else.
5. The pinned vectors in `test/crypto.test.ts` are never updated, only added to.
6. Cover the mixed pairing here too: it has to degrade, not fail.

## Code style

- TypeScript throughout; no new `any`.
- Tailwind utility classes for styling — canonical class names, no arbitrary values where a token exists.
- Shared logic belongs in `lib/cliplink/`, UI in `components/`, routes in `app/`.
- Match the surrounding code. The codebase has a consistent voice; follow it rather than introducing a new one.

## Commits and pull requests

- Imperative subject lines, matching the existing history: `Add QR code sharing`, not `added qr` or `feat: qr`. Run `git log --oneline` for the pattern.
- No `Co-Authored-By` trailers.
- One logical change per PR. Keep refactors separate from behavior changes.
- In the PR description: what changed, why, and how you verified it. Link the issue if there is one.

## Project layout

```
app/              Routes and API handlers (App Router)
  rooms/          Room creation, fetch, clips, WebSocket upgrade
components/       React components
  cliplink/       File transfer UI and hooks
lib/cliplink/     Storage, transports, pub/sub, validation, WebRTC
```

There is no `src/` directory.
