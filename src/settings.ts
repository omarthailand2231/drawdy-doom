/** Per-device driver settings, kept in `kv-storage` so a board remembers your setup. */
import { call } from "./protocol";
import { DEFAULT_HOLD_TIMINGS } from "./input";
import type { ImageFormat } from "./render/image-screen";
import type { Rect, ResolutionId, ScreenStyle } from "./render/screen";

const KEY = "doom.settings";

export type DisplayMode = "image" | "shapes";

export interface DoomSettings {
    /**
     * `image`  one preview component per frame, DOOM at its native 640x400.
     * `shapes` one canvas rectangle per cell — lower resolution, but pure
     *          Drawdy elements, and the fallback when a browser has no
     *          OffscreenCanvas in workers.
     */
    displayMode: DisplayMode;
    imageFormat: ImageFormat;
    imageQuality: number;
    resolution: ResolutionId;
    colorBits: number;
    samples: number;
    style: ScreenStyle;
    holdFirstMs: number;
    holdRepeatMs: number;
    /** Where the screen was last placed, in canvas coordinates. */
    screen: Rect | null;
    /** Steer by moving the pointer across the screen. */
    mouseLook: boolean;
    /** Drop resolution automatically when frames cannot keep up. */
    autoQuality: boolean;
}

export const DEFAULT_SETTINGS: DoomSettings = {
    displayMode: "image",
    imageFormat: "image/webp",
    imageQuality: 0.82,
    resolution: "large",
    colorBits: 5,
    samples: 2,
    style: "pixel",
    holdFirstMs: DEFAULT_HOLD_TIMINGS.firstMs,
    holdRepeatMs: DEFAULT_HOLD_TIMINGS.repeatMs,
    screen: null,
    mouseLook: false,
    autoQuality: true,
};

const isRect = (value: unknown): value is Rect =>
    !!value &&
    typeof value === "object" &&
    ["x", "y", "width", "height"].every((k) => typeof (value as Record<string, unknown>)[k] === "number");

export async function loadSettings(): Promise<DoomSettings> {
    const outcome = await call("command:kv-storage:get", { key: KEY });
    if (outcome.error || !outcome.value?.got) return { ...DEFAULT_SETTINGS };
    const stored = outcome.value.got as Partial<DoomSettings>;
    return {
        ...DEFAULT_SETTINGS,
        ...stored,
        screen: isRect(stored.screen) ? stored.screen : null,
    };
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Debounced — settings change in bursts while a slider moves. */
export function saveSettings(settings: DoomSettings): void {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
        pending = null;
        void call("command:kv-storage:set", { key: KEY, payload: { ...settings } });
    }, 400);
}
