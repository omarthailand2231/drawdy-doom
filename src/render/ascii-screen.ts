/**
 * DOOM as text.
 *
 * The shape grid pays one canvas element per *pixel*. A `text` element holds a
 * whole string, so drawing each row of the picture as one line of characters
 * costs one element per *row* — 80 elements for an 80x50 display instead of
 * 4,000. Brightness is carried by which character is drawn rather than by
 * colour, which is what ASCII art has always done.
 *
 * Rows are positioned individually rather than newline-separated into a single
 * element, on purpose: line height is not something the protocol lets a driver
 * set, and placing each row puts vertical spacing back under our control.
 *
 * The one thing outside our control is the glyph advance — the protocol has no
 * font-family field. A proportional font would shear the picture, so the
 * default ramp is drawn from the Unicode block elements, whose glyphs come
 * from one font and share a width. `charAspect` tunes the rest to taste.
 */
import type { DrawdyPreviewElementSchema } from "@drawdy/driver-protocol";
import type { Rect } from "./screen";

export interface AsciiRamp {
    id: string;
    label: string;
    /** Darkest first, brightest last. */
    chars: string;
    /** Roughly how wide a glyph is relative to the font size. */
    advance: number;
}

export const ASCII_RAMPS: readonly AsciiRamp[] = [
    // Block elements share a font and a width, so they hold their columns.
    { id: "blocks", label: "Blocks  ░▒▓█", chars: " ░▒▓█", advance: 0.6 },
    { id: "blocks-solid", label: "Solid blocks  ▁▄█", chars: " ▁▂▃▄▅▆▇█", advance: 0.6 },
    { id: "classic", label: "Classic  .:-=+*#%@", chars: " .:-=+*#%@", advance: 0.55 },
    { id: "dense", label: "Dense 16-step", chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$", advance: 0.55 },
    { id: "digits", label: "Digits (tabular)", chars: " 1234567890", advance: 0.6 },
] as const;

export const AUTO_RAMP = "auto";

/**
 * Pick a ramp from what the font turned out to be.
 *
 * The ten-step ASCII ramp is far more legible, but its glyphs are only the
 * same width in a monospaced font — in a proportional one the picture shears.
 * Block elements come from a single fallback font and hold their columns, so
 * they are the safe choice when the font is not monospaced.
 */
export function resolveRamp(requested: string, monospaced: boolean | null): string {
    if (requested !== AUTO_RAMP) return requested;
    return monospaced ? "classic" : "blocks";
}

export interface AsciiOptions {
    cols: number;
    rows: number;
    ramp: string;
    /** Glyph cell width / height. Raise it if the picture looks squashed. */
    charAspect: number;
    /** Font size as a fraction of the row height. */
    fontScale: number;
    /**
     * Tone curve applied before picking a character. DOOM's frames sit dark,
     * so a straight mapping bunches almost everything onto the two faintest
     * glyphs; below 1 this opens the midtones out across the whole ramp.
     */
    gamma: number;
    /**
     * Pivots around mid-grey: above 1 pushes lights and darks apart, below 1
     * pulls them together. Gamma alone lifts everything, which brightens a
     * dark scene but does not make it any easier to read; contrast is what
     * separates a wall from the doorway in it.
     */
    contrast: number;
    color: string;
    /** Samples per cell axis when downscaling. */
    samples: number;
    /**
     * Drop the blank step from the ramp so the darkest level is still a drawn
     * glyph. A space leaves a hole in the picture; the faintest character
     * gives black some substance and the image reads as continuous.
     */
    fillDark: boolean;
    /**
     * Glyph width as a fraction of font size. Null means "use the ramp's
     * assumption"; {@link measureFont} replaces it with the real thing.
     */
    measuredAdvance: number | null;
}

export const DEFAULT_ASCII_OPTIONS: AsciiOptions = {
    cols: 160,
    rows: 60,
    ramp: "classic",
    charAspect: 0.5,
    fontScale: 0.95,
    gamma: 0.62,
    contrast: 1.35,
    color: "#e6e6e6",
    samples: 2,
    fillDark: true,
    measuredAdvance: null,
};

type TextElement = Extract<DrawdyPreviewElementSchema, { type: "text" }>;

/** How much wider than the text each row's box is made. */
const WIDTH_SLACK = 1.6;

export class AsciiScreen {
    readonly options: AsciiOptions;
    rect: Rect;

    private lines: TextElement[] = [];
    private previous: string[] = [];
    private readonly dirty: number[] = [];
    private dirtyFlags: Uint8Array = new Uint8Array(0);
    private taps = new Int32Array(0);
    private tapsKey = "";
    private readonly mintId: () => string;
    private readonly ids = new Set<string>();
    /** Reused scratch so building a row costs no garbage. */
    private scratch: string[] = [];

    constructor(rect: Rect, mintId: () => string, options: Partial<AsciiOptions> = {}) {
        this.options = { ...DEFAULT_ASCII_OPTIONS, ...options };
        this.mintId = mintId;
        this.rect = rect;
        this.rebuild();
    }

    get rampChars(): string {
        const chars = (ASCII_RAMPS.find((r) => r.id === this.options.ramp) ?? ASCII_RAMPS[0]!).chars;
        return this.options.fillDark ? chars.replace(/^ +/, "") : chars;
    }

    private get rampAdvance(): number {
        return (
            this.options.measuredAdvance ??
            (ASCII_RAMPS.find((r) => r.id === this.options.ramp) ?? ASCII_RAMPS[0]!).advance
        );
    }

    /** Rows that hold the picture's aspect for the advance actually in use. */
    rowsForAspect(cols: number, frameAspect: number): number {
        // A glyph cell is `advance` wide and one line tall, so the picture is
        // upright when cols * advance / rows == frameAspect.
        return Math.max(4, Math.round((cols * this.rampAdvance) / frameAspect));
    }

    /** One element per row — the whole point of this display. */
    get elements(): readonly TextElement[] {
        return this.lines;
    }

    get lineCount(): number {
        return this.options.rows;
    }

    get pendingLines(): number {
        return this.dirty.length;
    }

    owns(id: string): boolean {
        return this.ids.has(id);
    }

    setRect(rect: Rect): void {
        this.rect = rect;
        this.layout();
    }

    setOptions(next: Partial<AsciiOptions>): boolean {
        const before = JSON.stringify(this.options);
        Object.assign(this.options, next);
        if (JSON.stringify(this.options) === before) return false;
        this.rebuild();
        return true;
    }

    invalidate(): void {
        this.previous.fill("");
        for (let i = 0; i < this.options.rows; i++) {
            if (this.dirtyFlags[i]) continue;
            this.dirtyFlags[i] = 1;
            this.dirty.push(i);
        }
    }

    private rebuild(): void {
        const { rows, cols, color } = this.options;
        this.lines = new Array<TextElement>(rows);
        this.ids.clear();
        for (let row = 0; row < rows; row++) {
            const id = this.mintId();
            this.ids.add(id);
            this.lines[row] = {
                type: "text",
                drawdyElementId: id,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                text: "",
                fontSize: 12,
                color,
                // Both stated outright: an unstated width is a width the host
                // gets to choose, and a chosen one wraps the row.
                textAlign: "left",
            };
        }
        this.previous = new Array<string>(rows).fill("");
        this.dirtyFlags = new Uint8Array(rows);
        this.dirty.length = 0;
        this.scratch = new Array<string>(cols);
        this.tapsKey = "";
        this.layout();
    }

    /**
     * Choose the font size so a row of `cols` glyphs spans the screen, then
     * space the rows to match. The picture's own aspect is preserved by
     * `charAspect`, since a glyph is taller than it is wide.
     */
    private layout(): void {
        const { cols, rows, fontScale } = this.options;
        const rowHeight = this.rect.height / rows;
        const cellWidth = this.rect.width / cols;
        // Font size is driven by the width a glyph must occupy, so columns
        // reach the right edge; the row pitch then keeps the picture upright.
        const fontSize = Math.max(1, (cellWidth / this.rampAdvance) * fontScale);
        // Give the box real slack: a row that measures even slightly wider
        // than its element wraps, and a wrapped row destroys the picture. The
        // spare width is empty space and cannot be seen.
        const boxWidth = cols * this.rampAdvance * fontSize * WIDTH_SLACK;
        for (let row = 0; row < rows; row++) {
            const line = this.lines[row]!;
            line.x = this.rect.x;
            // Text is drawn from its top-left in Drawdy, so no baseline nudge.
            line.y = this.rect.y + row * rowHeight;
            line.width = boxWidth;
            line.height = fontSize * 1.4;
            line.fontSize = fontSize;
            line.color = this.options.color;
        }
    }

    private retap(frameWidth: number, frameHeight: number): void {
        const { cols, rows, samples } = this.options;
        const key = `${frameWidth}x${frameHeight}:${cols}x${rows}:${samples}`;
        if (key === this.tapsKey) return;
        this.tapsKey = key;
        const perCell = samples * samples;
        const taps = new Int32Array(cols * rows * perCell);
        let index = 0;
        for (let row = 0; row < rows; row++) {
            const top = (row * frameHeight) / rows;
            const bottom = ((row + 1) * frameHeight) / rows;
            for (let column = 0; column < cols; column++) {
                const left = (column * frameWidth) / cols;
                const right = ((column + 1) * frameWidth) / cols;
                for (let sy = 0; sy < samples; sy++) {
                    const py = Math.min(frameHeight - 1, Math.floor(top + ((sy + 0.5) * (bottom - top)) / samples));
                    for (let sx = 0; sx < samples; sx++) {
                        const px = Math.min(frameWidth - 1, Math.floor(left + ((sx + 0.5) * (right - left)) / samples));
                        taps[index++] = (py * frameWidth + px) * 4;
                    }
                }
            }
        }
        this.taps = taps;
        this.invalidate();
    }

    /**
     * Resample a BGRA frame into rows of characters.
     *
     * @returns how many rows changed; only those need sending.
     */
    ingest(frame: Uint8Array, frameWidth: number, frameHeight: number): number {
        this.retap(frameWidth, frameHeight);
        const { cols, rows, samples } = this.options;
        const perCell = samples * samples;
        const ramp = this.rampChars;
        const top = ramp.length - 1;
        const { gamma, contrast } = this.options;
        // A 256-entry lookup keeps Math.pow out of a per-cell loop.
        const curve = this.curve(top, gamma, contrast);
        const taps = this.taps;
        const scratch = this.scratch;

        let tap = 0;
        let changed = 0;
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < cols; column++) {
                let blue = 0;
                let green = 0;
                let red = 0;
                for (let s = 0; s < perCell; s++) {
                    const offset = taps[tap++]!;
                    blue += frame[offset]!;
                    green += frame[offset + 1]!;
                    red += frame[offset + 2]!;
                }
                const luma = (0.299 * red + 0.587 * green + 0.114 * blue) / perCell;
                scratch[column] = ramp[curve[luma | 0]!]!;
            }
            const line = scratch.join("");
            if (line === this.previous[row]) continue;
            this.previous[row] = line;
            this.lines[row]!.text = line;
            changed++;
            if (this.dirtyFlags[row]) continue;
            this.dirtyFlags[row] = 1;
            this.dirty.push(row);
        }
        return changed;
    }

    /** The changed rows, and reset the accumulator. */
    takeDirty(): TextElement[] {
        const batch = new Array<TextElement>(this.dirty.length);
        for (let i = 0; i < this.dirty.length; i++) {
            const row = this.dirty[i]!;
            batch[i] = this.lines[row]!;
            this.dirtyFlags[row] = 0;
        }
        this.dirty.length = 0;
        return batch;
    }

    private curveCache: { key: string; table: Uint8Array } | null = null;

    /** luma 0..255 -> ramp index, with contrast and gamma baked in. */
    private curve(top: number, gamma: number, contrast: number): Uint8Array {
        const key = `${top}:${gamma}:${contrast}`;
        if (this.curveCache?.key === key) return this.curveCache.table;
        const table = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            // Contrast first, around mid-grey, then the gamma lift.
            const stretched = Math.min(255, Math.max(0, (i - 128) * contrast + 128));
            table[i] = Math.min(top, Math.round(Math.pow(stretched / 255, gamma) * top));
        }
        this.curveCache = { key, table };
        return table;
    }

    /** The width one row is meant to span, for fit calibration. */
    get targetWidth(): number {
        return this.rect.width;
    }

    get fontSize(): number {
        return this.lines[0]?.fontSize ?? 0;
    }

    /**
     * Correct the font size from a row the host actually measured.
     *
     * The advance we start from is an estimate; this closes the loop, so the
     * picture spans the screen exactly whatever font the board turned out to
     * be using.
     *
     * @returns true when the scale moved enough to be worth repainting.
     */
    fitToMeasuredWidth(measuredWidth: number): boolean {
        if (!(measuredWidth > 0)) return false;
        const correction = this.targetWidth / measuredWidth;
        if (!Number.isFinite(correction) || correction < 0.2 || correction > 5) return false;
        if (Math.abs(correction - 1) < 0.02) return false;
        this.options.fontScale *= correction;
        this.layout();
        return true;
    }

    /** The picture as plain text — used by the tests to eyeball a frame. */
    toText(): string {
        return this.previous.join("\n");
    }
}
