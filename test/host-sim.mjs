/**
 * Run the packaged driver against a stand-in Drawdy host.
 *
 * This loads `dist/main.js` — the exact CommonJS bundle that goes inside the
 * .drawdyx — implements the slice of DDP the driver uses, and drives it the
 * way a player would: right-click → Start, then some keys. Everything real
 * happens: the embedded wasm is base64-decoded, gunzipped and compiled, DOOM
 * boots, frames are resampled, and preview-element updates arrive here.
 *
 * The accumulated cell colours are then rasterised to a PNG, so you can see
 * precisely what a board would be showing.
 *
 *   node test/host-sim.mjs [seconds]
 */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./lib/png.mjs";
import { timerReport } from "./out/timer-probe.mjs";
import { installOffscreenCanvasDouble } from "./lib/offscreen-canvas-double.mjs";

// Node has no OffscreenCanvas; stand one in so the image display path runs here too.
installOffscreenCanvasDouble();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test", "out");
mkdirSync(OUT, { recursive: true });

// package.json is type:module, so the CJS bundle needs a .cjs extension to load.
const bundlePath = join(OUT, "main.bundle.cjs");
copyFileSync(join(ROOT, "dist", "main.js"), bundlePath);
const driver = createRequire(import.meta.url)(bundlePath);

const seconds = Number(process.argv[2] ?? 4);

// ---------------------------------------------------------------- fake host

const scene = new Map(); // elementId -> element
const calls = new Map(); // command type -> count
const webviewMessages = [];
let previewSeq = 0;
let subscriptionSeq = 0;
let updates = 0;
let lastImageSource = null;
const updateTimes = [];
let updatedElements = 0;
let biggestUpdate = 0;
const storage = new Map();

const VIEWPORT = { x: 0, y: 0, width: 1600, height: 1000 };

const listeners = []; // subscriptionId -> type, so events can be routed back

function ok(value) {
    return { res: { value } };
}

async function issueCommand(request) {
    const { type, req } = request;
    calls.set(type, (calls.get(type) ?? 0) + 1);

    if (type.startsWith("subscription:")) {
        const subscriptionId = `sub-${subscriptionSeq++}`;
        listeners.push({ subscriptionId, type, req });
        return ok({ subscriptionId });
    }

    switch (type) {
        case "command:context-menu:add":
            return ok({ added: true });
        case "command:context-menu:remove":
            return ok({ removed: true });
        case "command:dom:create-action-button":
            return ok({ created: true });
        case "command:camera:get-viewport-rect":
            return ok({ rect: VIEWPORT });
        case "command:camera:fly-to-rect":
        case "command:camera:fly-to-elements":
            return ok(undefined);
        case "command:kv-storage:get":
            return ok({ got: storage.get(req.key) });
        case "command:kv-storage:set":
            storage.set(req.key, req.payload);
            return ok(undefined);
        case "command:kv-storage:delete":
            return ok({ deleted: storage.delete(req.key) });
        case "command:scene:create-drawdy-preview-elements":
            scene.clear();
            for (const element of req.elements) scene.set(element.drawdyElementId, { ...element });
            return ok({ previewed: req.elements.length, previewId: `preview-${previewSeq++}` });
        case "command:scene:update-drawdy-preview-elements": {
            for (const element of req.elements) {
                if (element.type === "component" && typeof element.schema?.child === "string") {
                    lastImageSource = element.schema.child;
                }
            }
            let hits = 0;
            for (const element of req.elements) {
                if (!scene.has(element.drawdyElementId)) continue;
                Object.assign(scene.get(element.drawdyElementId), element);
                hits++;
            }
            updates++;
            updateTimes.push(Date.now());
            updatedElements += hits;
            biggestUpdate = Math.max(biggestUpdate, req.elements.length);
            // Stand in for a postMessage round trip to the main thread.
            await new Promise((resolve) => setImmediate(resolve));
            return ok({ updated: hits });
        }
        case "command:scene:delete-drawdy-preview-elements":
            scene.clear();
            return ok({ deleted: req.previewIds.length });
        case "command:webview:create":
            return ok({ created: true });
        case "command:webview:hide":
            return ok(undefined);
        case "command:webview:post-message":
            webviewMessages.push(req.message);
            return ok({ posted: true });
        case "command:dom:enter-fullscreen":
            return ok({ entered: false });
        case "command:dom:exit-fullscreen":
            return ok({ exited: false });
        case "command:subscription:remove":
            return ok({ removed: true });
        default:
            return { res: { error: { type: "not-found", message: `unhandled ${type}` } } };
    }
}

function emit(type, body) {
    for (const listener of listeners) {
        if (listener.type !== type) continue;
        // Real Drawdy delivers a menu click only to the subscription for that
        // menuId, and a dom click only for that element — mirror that.
        if (body?.menuId && listener.req?.menuId && listener.req.menuId !== body.menuId) continue;
        if (body?.domElementId && listener.req?.domElementId && listener.req.domElementId !== body.domElementId) continue;
        void driver.onEvent(body === undefined ? { type, subscriptionId: listener.subscriptionId } : { type, subscriptionId: listener.subscriptionId, body });
    }
}

const styling = {
    theme: "dark", background: "#0b0c0e", foreground: "#e6e6e8", surface: "#16181b",
    surface2: "#1f2226", mutedForeground: "#9aa0a6", primary: "#b3271b", primaryForeground: "#fff",
    accent: "#e08a2b", accentForeground: "#000", border: "#2c2f34", input: "#2c2f34", ring: "#b3271b",
    destructive: "#e0483a", success: "#37b26a", warning: "#e3b23c",
    radiusSm: "4px", radiusMd: "8px", radiusLg: "12px",
};

let idSeq = 0;
const generateId = () => `el-${idSeq++}`;

// ------------------------------------------------------------------- the run

const wall = Date.now();
await driver.activate({
    issueCommand,
    manifest: { driverId: "drawdy.doom", driverName: "DOOM", driverVersion: "1.0.0", main: "main.js", permissions: ["dom", "scene", "storage"] },
    styling,
    generateId,
});
console.log(`activate() done in ${Date.now() - wall} ms`);
console.log(`  menus + subscriptions registered: ${listeners.length}`);

// Right-click -> DOOM -> Start
const booted = Date.now();
emit("subscription:dom:element-clicked", { domElementId: "doom-action-button", clientX: 0, clientY: 0 });
emit("subscription:context-menu:clicked", { menuId: "doom.start" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(1500);
console.log(`first ${updates} updates after ${Date.now() - booted} ms (engine compile + boot included)`);

// Escape out of the attract loop and start a real game, the way a player would.
const tap = (key, extra = {}) =>
    emit("subscription:keyboard:control-keys", { key, shift: false, ctrl: false, meta: false, alt: false, ...extra });

for (const key of ["escape", "enter", "enter", "enter"]) {
    tap(key);
    await sleep(450);
}
// Measure a window of pure gameplay: walking and turning, nothing idle.
const windowStart = Date.now();
const updatesBefore = updates;
const framesBefore = updateTimes.length;
const playMs = Math.max(2000, seconds * 1000 - 3000);
const spinUntil = Date.now() + playMs;
let beat = 0;
const shots = [];
while (Date.now() < spinUntil) {
    tap(beat % 4 === 3 ? "arrow-right" : "arrow-up"); // OS key-repeat cadence
    if (beat % 8 === 0) tap("space");
    beat++;
    if (beat % 20 === 0) shots.push([...scene.values()].map((e) => ({ ...e })));
    await sleep(60);
}
const playSeconds = (Date.now() - windowStart) / 1000;
const playUpdates = updates - updatesBefore;
const playGaps = updateTimes.slice(framesBefore + 1).map((t, i) => t - updateTimes[framesBefore + i]).sort((a, b) => a - b);
console.log(`gameplay window   ${playUpdates} updates in ${playSeconds.toFixed(1)}s = ${(playUpdates / playSeconds).toFixed(1)} fps  (median gap ${playGaps[playGaps.length >> 1] ?? "-"} ms)`);

const snapshot = [...scene.values()].map((element) => ({ ...element }));
emit("subscription:context-menu:clicked", { menuId: "doom.stop" });
await sleep(200);

// ------------------------------------------------------------------- results

const cells = snapshot.filter((e) => e.width < 100);
const xs = [...new Set(cells.map((c) => Math.round(c.x)))].sort((a, b) => a - b);
const ys = [...new Set(cells.map((c) => Math.round(c.y)))].sort((a, b) => a - b);
const gaps = updateTimes.slice(1).map((t, i) => t - updateTimes[i]).sort((a, b) => a - b);
const states = webviewMessages.filter((m) => m && m.t === "state");
const last = states[states.length - 1] ?? {};
console.log("timers", JSON.stringify(timerReport()));
console.log(`
driver's own view fps=${(last.fps ?? 0).toFixed(1)} tics=${last.tics ?? 0} budget=${(last.budgetMs ?? 0).toFixed(1)}ms status=${last.status ?? "?"}\nloop diagnostics  ${JSON.stringify(last.diag ?? {})}
update cadence    median ${gaps[gaps.length >> 1] ?? "-"} ms   min ${gaps[0] ?? "-"}   max ${gaps[gaps.length - 1] ?? "-"}
commands issued   ${[...calls.entries()].map(([k, v]) => `${k.replace("command:", "").replace("subscription:", "sub ")}=${v}`).join("  ")}

preview cells     ${cells.length}  (${xs.length} x ${ys.length} grid)
canvas updates    ${updates}  (${updatedElements} elements total, biggest ${biggestUpdate})
state pushed      ${webviewMessages.length} webview messages
distinct colours  ${new Set(cells.map((c) => c.fillColor)).size}
`);

if (lastImageSource) {
    const [header, payload] = lastImageSource.split(",");
    const extension = header.includes("webp") ? "webp" : header.includes("jpeg") ? "jpg" : "png";
    const file = join(OUT, `board-full.${extension}`);
    writeFileSync(file, Buffer.from(payload, "base64"));
    console.log(`full-resolution frame  ${(payload.length / 1024).toFixed(0)} KB data URL -> ${file}`);
    process.exit(0);
}

if (cells.length === 0) {
    console.error("FAIL: nothing was drawn");
    process.exit(1);
}

// Rasterise exactly what the board holds right now.
const scale = 8;
const width = xs.length * scale;
const height = ys.length * scale;
const rgba = new Uint8Array(width * height * 4).fill(255);
const xi = new Map(xs.map((v, i) => [v, i]));
const yi = new Map(ys.map((v, i) => [v, i]));
for (const cell of cells) {
    const column = xi.get(Math.round(cell.x));
    const row = yi.get(Math.round(cell.y));
    if (column === undefined || row === undefined) continue;
    const r = parseInt(cell.fillColor.slice(1, 3), 16);
    const g = parseInt(cell.fillColor.slice(3, 5), 16);
    const b = parseInt(cell.fillColor.slice(5, 7), 16);
    for (let y = 0; y < scale; y++) {
        let index = ((row * scale + y) * width + column * scale) * 4;
        for (let x = 0; x < scale; x++) {
            rgba[index++] = r; rgba[index++] = g; rgba[index++] = b; rgba[index++] = 255;
        }
    }
}
const png = join(OUT, "board.png");
writeFileSync(png, encodePng(width, height, rgba));
console.log(`what the board shows -> ${png}`);

shots.forEach((shot, i) => {
    const list = shot.filter((e) => e.width < 100);
    const buffer = new Uint8Array(width * height * 4).fill(255);
    for (const cell of list) {
        const column = xi.get(Math.round(cell.x));
        const row = yi.get(Math.round(cell.y));
        if (column === undefined || row === undefined) continue;
        const r = parseInt(cell.fillColor.slice(1, 3), 16);
        const g = parseInt(cell.fillColor.slice(3, 5), 16);
        const b = parseInt(cell.fillColor.slice(5, 7), 16);
        for (let y = 0; y < scale; y++) {
            let index = ((row * scale + y) * width + column * scale) * 4;
            for (let x = 0; x < scale; x++) { buffer[index++] = r; buffer[index++] = g; buffer[index++] = b; buffer[index++] = 255; }
        }
    }
    writeFileSync(join(OUT, `play-${i}.png`), encodePng(width, height, buffer));
});
console.log(`gameplay stills   ${shots.length}`);
process.exit(0);
