/**
 * The display.
 *
 * Drawdy has no per-frame pixel surface, so DOOM's 640x400 frame buffer is
 * resampled onto a grid of canvas rectangles — one shape per "pixel" — drawn
 * as *preview* elements. Preview elements render but never commit: they skip
 * undo, collaboration sync and persistence, which is the only way to touch the
 * scene 35 times a second without filling the board with rubbish. (They also
 * cannot be images — `DrawdyPreviewElementSchema` excludes that type — so a
 * grid of shapes is genuinely the way to put a moving picture on a board.)
 *
 * Two things keep it fast:
 *
 * - **Element objects are allocated once** and mutated in place, so a frame
 *   costs no garbage. Safe because the render loop never mutates while an
 *   update is in flight.
 * - **Only changed cells are sent.** Colours are quantised before comparison,
 *   so dithering noise does not count as change. Standing still in a corridor
 *   sends almost nothing; a rocket blast sends the screen.
 */
import type { DrawdyPreviewElementSchema } from "@drawdy/driver-protocol";

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type ScreenStyle = "pixel" | "sketch";

export interface ScreenOptions {
    cols: number;
    rows: number;
    /** Bits per colour channel used for both display and change detection. */
    colorBits: number;
    /** Samples per cell axis when downscaling (1 = point sample, 4 = 16 taps). */
    samples: number;
    /** Grown into neighbours to hide hairline seams between cells. */
    bleed: number;
    style: ScreenStyle;
}

export const DEFAULT_SCREEN_OPTIONS: ScreenOptions = {
    cols: 80,
    rows: 50,
    colorBits: 5,
    samples: 2,
    bleed: 0.6,
    style: "pixel",
};

/** Named grid sizes. DOOM's 640x400 divides cleanly by all of them. */
export const RESOLUTIONS = [
    { id: "tiny", label: "Tiny — 40 x 25 (1,000 cells)", cols: 40, rows: 25 },
    { id: "small", label: "Small — 64 x 40 (2,560 cells)", cols: 64, rows: 40 },
    { id: "medium", label: "Medium — 80 x 50 (4,000 cells)", cols: 80, rows: 50 },
    { id: "large", label: "Large — 128 x 80 (10,240 cells)", cols: 128, rows: 80 },
    { id: "insane", label: "Insane — 160 x 100 (16,000 cells)", cols: 160, rows: 100 },
] as const;

export type ResolutionId = (typeof RESOLUTIONS)[number]["id"];

type Cell = Extract<DrawdyPreviewElementSchema, { type: "shape" }>;

export class CanvasScreen {
    readonly options: ScreenOptions;
    rect: Rect;

    /** One prebuilt, reused element per cell. */
    private cells: Cell[] = [];
    /** Last quantised colour per cell; -1 means "never drawn". */
    private previous = new Int32Array(0);
    /** Byte offsets into the frame buffer, `samples²` of them per cell. */
    private taps = new Int32Array(0);
    private tapsKey = "";
    private hex: (string | undefined)[] = [];
    private hexShift = 0;
    private hexMask = 0;

    /** Indices of cells whose colour changed on the last `ingest`. */
    readonly dirty: number[] = [];

    constructor(rect: Rect, options: Partial<ScreenOptions> = {}) {
        this.options = { ...DEFAULT_SCREEN_OPTIONS, ...options };
        this.rect = rect;
        this.rebuild();
    }

    get cellCount(): number {
        return this.options.cols * this.options.rows;
    }

    /** Every cell, for `command:scene:create-drawdy-preview-elements`. */
    get elements(): readonly Cell[] {
        return this.cells;
    }

    idOf(index: number): string {
        return this.cells[index]!.drawdyElementId;
    }

    /** Cell index behind a point in canvas space, or -1 when outside the screen. */
    cellAt(x: number, y: number): number {
        const { cols, rows } = this.options;
        const column = Math.floor(((x - this.rect.x) / this.rect.width) * cols);
        const row = Math.floor(((y - this.rect.y) / this.rect.height) * rows);
        if (column < 0 || row < 0 || column >= cols || row >= rows) return -1;
        return row * cols + column;
    }

    /** Fraction across the screen (0..1 inside, outside that beyond the edges). */
    normalise(x: number, y: number): { u: number; v: number } {
        return { u: (x - this.rect.x) / this.rect.width, v: (y - this.rect.y) / this.rect.height };
    }

    setRect(rect: Rect): void {
        this.rect = rect;
        this.layout();
    }

    setOptions(next: Partial<ScreenOptions>): boolean {
        const before = JSON.stringify(this.options);
        Object.assign(this.options, next);
        if (JSON.stringify(this.options) === before) return false;
        this.rebuild();
        return true;
    }

    /** Forget history so the next `ingest` repaints every cell. */
    invalidate(): void {
        this.previous.fill(-1);
    }

    private rebuild(): void {
        const { cols, rows, colorBits } = this.options;
        const count = cols * rows;

        this.hexShift = 8 - colorBits;
        this.hexMask = (1 << colorBits) - 1;
        this.hex = new Array<string | undefined>(1 << (colorBits * 3));

        this.cells = new Array<Cell>(count);
        for (let i = 0; i < count; i++) {
            this.cells[i] = {
                type: "shape",
                componentType: "rect",
                drawdyElementId: `doom-px-${i}`,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                strokeColor: "#000000",
                fillColor: "#000000",
                fillStyle: "solid",
                strokeWidth: 0,
                cornerRadius: 0,
                roughness: this.options.style === "sketch" ? 1 : 0,
                // A stable seed stops any sketch-mode hatching from jittering
                // between frames; with roughness 0 it simply does not matter.
                seed: 1 + i,
            };
        }
        this.previous = new Int32Array(count).fill(-1);
        this.tapsKey = "";
        this.layout();
    }

    private layout(): void {
        const { cols, rows, bleed } = this.options;
        const cellWidth = this.rect.width / cols;
        const cellHeight = this.rect.height / rows;
        for (let row = 0, i = 0; row < rows; row++) {
            for (let column = 0; column < cols; column++, i++) {
                const cell = this.cells[i]!;
                cell.x = this.rect.x + column * cellWidth;
                cell.y = this.rect.y + row * cellHeight;
                cell.width = cellWidth + bleed;
                cell.height = cellHeight + bleed;
            }
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
                    const py = Math.min(
                        frameHeight - 1,
                        Math.floor(top + ((sy + 0.5) * (bottom - top)) / samples)
                    );
                    for (let sx = 0; sx < samples; sx++) {
                        const px = Math.min(
                            frameWidth - 1,
                            Math.floor(left + ((sx + 0.5) * (right - left)) / samples)
                        );
                        taps[index++] = (py * frameWidth + px) * 4;
                    }
                }
            }
        }
        this.taps = taps;
        this.invalidate();
    }

    private hexFor(quantised: number): string {
        const cached = this.hex[quantised];
        if (cached !== undefined) return cached;
        const bits = this.options.colorBits;
        const mask = this.hexMask;
        const expand = (v: number): number => ((v << this.hexShift) | (v >> (2 * bits - 8))) & 0xff;
        const r = expand((quantised >> (bits * 2)) & mask);
        const g = expand((quantised >> bits) & mask);
        const b = expand(quantised & mask);
        const value = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
        this.hex[quantised] = value;
        return value;
    }

    /**
     * Resample a BGRA frame onto the grid.
     *
     * @returns how many cells changed colour; `this.dirty` holds their indices.
     */
    ingest(frame: Uint8Array, frameWidth: number, frameHeight: number): number {
        this.retap(frameWidth, frameHeight);

        const { cols, rows, samples, colorBits } = this.options;
        const count = cols * rows;
        const perCell = samples * samples;
        const shift = 8 - colorBits;
        const taps = this.taps;
        const previous = this.previous;
        const cells = this.cells;
        const dirty = this.dirty;
        dirty.length = 0;

        let tap = 0;
        for (let i = 0; i < count; i++) {
            let blue = 0;
            let green = 0;
            let red = 0;
            for (let s = 0; s < perCell; s++) {
                const offset = taps[tap++]!;
                blue += frame[offset]!;
                green += frame[offset + 1]!;
                red += frame[offset + 2]!;
            }
            const quantised =
                (((red / perCell) | 0) >> shift) * (1 << (colorBits * 2)) +
                ((((green / perCell) | 0) >> shift) << colorBits) +
                ((((blue / perCell) | 0) >> shift));

            if (quantised === previous[i]) continue;
            previous[i] = quantised;
            const colour = this.hexFor(quantised);
            const cell = cells[i]!;
            cell.fillColor = colour;
            cell.strokeColor = colour;
            dirty.push(i);
        }
        return dirty.length;
    }

    /** The changed cells, ready for `command:scene:update-drawdy-preview-elements`. */
    dirtyElements(): Cell[] {
        const cells = this.cells;
        const dirty = this.dirty;
        const batch = new Array<Cell>(dirty.length);
        for (let i = 0; i < dirty.length; i++) batch[i] = cells[dirty[i]!]!;
        return batch;
    }
}
