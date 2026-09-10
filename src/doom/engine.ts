/**
 * The DOOM engine, hosted.
 *
 * `doom.wasm` is the original id Software DOOM sources (through doomgeneric)
 * compiled to one freestanding WebAssembly module. It touches no DOM and no
 * WASI, so it runs happily inside Drawdy's shared driver worker. Its whole
 * contract is:
 *
 *   exports   initGame() · tickGame() · reportKeyDown(k) · reportKeyUp(k)
 *             memory · KEY_* globals
 *   imports   loading.onGameInit/wadSizes/readWads · ui.drawFrame
 *             runtimeControl.timeInMilliseconds · console.on{Info,Error}Message
 *             gameSaving.sizeOfSaveGame/readSaveGame/writeSaveGame
 *
 * Two things need care.
 *
 * 1. Time. `tickGame` busy-waits inside the wasm until `timeInMilliseconds`
 *    reports that a new game tic is due. Handing it the real clock would spin
 *    the shared worker. Instead the clock is virtual: it jumps forward exactly
 *    one tic before each `tickGame`, so the wait is already satisfied and
 *    returns immediately. Every query also nudges the clock a hair so that any
 *    wait we did not anticipate still terminates, and a query counter aborts a
 *    runaway rather than wedging the worker other drivers share.
 *
 * 2. Pace. Game speed must follow the wall clock even when frames are
 *    expensive, so {@link DoomEngine.advance} converts real elapsed time into
 *    whole tics and runs up to a few of them per call.
 */

/** DOOM runs its simulation at 35 tics per second. */
export const TICRATE = 35;
export const MS_PER_TIC = 1000 / TICRATE;

/** Never run more than this many tics in one `advance` — no death spirals. */
const MAX_CATCHUP_TICS = 3;
/** Debt beyond this (the tab was backgrounded, say) is forgiven, not repaid. */
const MAX_DEBT_MS = MS_PER_TIC * 12;
/** Each clock query slides the virtual clock forward by this much. */
const CLOCK_NUDGE_MS = 1 / 64;
/** A single tic asking for more clock than this is wedged; unwind instead. */
const MAX_CLOCK_QUERIES_PER_TIC = 400_000;

export interface SaveStore {
    /** Bytes held for this slot, 0 when empty. */
    size(id: number): number;
    /** Copy the slot into `into`; returns bytes written. */
    read(id: number, into: Uint8Array): number;
    /** Persist the slot; returns bytes accepted (0 = saving unsupported). */
    write(id: number, data: Uint8Array): number;
}

export interface DoomEngineHooks {
    /** A finished frame, BGRA, `width * height * 4` bytes, borrowed — copy if you keep it. */
    onFrame(pixels: Uint8Array, width: number, height: number): void;
    onLog?(level: "info" | "error", message: string): void;
    saves?: SaveStore;
}

export interface DoomKeys {
    LEFTARROW: number;
    RIGHTARROW: number;
    UPARROW: number;
    DOWNARROW: number;
    STRAFE_L: number;
    STRAFE_R: number;
    FIRE: number;
    USE: number;
    SHIFT: number;
    TAB: number;
    ESCAPE: number;
    ENTER: number;
    BACKSPACE: number;
    ALT: number;
}

const KEY_NAMES: readonly (keyof DoomKeys)[] = [
    "LEFTARROW", "RIGHTARROW", "UPARROW", "DOWNARROW", "STRAFE_L", "STRAFE_R",
    "FIRE", "USE", "SHIFT", "TAB", "ESCAPE", "ENTER", "BACKSPACE", "ALT",
];

interface DoomExports {
    memory: WebAssembly.Memory;
    initGame(): void;
    tickGame(): void;
    reportKeyDown(key: number): void;
    reportKeyUp(key: number): void;
    [key: string]: unknown;
}

class ClockRunaway extends Error {}

export class DoomEngine {
    /** Frame buffer size DOOM reported at init (640x400 for this build). */
    width = 0;
    height = 0;
    /** Tics simulated since `start`. */
    tics = 0;
    /** Frames DOOM has drawn since `start`. */
    frames = 0;
    /** Set when a tic wedged or trapped; the engine is done. */
    crashed: string | null = null;

    private readonly exports: DoomExports;
    private readonly hooks: DoomEngineHooks;
    private readonly wads: Uint8Array[];
    private readonly held = new Set<number>();

    private clockMs = 0;
    private clockTargetMs = 0;
    private clockQueries = 0;
    private debtMs = 0;
    private lastRealMs: number | null = null;
    private started = false;

    readonly keys: DoomKeys;

    private constructor(exports: DoomExports, hooks: DoomEngineHooks, wads: Uint8Array[]) {
        this.exports = exports;
        this.hooks = hooks;
        this.wads = wads;
        const keys = {} as DoomKeys;
        for (const name of KEY_NAMES) {
            keys[name] = (exports[`KEY_${name}`] as WebAssembly.Global | undefined)?.value ?? 0;
        }
        this.keys = keys;
    }

    /**
     * Compile once, instantiate as often as you like — swapping WADs means a
     * fresh instance, and re-compiling 4.5 MB of wasm each time is wasteful.
     */
    static compile(wasm: BufferSource): Promise<WebAssembly.Module> {
        return WebAssembly.compile(wasm);
    }

    static async instantiate(
        module: WebAssembly.Module,
        hooks: DoomEngineHooks,
        wads: Uint8Array[] = []
    ): Promise<DoomEngine> {
        let engine: DoomEngine | null = null;
        const decoder = new TextDecoder("utf-8", { fatal: false });

        const memory = (): WebAssembly.Memory => (engine as DoomEngine)["exports"].memory;
        const u8 = (): Uint8Array => new Uint8Array(memory().buffer);
        const i32 = (): Int32Array => new Int32Array(memory().buffer);
        const text = (pointer: number, length: number): string =>
            decoder.decode(u8().subarray(pointer, pointer + length));

        const imports: WebAssembly.Imports = {
            loading: {
                onGameInit: (width: number, height: number) => {
                    const self = engine as DoomEngine;
                    self.width = width;
                    self.height = height;
                },
                wadSizes: (countPointer: number, totalBytesPointer: number) => {
                    const self = engine as DoomEngine;
                    if (self.wads.length === 0) return; // leave 0 -> embedded shareware WAD
                    const view = i32();
                    view[countPointer >> 2] = self.wads.length;
                    view[totalBytesPointer >> 2] = self.wads.reduce((n, w) => n + w.length, 0);
                },
                readWads: (dataPointer: number, lengthsPointer: number) => {
                    const self = engine as DoomEngine;
                    const bytes = u8();
                    const lengths = i32();
                    let cursor = dataPointer;
                    self.wads.forEach((wad, index) => {
                        bytes.set(wad, cursor);
                        cursor += wad.length;
                        lengths[(lengthsPointer >> 2) + index] = wad.length;
                    });
                },
            },
            ui: {
                drawFrame: (pointer: number) => {
                    const self = engine as DoomEngine;
                    self.frames++;
                    const size = self.width * self.height * 4;
                    self.hooks.onFrame(u8().subarray(pointer, pointer + size), self.width, self.height);
                },
            },
            runtimeControl: {
                timeInMilliseconds: (): bigint => {
                    const self = engine as DoomEngine;
                    if (++self.clockQueries > MAX_CLOCK_QUERIES_PER_TIC) throw new ClockRunaway();
                    self.clockMs += CLOCK_NUDGE_MS;
                    return BigInt(Math.floor(self.clockMs));
                },
            },
            console: {
                onInfoMessage: (pointer: number, length: number) =>
                    (engine as DoomEngine).hooks.onLog?.("info", text(pointer, length)),
                onErrorMessage: (pointer: number, length: number) =>
                    (engine as DoomEngine).hooks.onLog?.("error", text(pointer, length)),
            },
            gameSaving: {
                sizeOfSaveGame: (id: number): number => hooks.saves?.size(id) ?? 0,
                readSaveGame: (id: number, destination: number): number => {
                    const store = hooks.saves;
                    if (!store) return 0;
                    const size = store.size(id);
                    if (size <= 0) return 0;
                    const scratch = new Uint8Array(size);
                    const written = store.read(id, scratch);
                    u8().set(scratch.subarray(0, written), destination);
                    return written;
                },
                writeSaveGame: (id: number, source: number, length: number): number => {
                    const store = hooks.saves;
                    if (!store) return 0;
                    return store.write(id, u8().slice(source, source + length));
                },
            },
        };

        const instance = await WebAssembly.instantiate(module, imports);
        engine = new DoomEngine(instance.exports as unknown as DoomExports, hooks, wads);
        return engine;
    }

    /** Boot DOOM. Safe to call once; later calls are ignored. */
    start(): void {
        if (this.started) return;
        this.started = true;
        this.clockQueries = 0;
        this.exports.initGame();
    }

    /** Run exactly one tic. Deterministic — used by the headless tests. */
    tick(): void {
        if (this.crashed) return;
        this.clockQueries = 0;
        this.clockTargetMs += MS_PER_TIC;
        if (this.clockMs < this.clockTargetMs) this.clockMs = this.clockTargetMs;
        try {
            this.exports.tickGame();
            this.tics++;
        } catch (cause) {
            this.crashed =
                cause instanceof ClockRunaway
                    ? "DOOM stopped asking for time to move forward (engine wedged)"
                    : cause instanceof Error
                      ? cause.message
                      : String(cause);
        }
    }

    /**
     * Convert real elapsed time into whole tics and run them, so the game keeps
     * wall-clock speed no matter how expensive drawing a frame turns out to be.
     * Returns how many tics actually ran.
     */
    advance(realNowMs: number): number {
        if (this.crashed) return 0;
        if (this.lastRealMs === null) {
            this.lastRealMs = realNowMs;
            this.debtMs = MS_PER_TIC;
        } else {
            this.debtMs += Math.max(0, realNowMs - this.lastRealMs);
            this.lastRealMs = realNowMs;
        }
        if (this.debtMs > MAX_DEBT_MS) this.debtMs = MS_PER_TIC;

        let ran = 0;
        while (this.debtMs >= MS_PER_TIC && ran < MAX_CATCHUP_TICS) {
            this.debtMs -= MS_PER_TIC;
            this.tick();
            ran++;
            if (this.crashed) break;
        }
        return ran;
    }

    /** Forget accumulated time debt — call after a pause so the game does not lurch. */
    resetPacing(): void {
        this.lastRealMs = null;
        this.debtMs = 0;
    }

    keyDown(key: number): void {
        if (this.crashed || key < 0 || key > 255) return;
        if (this.held.has(key)) return;
        this.held.add(key);
        this.exports.reportKeyDown(key);
    }

    keyUp(key: number): void {
        if (this.crashed || key < 0 || key > 255) return;
        if (!this.held.delete(key)) return;
        this.exports.reportKeyUp(key);
    }

    /** Let go of everything — used when input focus or the game itself goes away. */
    releaseAll(): void {
        for (const key of [...this.held]) this.keyUp(key);
    }

    isHeld(key: number): boolean {
        return this.held.has(key);
    }

    heldKeys(): number[] {
        return [...this.held];
    }
}
