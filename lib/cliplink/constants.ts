/**
 * Limits that define the wire live in `@thebkht/cliplink`, because a browser
 * tab and a CLI on different builds must agree on them. What follows them here
 * are this deployment's own numbers — storage caps, rate limits, UI ceilings —
 * which can move without breaking anyone.
 */
export {
  MAX_CLIP_CHARS,
  MAX_CLIP_CIPHERTEXT_CHARS,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_ROOM_TTL_SECONDS,
  MAX_SIGNAL_BYTES,
  MIN_ROOM_TTL_SECONDS,
  MAX_DEVICE_NAME_CHARS,
  POLL_INTERVAL_MS,
  ROOM_CODE_LENGTH,
  ROOM_KEY_CHARS,
  ROOM_KEY_CHECK_CHARS,
  ROOM_TTL_SECONDS,
} from "@thebkht/cliplink";

export const MAX_ROOM_CLIPS = 50;
/**
 * The same as what the room stores: a reload restores the room's clips, and a
 * shorter list here would hide some of them for no reason the user could see.
 */
export const MAX_SESSION_HISTORY = MAX_ROOM_CLIPS;
/**
 * Rate limits, as a burst and a regeneration rate rather than a quota per
 * window. A window resets on the clock, so a caller can spend the whole
 * allowance at the end of one window and the whole of the next allowance a
 * second later — twice the intended rate, in two seconds, while never breaking
 * the stated limit. A bucket has no reset to wait for: capacity comes back
 * continuously, so the burst is bounded and so is the sustained rate.
 */
export const CLIP_RATE_LIMIT = {
  /** A full bucket, and so the largest burst a single caller can spend. */
  burst: 60,
  refillTokens: 1,
  refillSeconds: 1,
} as const;

/** Deleting is rarer than sending, and a burst of it is a room being cleared. */
export const ERASE_RATE_LIMIT = {
  burst: 30,
  refillTokens: 1,
  refillSeconds: 2,
} as const;

/** Tighter: creating rooms is cheap for the caller and costs the server a key. */
export const ROOM_CREATE_RATE_LIMIT = {
  burst: 10,
  refillTokens: 1,
  refillSeconds: 10,
} as const;

// Peer-to-peer file transfer. Files never touch the server; only signaling does.
// Chunking, buffer, and stall tuning live in @thebkht/rtc-file-transfer.
/**
 * Files in one share. Each is its own offer signal, and a late joiner's hello
 * is answered with all of them, so this keeps a full folder well inside
 * SIGNAL_RATE_MAX_MESSAGES.
 */
export const MAX_FILES_PER_SHARE = 50;
/** File rows a receiver keeps before evicting idle ones, so two full shares fit. */
export const MAX_FILE_ITEMS = 100;
/**
 * Largest group that can be downloaded as one zip. Every file is held in memory
 * until the archive is saved, so this is bounded by what a phone can hold, well
 * below ZIP's own 4 GiB limit.
 */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
/**
 * Downloads this large stream to disk: a picked file in Chromium, the private
 * file system elsewhere.
 */
export const DISK_SINK_MIN_BYTES = 64 * 1024 * 1024;
/**
 * How much this device keeps of files it has received so it can pass them on
 * to the rest of the room. Oldest first is evicted past this, and files of a
 * room no tab is in are swept on joining and on leaving — so this is a
 * ceiling, not a quota the app tries to fill.
 *
 * Bounded again by the origin's own quota at sweep time: a phone with little
 * free space keeps less than a laptop with plenty.
 */
export const SEED_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
export const SIGNAL_RATE_WINDOW_MS = 10_000;
export const SIGNAL_RATE_MAX_MESSAGES = 200;
