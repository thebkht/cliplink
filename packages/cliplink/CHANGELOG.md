# Changelog

## 0.3.0

- **Clips say who sent them.** A clip may now carry `meta`: the sender's name and, from a browser, a mark by which that browser recognises the clip as its own, sealed under a new `cliplink:meta` subkey. The seal is bound to the clip's own text ciphertext as well as to the room, so the server can neither move one clip's attribution onto another nor offer a metadata ciphertext as a clip's text. `createEncryptedTransport` seals a `from` on the way out and opens it on the way in; a `from` or `meta` supplied from the other side of it is discarded, so the only sender a caller ever sees is one this package opened.
- **A `presence` signal.** `{ type: "presence", name, peer }`, sealed like every other signal, tells the room what a device is called. `peer` repeats the sender's id inside the seal and a signal whose `peer` is not the peer it came from is dropped, since the `from` beside a signal is the server's word.
- **`send --name <name>`.** The name a clip is shown under; the default is the machine's hostname. The CLI sends a name and no such mark — it keeps no identity between runs, and still does not.
- **`recv --json` gains `name`**, present when the clip says who sent it.
- **Clips can be deleted, by key holders only.** `RoomKey` gains `eraseToken`, a fourth HKDF output, and `eraseCheck`, its SHA-256. A room is created with the check (`createRoomRequest`'s new third argument) and `DELETE /rooms/:code/clips` must present the token, so the room code alone deletes nothing and the server stores nothing it could mint a token from. An open room's check is derived by the server from the code, as its key already can be. A room created without a check can never delete: there is no later moment at which one could safely be set.
- **`TransportClient.eraseClips`** takes `{ ids }` or `{ upTo }` and resolves with what was removed, and `streamClips` takes an `onRemoved` handler. A poll and a socket backlog can only add clips, so the server counts deletions (`eraseGen` on the room, the poll and the `ready` frame) and the encrypted transport compares: when the count is ahead it fetches the room, works out which clips it had handed over are gone, and reports them — as `removed` on a poll response, or through `onRemoved`. A clip whose removal arrives while it is still being decrypted is not delivered afterwards.
- A response with no JSON body — what a server from before a route existed sends — is reported as a refusal with its status, rather than as a JSON syntax error.
- `cliplink send` creates its room with an erase check, so clips in it can be deleted from a browser. The CLI itself does not delete yet.
- `normalizeDeviceName`, `parseClipMeta`, `validateClipMeta`, `sealClipMeta`, `openClipMeta`, `MAX_DEVICE_NAME_CHARS` and `MAX_CLIP_META_CHARS` are exported. `RoomKey` gains `metaKey`.

Wire changes, all additive: an optional sealed `meta` on a clip and on the clip `POST`; one new sealed signal type; an optional `eraseCheck` on room creation; a `DELETE` on the clips route; a `removed` socket frame; and an optional `eraseGen` on three responses. A client from before this release ignores all of it — it drops signal and frame types it does not know and never reads the new fields — so its own clips arrive unattributed and otherwise unchanged, a clip deleted elsewhere stays in its list until it reloads, and a room it creates cannot delete.

## 0.2.2

- **A room link with its key fragment written twice now opens the room.** The web app could leave `#k=…#k=…` in the address bar of a room opened by its link, and that address is what gets copied and passed on. `parseRoomKeyFromHash` handed the whole of it to `URLSearchParams`, which read the key as `KEY#k=KEY` — not a key, so the room opened locked in the app and `--room <url>` and `--key <url>` failed in the CLI. A key holds no `#`, so the fragment is now read only as far as a second one. The app no longer writes such links; this is for the ones already out.

No wire changes.

## 0.2.1

- **A saved room is now matched by its code and its server, not by the code alone.** A room code is six characters and unique only to the server that issued it, so the same code names different rooms on a dev server and on a deployment. `findSavedRoom` consulted only the code, so joining a code against one origin could be handed the key `--save` had written for another — which fails to decrypt, and is the wrong room's key besides. The origin was already recorded in `rooms.json`; it is now read. Saving matches the same way, so the same code can be held for two servers at once rather than one evicting the other. Trailing slashes, host case and a default port do not make two origins different; a path does. `rooms --forget` still takes a code alone, and so now forgets it on every server it was saved against, rather than the first one found.

## 0.2.0

- **`cliplink rooms`.** `--save` could write to the saved-rooms file but nothing could read it back, so seeing what a machine had kept, or removing one entry, meant opening `rooms.json` by hand. `rooms` lists code, origin and age; `--forget` takes one, `--forget-all` takes them all, and `--prune` drops what has expired. The listing withholds keys unless `--show-keys` asks — keeping keys scarce is the whole reason `--save` is opt-in per run, and a command run to remind yourself of a room code should not put key material into scrollback or a screen share. It says on stderr that it is withholding, so the omission cannot be read as the room having no key. Forgetting every room removes the file rather than leaving an empty one behind.
- **`cliplink link`.** The share link and QR were printed only when `send` created a room, so getting a second device onto a room already in progress meant scrolling back to find them. `link` resolves a room exactly as `send` and `recv` do and prints what they print. It opens no socket and asks the server nothing — the code and the key are both in hand once the session resolves — so it answers for a room that has already expired. It never creates a room: minting one just to print its link would leave a room on the server nobody asked for.
- **`recv --json`.** Every clip was decrypted and all of it but the text thrown away, so a script could read what was said but not who said it, when, or which clip it was. `--json` prints one object per line: `id`, `text`, `senderId`, `ts`. The fields are listed rather than the clip stringified whole, so a field added to the wire type does not appear in the output format without someone deciding it should.
- **`recv --last <n>` and `--all`.** `recv` always started at the newest clip, so anything sent before it was running was unreachable from the terminal. The clips are in the connect response either way, so this is a choice of where the cursor starts rather than a new request. Replayed clips take the same path as one arriving later, so `--one` and `--json` mean the same thing for both, and the shared cursor still refuses to print a clip twice.
- **`recv --timeout <secs>`.** `recv --one` waited forever, so a script that expected a clip and did not get one hung rather than failing. It exits 1 when nothing arrived and 0 when something did: nothing arriving writes nothing to stdout, and an empty clip and a clip that never came look alike to a caller that only reads the pipe.
- **`NO_COLOR` and `--no-color`.** `renderQr` has taken a `color` option since it was written and no caller ever passed one. Colour stays the default because it is what makes the QR scannable — block characters are drawn in the foreground colour, so on a dark terminal an unstyled QR comes out inverted and many scanners refuse it.
- **Clustered short flags.** `-q1` was an unknown option. Only a run whose every letter is a known short flag is expanded, so `-50` and `-kSECRET` still reach the unknown-option error rather than being taken apart into letters; a flag that takes a value has to come last.
- A failing poll is reported once per run of failures rather than once per poll. A server that is down stays down, and a line every 1.5 seconds for as long as that lasts buried both the clips already received and the first line that said why. Reaching the room again is noted, so a failure that comes and goes is still visible.
- A room saved by `--save` on creation now records when it expires, which is what `--prune` reads. A room saved on a join was never told its lifetime, so it falls back to the longest a room may be configured to live — a bound rather than a reading.

No wire changes. The protocol, the encryption and both transports are untouched.

## 0.1.1

- **Room codes now come from the CSPRNG.** `generateRoomCode` drew from `Math.random`, whose output is predictable from a handful of earlier draws. A room code is the room's only identifier, and for a room opened by its code alone it is the whole of the key material, since `deriveOpenRoomKey` takes nothing else. The format is unchanged, so this is not a wire change and existing codes still resolve.
- `--ttl` is checked against the 3600–86400 the help text advertises before the request goes out, through the `validateRoomTtl` the server already uses. `--ttl` alongside a room named by `CLIPLINK_ROOM` now says so, rather than reporting that "this run joins one" when the command line shows no room at all.
- `resolveBaseUrl` is exported, for anyone implementing `TransportClient` against a lazy origin.
- The package ships its own `LICENSE`. There was none, so the tarball carried no licence text and both `README.md` and `CLI.md` linked above the package root to a file that was not there.

## 0.1.0

First release. The CLIPLINK room protocol, extracted from the web app so the
app and the CLI share one implementation of the encryption rather than one
each.

- **The protocol.** End-to-end encryption (HKDF from the room key, AES-GCM per
  clip), the room wire types, room codes, QR encoding, and hand-written
  validation. Wire protocol v1 is fixed: a client on any version talks to a
  room served by any other, and the tests pin ciphertexts from earlier builds.
- **Both transports.** `createHttpClient` polls, `createWebSocketTransport`
  holds a socket open, and both implement `TransportClient`, so a client writes
  its retry and backoff logic once. Each takes its origin as a parameter —
  nothing here assumes a browser, and `window` appears nowhere in it.
- **The `cliplink` CLI**, shipped in this package as a `bin`. `cliplink send`
  creates a room and prints a link and QR code for the other device;
  `cliplink recv` prints clips as they arrive. Importing the library never
  loads it, so a browser bundle pays nothing for the CLI.
- Requires Node 22 or newer, and has no third-party dependencies. The CLI talks
  to a room over Node's own `WebSocket` global rather than carrying `ws`, and
  the library uses Web Crypto, which is global from the same versions.
