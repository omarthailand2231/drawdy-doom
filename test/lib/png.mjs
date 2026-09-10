/** Minimal PNG writer — enough to eyeball a frame without pulling in a dependency. */
import { deflateSync } from "node:zlib";

const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
}

/** @param {Uint8Array} rgba row-major RGBA */
export function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** Rasterise a CanvasScreen's cells as solid blocks, the way Drawdy will draw them. */
export function renderCells(screen, scale = 8) {
    const { cols, rows } = screen.options;
    const width = cols * scale;
    const height = rows * scale;
    const rgba = new Uint8Array(width * height * 4);
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < cols; column++) {
            const hex = screen.elements[row * cols + column].fillColor;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            for (let y = 0; y < scale; y++) {
                let index = ((row * scale + y) * width + column * scale) * 4;
                for (let x = 0; x < scale; x++) {
                    rgba[index++] = r;
                    rgba[index++] = g;
                    rgba[index++] = b;
                    rgba[index++] = 255;
                }
            }
        }
    }
    return { width, height, rgba };
}

/** BGRA frame buffer -> RGBA. */
export function bgraToRgba(frame, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = frame[i * 4 + 2];
        rgba[i * 4 + 1] = frame[i * 4 + 1];
        rgba[i * 4 + 2] = frame[i * 4];
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}
