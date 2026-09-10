/** Boot the real DoomEngine from src against the cached wasm, outside Drawdy. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DoomEngine } from "../../src/doom/engine.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WASM_PATH = join(ROOT, "assets", "doom-v0.1.0.wasm");

let compiled = null;

export async function bootDoom({ onFrame, onLog, saves, wads } = {}) {
    compiled ??= await WebAssembly.compile(readFileSync(WASM_PATH));
    const frame = { pixels: null, width: 0, height: 0 };
    const logs = [];
    const engine = await DoomEngine.instantiate(
        compiled,
        {
            onFrame: (pixels, width, height) => {
                frame.pixels = pixels;
                frame.width = width;
                frame.height = height;
                onFrame?.(pixels, width, height);
            },
            onLog: (level, message) => {
                logs.push(`[${level}] ${message.trimEnd()}`);
                onLog?.(level, message);
            },
            saves,
        },
        wads ?? []
    );
    engine.start();
    return { engine, frame, logs };
}
