/**
 * A stand-in for the worker's OffscreenCanvas, so the full-resolution display
 * path can be exercised in Node.
 *
 * It is deliberately minimal: enough for ImageScreen (createImageData,
 * putImageData, convertToBlob) and nothing more. `convertToBlob` always hands
 * back a PNG regardless of the requested type, which conveniently also
 * exercises the "the browser gave us something else" branch.
 */
import { encodePng } from "./png.mjs";

class FakeContext {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.image = null;
    }
    createImageData(width, height) {
        return { data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: "srgb" };
    }
    putImageData(image) {
        this.image = image;
    }
}

class FakeOffscreenCanvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.context = new FakeContext(width, height);
    }
    getContext() {
        return this.context;
    }
    async convertToBlob() {
        const image = this.context.image;
        if (!image) throw new Error("nothing drawn");
        return new Blob([encodePng(this.width, this.height, new Uint8Array(image.data.buffer))], {
            type: "image/png",
        });
    }
}

export function installOffscreenCanvasDouble() {
    globalThis.OffscreenCanvas = FakeOffscreenCanvas;
    globalThis.createImageBitmap ??= async () => {
        throw new Error("not needed by ImageScreen");
    };
}
