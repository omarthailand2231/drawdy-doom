/**
 * Two ways in.
 *
 * **The board.** `subscription:keyboard:control-keys` is the only keyboard a
 * driver gets, and it reports exactly eleven keys — no letters, no digits —
 * with modifier flags, and it never reports a key *release*. So the whole
 * control scheme has to be expressed in arrows plus modifiers, and holds have
 * to be synthesised: a press is held for a while and refreshed by the OS's own
 * key repeat (see `input.ts`).
 *
 * **The console webview.** A webview is a real document, so it sees genuine
 * keydown/keyup for every key. When it has focus you get vanilla DOOM controls
 * including weapon digits. It sends symbolic names, never raw numbers — the
 * numeric key values live in the wasm module and are resolved here.
 */
import type { ControlKey } from "@drawdy/driver-protocol";
import type { DoomKeys } from "./engine";

export type KeyName = keyof DoomKeys;

const KEY_NAMES = new Set<string>([
    "LEFTARROW", "RIGHTARROW", "UPARROW", "DOWNARROW", "STRAFE_L", "STRAFE_R",
    "FIRE", "USE", "SHIFT", "TAB", "ESCAPE", "ENTER", "BACKSPACE", "ALT",
]);

export function isKeyName(value: unknown): value is KeyName {
    return typeof value === "string" && KEY_NAMES.has(value);
}

/** DOOM takes printable keys as their ASCII code — that is how 1..7 pick weapons. */
export function asciiKey(character: string): number | null {
    if (character.length !== 1) return null;
    const code = character.toLowerCase().charCodeAt(0);
    return code >= 0 && code <= 255 ? code : null;
}

export const WEAPON_SLOTS = [
    { slot: 1, label: "Fist / Chainsaw" },
    { slot: 2, label: "Pistol" },
    { slot: 3, label: "Shotgun" },
    { slot: 4, label: "Chaingun" },
    { slot: 5, label: "Rocket launcher" },
    { slot: 6, label: "Plasma rifle" },
    { slot: 7, label: "BFG 9000" },
] as const;

export interface ControlKeyEvent {
    key: ControlKey;
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
}

export interface Binding {
    /** Keys to hold for this press. */
    keys: KeyName[];
    /** Bump the weapon selection by this much instead of holding a key. */
    weaponStep?: number;
    /** Human-readable, for the console's control list. */
    describe: string;
}

/**
 * Resolve one control-key event into what DOOM should see.
 *
 * `alt` is not translated into strafe keys — DOOM's own KEY_ALT already means
 * "strafe instead of turn", so holding it does the right thing to the arrows.
 * `enter` sends USE alongside ENTER: in a menu the ENTER selects and the USE is
 * inert, in the game the USE opens the door and the ENTER is inert, so one key
 * covers both without the player having to think about which mode they are in.
 */
export function bindControlKey(event: ControlKeyEvent): Binding | null {
    const { key, ctrl, alt, shift } = event;

    if (ctrl && (key === "arrow-up" || key === "arrow-down")) {
        return { keys: [], weaponStep: key === "arrow-up" ? 1 : -1, describe: "next / previous weapon" };
    }

    const held: KeyName[] = [];
    if (shift) held.push("SHIFT");
    if (alt) held.push("ALT");

    switch (key) {
        case "arrow-up":
            return { keys: [...held, "UPARROW"], describe: "walk forward" };
        case "arrow-down":
            return { keys: [...held, "DOWNARROW"], describe: "walk back" };
        case "arrow-left":
            return { keys: [...held, "LEFTARROW"], describe: alt ? "strafe left" : "turn left" };
        case "arrow-right":
            return { keys: [...held, "RIGHTARROW"], describe: alt ? "strafe right" : "turn right" };
        case "space":
            return shift
                ? { keys: [...held, "USE"], describe: "use / open" }
                : { keys: [...held, "FIRE"], describe: "fire" };
        case "enter":
            return { keys: [...held, "ENTER", "USE"], describe: "confirm / use" };
        case "escape":
            return { keys: ["ESCAPE"], describe: "menu" };
        case "tab":
            return { keys: ["TAB"], describe: "automap" };
        case "backspace":
        case "delete":
            return { keys: ["BACKSPACE"], describe: "back" };
        case "shift":
            return { keys: ["SHIFT"], describe: "run" };
        default:
            return null;
    }
}

/** The scheme, for the console and the README. */
export const CONTROL_SCHEME: readonly { keys: string; action: string }[] = [
    { keys: "↑ ↓", action: "Walk forward / back" },
    { keys: "← →", action: "Turn" },
    { keys: "Alt + ← →", action: "Strafe" },
    { keys: "Shift", action: "Run" },
    { keys: "Space", action: "Fire" },
    { keys: "Shift + Space", action: "Use / open doors" },
    { keys: "Enter", action: "Confirm in menus, use in game" },
    { keys: "Ctrl + ↑ ↓", action: "Cycle weapons" },
    { keys: "Tab", action: "Automap" },
    { keys: "Esc", action: "DOOM menu" },
    { keys: "Backspace", action: "Back" },
];
