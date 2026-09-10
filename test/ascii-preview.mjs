/**
 * Print DOOM as ASCII, straight to the terminal.
 *
 * The cheapest possible check on the ramp and the aspect ratio: if it reads as
 * DOOM here, it will read as DOOM on the board.
 *
 *   node test/ascii-preview.mjs [cols] [rows] [ramp] [tics]
 */
import { AsciiScreen, ASCII_RAMPS } from "../src/render/ascii-screen.ts";
import { bootDoom } from "./lib/boot.mjs";

const cols = Number(process.argv[2] ?? 118);
const rows = Number(process.argv[3] ?? 34);
const ramp = process.argv[4] ?? "blocks";
const tics = Number(process.argv[5] ?? 430);
const gamma = Number(process.argv[6] ?? 0.62);

const { engine, frame } = await bootDoom();
let minted = 0;
const screen = new AsciiScreen({ x: 0, y: 0, width: 1280, height: 800 }, () => `line-${minted++}`, {
    cols,
    rows,
    ramp,
    gamma,
});

const run = (n) => { for (let i = 0; i < n; i++) engine.tick(); };
const tap = (key, hold = 12) => { engine.keyDown(key); run(hold); engine.keyUp(key); run(4); };
const K = engine.keys;

// Escape the attract loop and start a real game, so this is gameplay.
run(60);
tap(K.ESCAPE);
tap(K.ENTER);
tap(K.ENTER);
tap(K.ENTER);
engine.keyDown(K.UPARROW);
run(70);
engine.keyUp(K.UPARROW);
run(Math.max(0, tics - engine.tics));

let changed = 0;
let frames = 0;
let cost = 0;
for (let i = 0; i < 60; i++) {
    if (i === 0) engine.keyDown(K.RIGHTARROW);
    if (i === 40) engine.keyUp(K.RIGHTARROW);
    engine.tick();
    if (!frame.pixels) continue;
    const started = performance.now();
    changed += screen.ingest(frame.pixels, frame.width, frame.height);
    cost += performance.now() - started;
    screen.takeDirty();
    frames++;
}

console.log(screen.toText());
console.log(
    `\n${cols}x${rows} · ramp "${ASCII_RAMPS.find((r) => r.id === ramp)?.label ?? ramp}" · ` +
        `${(changed / frames).toFixed(1)} of ${rows} rows change per frame · ${(cost / frames).toFixed(2)} ms to resample`
);
