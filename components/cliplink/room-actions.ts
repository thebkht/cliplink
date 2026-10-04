import { parseChord, type Chord } from "@/lib/cliplink/shortcuts";

export type ActionGroup = "Clip" | "Room" | "Files" | "View";

export type RoomAction = {
  id: string;
  label: string;
  group: ActionGroup;
  chord?: Chord;
  /** Additional chords that run the same action but are not the one displayed. */
  aliases?: Chord[];
  /** Extra terms the palette matches on, beyond the label. */
  keywords?: string[];
  enabled: boolean;
  /**
   * Whether the chord still fires while a text field has focus. True for
   * modifier chords, false for bare letters — otherwise typing "e" into the
   * compose box would trip a shortcut.
   */
  allowInEditor?: boolean;
  /**
   * The chord is documented but not bound globally, because the element that
   * owns it already handles the key. `Enter` belongs to the textarea.
   */
  handledLocally?: boolean;
  perform: () => void;
};

export type RoomActionContext = {
  /** Every action but the help sheet needs a room to act on. */
  joined: boolean;
  realtimeReady: boolean;
  hasText: boolean;
  /** Text present, within the length cap, and therefore actually sendable. */
  canSend: boolean;
  hasUndo: boolean;
  hasIncoming: boolean;
  /** There is history, and this room lets it be deleted. */
  canClearHistory: boolean;
  clearHistory: () => void;
  send: () => void;
  copyRoomLink: () => void;
  copyRoomKey: () => void;
  copyRoomLinkWithoutKey: () => void;
  /** False for an open room, whose key is derived and so not worth copying. */
  hasRoomKey: boolean;
  /** Joined but unreadable: the room needs a key this device does not have. */
  locked: boolean;
  enterRoomKey: () => void;
  shareRoom: () => void;
  openQr: () => void;
  openDevices: () => void;
  leave: () => void;
  attach: () => void;
  attachFolder: () => void;
  pasteFromDevice: () => void;
  clearEditor: () => void;
  undoClear: () => void;
  copyLatestIncoming: () => void;
  focusEditor: () => void;
  toggleTheme: () => void;
  /** Whether this device is told about clips that arrive in a hidden tab. */
  notificationsOn: boolean;
  toggleNotifications: () => void;
  openShortcuts: () => void;
  openPalette: () => void;
};

/**
 * Every keyboard-reachable room action, in one list.
 *
 * The shortcut listener, the `?` help sheet and the `⌘K` palette all render
 * from this — adding an action here makes it bindable, documented and
 * searchable at once, with no third place to forget.
 *
 * Bindings avoid keys the browser has claimed. Notably there is no `Mod+L`
 * (address bar) and no `Mod+Z` — the compose box has native undo, and taking
 * that over is worse than the feature is worth.
 */
export function createRoomActions(ctx: RoomActionContext): RoomAction[] {
  return [
    {
      id: "send",
      label: "Send clip",
      group: "Clip",
      chord: parseChord("Enter"),
      keywords: ["submit", "share text"],
      enabled: ctx.joined && ctx.canSend,
      allowInEditor: true,
      handledLocally: true,
      perform: ctx.send,
    },
    {
      id: "copy-incoming",
      label: "Copy latest received clip",
      group: "Clip",
      chord: parseChord("mod+shift+c"),
      keywords: ["clipboard", "incoming"],
      enabled: ctx.joined && ctx.hasIncoming,
      allowInEditor: true,
      perform: ctx.copyLatestIncoming,
    },
    {
      id: "paste",
      label: "Paste from device",
      group: "Clip",
      chord: parseChord("mod+shift+v"),
      keywords: ["clipboard", "read"],
      enabled: ctx.joined,
      allowInEditor: true,
      perform: ctx.pasteFromDevice,
    },
    {
      id: "clear",
      label: "Clear the editor",
      group: "Clip",
      chord: parseChord("mod+shift+Backspace"),
      keywords: ["empty", "delete text"],
      enabled: ctx.joined && ctx.hasText,
      allowInEditor: true,
      perform: ctx.clearEditor,
    },
    {
      id: "undo-clear",
      label: "Undo clear",
      group: "Clip",
      keywords: ["restore", "back"],
      enabled: ctx.joined && ctx.hasUndo,
      perform: ctx.undoClear,
    },
    {
      id: "clear-history",
      label: "Clear history for everyone",
      group: "Clip",
      keywords: ["delete", "remove", "wipe", "erase", "all clips"],
      enabled: ctx.joined && ctx.canClearHistory,
      perform: ctx.clearHistory,
    },
    {
      id: "focus-editor",
      label: "Focus the editor",
      group: "Clip",
      chord: parseChord("e"),
      aliases: [parseChord("/")],
      keywords: ["type", "compose", "write", "slash"],
      enabled: ctx.joined,
      perform: ctx.focusEditor,
    },

    {
      id: "copy-link",
      label: "Copy room link",
      group: "Room",
      chord: parseChord("l"),
      keywords: ["invite", "url", "share"],
      enabled: ctx.joined,
      perform: ctx.copyRoomLink,
    },
    {
      id: "copy-link-no-key",
      label: "Copy link without key",
      group: "Room",
      keywords: ["invite", "url", "safer", "separate", "channel"],
      enabled: ctx.joined && ctx.hasRoomKey,
      perform: ctx.copyRoomLinkWithoutKey,
    },
    {
      id: "copy-key",
      label: "Copy room key",
      group: "Room",
      keywords: ["encryption", "secret", "unlock", "password"],
      enabled: ctx.joined && ctx.hasRoomKey,
      perform: ctx.copyRoomKey,
    },
    {
      id: "enter-key",
      label: "Enter room key",
      group: "Room",
      keywords: ["unlock", "decrypt", "password", "locked"],
      enabled: ctx.locked,
      perform: ctx.enterRoomKey,
    },
    {
      id: "share",
      label: "Share room link",
      group: "Room",
      keywords: ["invite", "send to"],
      enabled: ctx.joined,
      perform: ctx.shareRoom,
    },
    {
      id: "qr",
      label: "Show QR code",
      group: "Room",
      chord: parseChord("q"),
      keywords: ["scan", "phone", "camera"],
      enabled: ctx.joined,
      perform: ctx.openQr,
    },
    {
      id: "devices",
      label: "Devices in this room",
      group: "Room",
      chord: parseChord("d"),
      keywords: ["name", "rename", "who", "presence", "peers"],
      enabled: ctx.joined,
      perform: ctx.openDevices,
    },
    {
      id: "leave",
      label: "Leave room",
      group: "Room",
      chord: parseChord("x"),
      keywords: ["exit", "quit", "close"],
      enabled: ctx.joined,
      perform: ctx.leave,
    },

    {
      id: "attach",
      label: "Attach files",
      group: "Files",
      chord: parseChord("a"),
      keywords: ["upload", "send file", "peer to peer"],
      enabled: ctx.joined && ctx.realtimeReady,
      perform: ctx.attach,
    },
    {
      id: "attach-folder",
      label: "Attach folder",
      group: "Files",
      chord: parseChord("f"),
      keywords: ["directory", "upload", "send folder", "peer to peer"],
      enabled: ctx.joined && ctx.realtimeReady,
      perform: ctx.attachFolder,
    },

    {
      id: "theme",
      label: "Toggle theme",
      group: "View",
      chord: parseChord("t"),
      keywords: ["dark", "light", "appearance"],
      enabled: true,
      perform: ctx.toggleTheme,
    },
    {
      id: "notifications",
      label: ctx.notificationsOn
        ? "Turn off notifications"
        : "Turn on notifications",
      group: "View",
      chord: parseChord("n"),
      keywords: ["notify", "alert", "background", "hidden tab", "badge"],
      enabled: ctx.joined,
      perform: ctx.toggleNotifications,
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      group: "View",
      chord: parseChord("?"),
      keywords: ["help", "keys", "cheatsheet"],
      enabled: ctx.joined,
      perform: ctx.openShortcuts,
    },
    {
      id: "palette",
      label: "Command palette",
      group: "View",
      chord: parseChord("mod+k"),
      keywords: ["search", "actions", "run"],
      enabled: ctx.joined,
      allowInEditor: true,
      perform: ctx.openPalette,
    },
  ];
}

/**
 * Bindings that are not single actions, listed in the help sheet so they are
 * discoverable even though the palette cannot run them.
 */
export const AMBIENT_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["1", "–", "9"], label: "Copy that history row" },
  { keys: ["/"], label: "Focus the editor" },
  { keys: ["Esc"], label: "Close, cancel, or leave the editor" },
  { keys: ["⇧", "↩"], label: "New line instead of sending" },
];
