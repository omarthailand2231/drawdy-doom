/**
 * End-to-end smoke run outside Drawdy: boot DOOM, drive it with a scripted
 * key sequence, and write out both the true frame buffer and exactly what the
 * canvas cell grid would show. Eyeballing test/out/*.png is the fastest way to
 * confirm the whole display path before loading the driver into a board.
 *
 *   node test/render-demo.mjs [ticks] [resolution]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasScreen, RESOLUTIONS } from "../src/render/screen.ts";
import { bgraToRgba, encodePng, renderCells } from "./lib/png.mjs";
import { bootDoom } from "./lib/boot.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });

const totalTics = Number(process.argv[2] ?? 700);
const resolutionId = process.argv[3] ?? "medium";
const resolution = RESOLUTIONS.find((r) => r.id === resolutionId) ?? RESOLUTIONS[2];

const { engine, frame } = await bootDoom();
console.log(`booted DOOM — frame buffer ${engine.width}x${engine.height}`);

let minted = 0;
const screen = new CanvasScreen(
    { x: 0, y: 0, width: 1280, height: 800 },
    () => `cell-${minted++}`,
    { cols: resolution.cols, rows: resolution.rows }
);
console.log(`display grid ${screen.options.cols}x${screen.options.rows} = ${screen.cellCount} cells`);

const K = engine.keys;
// Escape out of the attract-loop demo, start a new game on the default skill,
// then walk forward and shoot so the shots below are real gameplay.
const script = [
    [20, "tap", K.ESCAPE],
    [40, "tap", K.ENTER], // "New Game"
    [60, "tap", K.ENTER], // episode: Knee-Deep in the Dead
    [80, "tap", K.ENTER], // skill: Hurt me plenty
    [140, "down", K.UPARROW],
    [230, "up", K.UPARROW],
    [250, "tap", K.FIRE],
    [300, "down", K.RIGHTARROW],
    [330, "up", K.RIGHTARROW],
    [360, "down", K.UPARROW],
    [430, "up", K.UPARROW],
];
const shots = new Set([1, 30, 120, 200, 300, 460, totalTics - 1]);

let dirtyTotal = 0;
let ingestMs = 0;
let sentPeak = 0;
const timeline = [];

for (let tic = 0; tic < totalTics; tic++) {
    for (const [at, action, key] of script) {
        if (at !== tic) continue;
        if (action === "down") engine.keyDown(key);
        else if (action === "up") engine.keyUp(key);
        else {
            engine.keyDown(key);
            queueMicrotask(() => engine.keyUp(key));
        }
    }
    engine.tick();
    // Release taps a tic later, the way the driver's auto-release does.
    for (const [at, action, key] of script) {
        if (action === "tap" && at === tic - 1) engine.keyUp(key);
    }
    if (!frame.pixels) continue;

    const started = performance.now();
    const changed = screen.ingest(frame.pixels, frame.width, frame.height);
    ingestMs += performance.now() - started;
    screen.takeDirty();
    dirtyTotal += changed;
    sentPeak = Math.max(sentPeak, changed);
    timeline.push(changed);

    if (shots.has(tic)) {
        const cells = renderCells(screen, Math.max(2, Math.round(640 / screen.options.cols)));
        writeFileSync(join(OUT, `cells-${String(tic).padStart(4, "0")}.png`), encodePng(cells.width, cells.height, cells.rgba));
        writeFileSync(
            join(OUT, `frame-${String(tic).padStart(4, "0")}.png`),
            encodePng(frame.width, frame.height, bgraToRgba(frame.pixels, frame.width, frame.height))
        );
    }
}

if (engine.crashed) console.error("ENGINE CRASHED:", engine.crashed);

const frames = timeline.length;
const average = dirtyTotal / frames;
console.log(`
tics run          ${engine.tics}
frames drawn      ${engine.frames}
resample cost     ${(ingestMs / frames).toFixed(2)} ms/frame  (${ingestMs.toFixed(0)} ms total)
cells changed     avg ${average.toFixed(0)} / ${screen.cellCount}  (${((average / screen.cellCount) * 100).toFixed(1)}%)
                  peak ${sentPeak}
still-frame cost  ${Math.min(...timeline.slice(-40))} cells on the quietest recent frame
wrote             ${OUT}
`);
