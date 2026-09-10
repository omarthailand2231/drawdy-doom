/**
 * Unpack the embedded engine.
 *
 * The 4.5 MB wasm is shipped gzipped and base64-encoded inside the bundle so a
 * `.drawdyx` is one self-contained file that works with no network at all.
 * Both `atob` and `DecompressionStream` exist in worker scope (and in Node,
 * which is what lets the headless tests exercise this exact path).
 */
import { DOOM_WASM_BYTES, DOOM_WASM_GZ_BASE64 } from "../generated/doom-wasm";

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error("this browser cannot inflate gzip (DecompressionStream missing)");
    }
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

let cached: Promise<WebAssembly.Module> | null = null;

/** Decode, inflate and compile the engine. Compiled once per driver load. */
export function loadDoomModule(): Promise<WebAssembly.Module> {
    cached ??= (async () => {
        const wasm = await gunzip(base64ToBytes(DOOM_WASM_GZ_BASE64));
        if (wasm.length !== DOOM_WASM_BYTES) {
            throw new Error(`engine unpacked to ${wasm.length} bytes, expected ${DOOM_WASM_BYTES}`);
        }
        return WebAssembly.compile(wasm as BufferSource);
    })();
    return cached;
}
