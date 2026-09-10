/**
 * How much does monochrome actually save?
 *
 * The grid only sends a cell when its quantised colour changes, so the
 * question is not "how many colours" but "how many cells change per frame".
 * Same frames, same grid, one screen per palette.
 */
import { CanvasScreen, PALETTES, RESOLUTIONS } from "../src/render/screen.ts";
import { bootDoom } from "./lib/boot.mjs";

const tics = Number(process.argv[2] ?? 600);
const resolution = RESOLUTIONS.find((r) => r.id === (process.argv[3] ?? "large"));
const shades = Number(process.argv[4] ?? 24);

const { engine, frame } = await bootDoom();
const K = engine.keys;

let minted = 0;
const variants = [
    { label: "Colour", id: "color", shades: 0 },
    ...[8, 12, 16, 24, 32].map((n) => ({ label: `Monochrome ${n}`, id: "mono", shades: n })),
    { label: `Amber ${shades}`, id: "amber", shades },
    { label: `Green ${shades}`, id: "green", shades },
];
const screens = variants.map((variant) => ({
    palette: variant,
    screen: new CanvasScreen({ x: 0, y: 0, width: 1280, height: 800 }, () => `c${minted++}`, {
        cols: resolution.cols,
        rows: resolution.rows,
        palette: variant.id,
        shades: variant.shades || 24,
    }),
    changed: 0,
    ms: 0,
    colours: new Set(),
}));

const tap = (key, hold = 12) => {
    engine.keyDown(key);
    for (let i = 0; i < hold; i++) engine.tick();
    engine.keyUp(key);
    for (let i = 0; i < 4; i++) engine.tick();
};
for (let i = 0; i < 60; i++) engine.tick();
tap(K.ESCAPE);
tap(K.ENTER);
tap(K.ENTER);
tap(K.ENTER);

let frames = 0;
for (let tic = 0; tic < tics; tic++) {
    // keep moving, so this measures gameplay rather than a still screen
    if (tic % 90 === 0) engine.keyDown(K.UPARROW);
    if (tic % 90 === 60) engine.keyUp(K.UPARROW);
    if (tic % 140 === 100) engine.keyDown(K.RIGHTARROW);
    if (tic % 140 === 130) engine.keyUp(K.RIGHTARROW);
    engine.tick();
    if (!frame.pixels) continue;
    frames++;
    for (const entry of screens) {
        const started = performance.now();
        entry.changed += entry.screen.ingest(frame.pixels, frame.width, frame.height);
        entry.ms += performance.now() - started;
        entry.screen.takeDirty();
    }
}

for (const entry of screens) {
    for (const cell of entry.screen.elements) entry.colours.add(cell.fillColor);
}

const cells = resolution.cols * resolution.rows;
const baseline = screens[0].changed / frames;
console.log(`\n${resolution.label}, ${frames} gameplay frames, ${shades} shades\n`);
console.log("palette          cells/frame   of grid   vs colour   resample   palette size");
for (const entry of screens) {
    const average = entry.changed / frames;
    console.log(
        `${entry.palette.label.padEnd(16)} ${average.toFixed(0).padStart(10)}  ${((average / cells) * 100).toFixed(1).padStart(7)}%  ${(
            (average / baseline) * 100
        ).toFixed(0).padStart(9)}%  ${(entry.ms / frames).toFixed(2).padStart(8)} ms  ${String(entry.colours.size).padStart(6)}`
    );
}
console.log();
