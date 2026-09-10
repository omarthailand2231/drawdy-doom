/**
 * The full-resolution display.
 *
 * The shape grid (see `screen.ts`) draws DOOM as one canvas rectangle per
 * "pixel", which is charming but caps out around 160x100 before the board is
 * pushing tens of thousands of elements a second.
 *
 * There is a far better primitive hiding in the protocol. Preview elements may
 * not be images — `DrawdyPreviewElementSchema` excludes that type — but they
 * *may* be `component` elements, and a component carries a whole
 * `DomElementSchema`, whose `image` node takes an image URL. So one preview
 * component holding one encoded frame puts DOOM on the board at its native
 * 640x400, and a frame becomes a *single* element update instead of thousands.
 *
 * Encoding happens on an OffscreenCanvas in the worker: BGRA is swizzled to
 * RGBA in one pass over a Uint32Array, handed to `convertToBlob`, and inlined
 * as a data URL. Data URLs rather than object URLs on purpose — an object URL
 * revoked while the host is still decoding it flickers, and a data URL simply
 * cannot go stale.
 */
import type { DrawdyPreviewElementSchema } from "@drawdy/driver-protocol";
import { bytesToBase64 } from "../bytes";
import type { Rect } from "./screen";

export type ImageFormat = "image/webp" | "image/jpeg" | "image/png";

export interface ImageScreenOptions {
    format: ImageFormat;
    /** 0..1 for lossy formats. */
    quality: number;
}

export const DEFAULT_IMAGE_OPTIONS: ImageScreenOptions = {
    format: "image/webp",
    quality: 0.82,
};

/** True when this browser gives workers everything the image display needs. */
export function imageDisplaySupported(): boolean {
    return typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";
}

export class ImageScreen {
    readonly id: string;
    rect: Rect;
    readonly options: ImageScreenOptions;

    /** Set once the first encode reveals what the browser actually produced. */
    actualFormat: string | null = null;
    lastBytes = 0;
    lastEncodeMs = 0;

    private canvas: OffscreenCanvas | null = null;
    private context: OffscreenCanvasRenderingContext2D | null = null;
    private image: ImageData | null = null;
    private rgba: Uint32Array | null = null;
    private width = 0;
    private height = 0;

    constructor(rect: Rect, id: string, options: Partial<ImageScreenOptions> = {}) {
        this.rect = rect;
        this.id = id;
        this.options = { ...DEFAULT_IMAGE_OPTIONS, ...options };
    }

    setRect(rect: Rect): void {
        this.rect = rect;
    }

    private ensureSurface(width: number, height: number): void {
        if (this.canvas && this.width === width && this.height === height) return;
        this.width = width;
        this.height = height;
        this.canvas = new OffscreenCanvas(width, height);
        const context = this.canvas.getContext("2d", { alpha: false, willReadFrequently: false });
        if (!context) throw new Error("OffscreenCanvas 2d context unavailable");
        this.context = context as OffscreenCanvasRenderingContext2D;
        this.image = this.context.createImageData(width, height);
        this.rgba = new Uint32Array(this.image.data.buffer);
    }

    /**
     * Turn one BGRA frame into a data URL.
     *
     * DOOM's pixels are BGRA bytes, which little-endian reads as
     * `0xAARRGGBB`; ImageData wants RGBA bytes, i.e. `0xAABBGGRR`. Swapping the
     * red and blue lanes over a Uint32Array does the whole frame in one pass.
     */
    async encode(frame: Uint8Array, width: number, height: number): Promise<string> {
        const started = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.ensureSurface(width, height);
        const out = this.rgba!;
        const source = new Uint32Array(frame.buffer, frame.byteOffset, width * height);
        for (let i = 0; i < out.length; i++) {
            const pixel = source[i]!;
            out[i] = 0xff000000 | ((pixel & 0xff) << 16) | (pixel & 0xff00) | ((pixel >>> 16) & 0xff);
        }
        this.context!.putImageData(this.image!, 0, 0);

        const blob = await this.canvas!.convertToBlob({
            type: this.options.format,
            quality: this.options.quality,
        });
        // convertToBlob silently falls back to PNG for formats it cannot do.
        this.actualFormat = blob.type;
        this.lastBytes = blob.size;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.lastEncodeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
        this.placeholderSource = `data:${blob.type};base64,${bytesToBase64(bytes)}`;
        return this.placeholderSource;
    }

    /** The single preview element that is the whole screen. */
    element(source: string): DrawdyPreviewElementSchema {
        return {
            type: "component",
            drawdyElementId: this.id,
            x: this.rect.x,
            y: this.rect.y,
            width: this.rect.width,
            height: this.rect.height,
            schema: {
                type: "image",
                child: source,
                styles: {
                    width: [100, "%"],
                    height: [100, "%"],
                    backgroundColor: "#000000",
                    overflow: "hidden",
                    pointerEvents: "none",
                },
            },
        };
    }

    /** The most recent frame's source, so the element can be re-laid-out without a re-encode. */
    placeholderSource =
        "data:image/svg+xml;base64," +
        btoa('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#000"/></svg>');

    /** A black stand-in, so the screen exists before the first frame lands. */
    placeholder(): DrawdyPreviewElementSchema {
        return this.element(this.placeholderSource);
    }
}
