#!/usr/bin/env node
/**
 * Serve an already-built .drawdyx, and nothing else.
 *
 * `npm run dev` runs Vite, which keeps Rollup and a 2 MB base64 wasm string
 * resident and rebuilds on every file touch. That is the right tool when you
 * are editing the driver, and far too heavy when you just want to play — on a
 * machine under memory pressure macOS will kill it mid-game.
 *
 * Drawdy only ever asks for two things: `/version` to poll, and
 * `/built.drawdyx` to fetch. This serves exactly those from disk, watches the
 * package so `npm run build` in another terminal still triggers a hot reload,
 * and holds nothing but the file itself.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "dist", "drawdy-doom.drawdyx");
const PORT = Number(process.env.PORT ?? 5174);

let version = 1;
let signature = "";

async function refresh() {
    try {
        const info = await stat(PACKAGE);
        const next = `${info.size}:${info.mtimeMs}`;
        if (next === signature) return;
        signature = next;
        version++;
        console.log(`[doom] v${version} — ${(info.size / 1048576).toFixed(2)} MiB`);
    } catch {
        console.error(`[doom] no package at ${PACKAGE} — run: npm run build`);
    }
}

await refresh();
version = 1; // the first sighting is not a change

try {
    watch(dirname(PACKAGE), (_event, name) => {
        if (name && name.endsWith(".drawdyx")) void refresh();
    });
} catch {
    console.warn("[doom] cannot watch dist/; rebuilds will not hot-reload");
}

createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    response.setHeader("cache-control", "no-store");

    if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
    }
    if (path === "/version") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ version }));
        return;
    }
    if (path === "/built.drawdyx") {
        readFile(PACKAGE).then(
            (bytes) => {
                response.setHeader("content-type", "application/zip");
                response.end(bytes);
            },
            () => {
                response.statusCode = 404;
                response.end();
            }
        );
        return;
    }
    response.statusCode = 404;
    response.end("drawdy-doom: /version and /built.drawdyx only\n");
}).listen(PORT, () => {
    console.log(`[doom] serving ${PACKAGE.replace(ROOT + "/", "")} on http://localhost:${PORT}`);
    console.log("[doom] rebuild with `npm run build` in another terminal to hot-reload");
});
