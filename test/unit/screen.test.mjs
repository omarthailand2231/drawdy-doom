import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasScreen, RESOLUTIONS } from "../../src/render/screen.ts";

const RECT = { x: 100, y: 50, width: 1280, height: 800 };
const make = (options) => {
    let n = 0;
    return new CanvasScreen(RECT, () => `cell-${n++}`, { cols: 8, rows: 5, samples: 1, ...options });
};

/** A frame buffer of one flat colour, BGRA. */
const solid = (width, height, [r, g, b]) => {
    const frame = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        frame[i * 4] = b;
        frame[i * 4 + 1] = g;
        frame[i * 4 + 2] = r;
        frame[i * 4 + 3] = 255;
    }
    return frame;
};

test("ids come from the host, never invented", () => {
    const screen = make();
    assert.equal(screen.cellCount, 40);
    assert.equal(screen.elements[0].drawdyElementId, "cell-0");
    assert.equal(screen.indexOfElement("cell-9"), 9);
    assert.equal(screen.indexOfElement("not-ours"), -1);
    assert.ok(screen.owns("cell-3"));
});

test("cells tile the rect with a bleed so no board colour shows through", () => {
    const screen = make({ bleed: 0.6 });
    const first = screen.elements[0];
    const last = screen.elements[39];
    assert.equal(first.x, RECT.x);
    assert.equal(first.y, RECT.y);
    assert.equal(first.width, RECT.width / 8 + 0.6);
    // Last cell starts one step short of the right/bottom edge.
    assert.equal(last.x, RECT.x + (RECT.width / 8) * 7);
    assert.equal(last.y, RECT.y + (RECT.height / 5) * 4);
});

test("cells are crisp rectangles, not sketchy rounded ones", () => {
    // Drawdy defaults shapes to roughness 1 and cornerRadius 12 — at cell size
    // that would turn every pixel into a wobbly circle.
    const cell = make().elements[0];
    assert.equal(cell.roughness, 0);
    assert.equal(cell.cornerRadius, 0);
    assert.equal(cell.fillStyle, "solid");
    assert.equal(cell.strokeWidth, 0);
});

test("a frame paints every cell, an identical frame paints none", () => {
    const screen = make();
    const frame = solid(64, 40, [200, 40, 40]);
    assert.equal(screen.ingest(frame, 64, 40), 40);
    assert.equal(screen.takeDirty().length, 40);
    assert.equal(screen.ingest(frame, 64, 40), 0);
    assert.equal(screen.takeDirty().length, 0);
});

test("colour actually reaches the element", () => {
    const screen = make();
    screen.ingest(solid(64, 40, [255, 0, 0]), 64, 40);
    assert.equal(screen.elements[0].fillColor, "#ff0000");
    // Stroke matches fill, so any hairline the renderer draws is invisible.
    assert.equal(screen.elements[0].strokeColor, "#ff0000");
});

test("quantisation swallows noise below the colour step", () => {
    const screen = make({ colorBits: 5 }); // 8 levels of slack per channel
    screen.ingest(solid(64, 40, [128, 128, 128]), 64, 40);
    screen.takeDirty();
    assert.equal(screen.ingest(solid(64, 40, [130, 129, 131]), 64, 40), 0, "dither must not count as movement");
    assert.ok(screen.ingest(solid(64, 40, [180, 128, 128]), 64, 40) > 0, "a real change must still land");
});

test("dirt accumulates across frames until it is taken", () => {
    // DOOM can draw several frames while one canvas update is still in flight;
    // dropping the earlier deltas would leave the screen torn.
    const screen = make();
    screen.ingest(solid(64, 40, [10, 10, 10]), 64, 40);
    screen.ingest(solid(64, 40, [20, 20, 20]), 64, 40);
    assert.equal(screen.pendingCells, 40, "still 40 distinct cells, not 80 entries");
    const batch = screen.takeDirty();
    assert.equal(batch.length, 40);
    assert.equal(new Set(batch.map((c) => c.drawdyElementId)).size, 40, "no duplicates");
    assert.equal(screen.pendingCells, 0);
});

test("invalidate forces a full repaint after the geometry moves", () => {
    const screen = make();
    const frame = solid(64, 40, [90, 90, 90]);
    screen.ingest(frame, 64, 40);
    screen.takeDirty();
    screen.setRect({ x: 0, y: 0, width: 640, height: 400 });
    screen.invalidate();
    assert.equal(screen.ingest(frame, 64, 40), 40);
    assert.equal(screen.elements[0].x, 0);
});

test("downsampling averages, so a checkerboard reads as its mean", () => {
    const screen = make({ cols: 1, rows: 1, samples: 2 });
    const frame = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
        const white = i % 2 === 0;
        frame[i * 4] = white ? 255 : 0;
        frame[i * 4 + 1] = white ? 255 : 0;
        frame[i * 4 + 2] = white ? 255 : 0;
        frame[i * 4 + 3] = 255;
    }
    screen.ingest(frame, 2, 2);
    const value = parseInt(screen.elements[0].fillColor.slice(1, 3), 16);
    assert.ok(value > 100 && value < 160, `expected mid grey, got ${screen.elements[0].fillColor}`);
});

test("a point in canvas space maps back to its cell", () => {
    const screen = make();
    assert.equal(screen.cellAt(RECT.x + 1, RECT.y + 1), 0);
    assert.equal(screen.cellAt(RECT.x + RECT.width - 1, RECT.y + RECT.height - 1), 39);
    assert.equal(screen.cellAt(RECT.x - 5, RECT.y), -1, "outside the screen");
});

test("every advertised resolution keeps DOOM's 16:10 shape", () => {
    for (const resolution of RESOLUTIONS) {
        const aspect = resolution.cols / resolution.rows;
        assert.ok(Math.abs(aspect - 1.6) < 0.02, `${resolution.id} is ${aspect.toFixed(3)}:1`);
    }
});

test("monochrome collapses the palette to its ramp", () => {
    const screen = make({ palette: "mono", shades: 8 });
    const seen = new Set();
    for (const value of [0, 40, 90, 140, 200, 255]) {
        screen.ingest(solid(64, 40, [value, value, value]), 64, 40);
        seen.add(screen.elements[0].fillColor);
    }
    assert.ok(seen.size <= 8, `expected at most 8 shades, saw ${seen.size}`);
    for (const hex of seen) {
        assert.equal(hex.slice(1, 3), hex.slice(3, 5), `${hex} should be neutral grey`);
        assert.equal(hex.slice(3, 5), hex.slice(5, 7));
    }
});

test("monochrome judges by luminance, not by any one channel", () => {
    const screen = make({ palette: "mono", shades: 32 });
    screen.ingest(solid(64, 40, [0, 255, 0]), 64, 40); // green is the bright one
    const green = screen.elements[0].fillColor;
    screen.ingest(solid(64, 40, [0, 0, 255]), 64, 40); // blue is much darker
    const blue = screen.elements[0].fillColor;
    assert.ok(parseInt(green.slice(1, 3), 16) > parseInt(blue.slice(1, 3), 16));
});

test("tinted palettes are the same ramp in a different colour", () => {
    const amber = make({ palette: "amber", shades: 8 });
    const green = make({ palette: "green", shades: 8 });
    const frame = solid(64, 40, [200, 200, 200]);
    // Same number of cells change: the tint is applied after quantisation, so
    // it cannot cost anything extra.
    assert.equal(amber.ingest(frame, 64, 40), green.ingest(frame, 64, 40));
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(amber.elements[0].fillColor.slice(i, i + 2), 16));
    assert.ok(r > g && g > b, `amber should fall off red > green > blue, got ${amber.elements[0].fillColor}`);
    const [gr, gg] = [1, 3].map((i) => parseInt(green.elements[0].fillColor.slice(i, i + 2), 16));
    assert.ok(gg > gr, "green phosphor should lead with green");
});

test("fewer shades means fewer cells change — the whole point", () => {
    // Any single step can happen to straddle a ramp boundary, so the claim is
    // about the aggregate: walk a slow brightness ramp and count how much each
    // one reports. This is exactly what a corridor's lighting does to the grid.
    const coarse = make({ cols: 16, rows: 10, palette: "mono", shades: 4 });
    const fine = make({ cols: 16, rows: 10, palette: "mono", shades: 48 });
    let coarseTotal = 0;
    let fineTotal = 0;
    for (let value = 60; value <= 200; value += 4) {
        const frame = solid(64, 40, [value, value, value]);
        coarseTotal += coarse.ingest(frame, 64, 40);
        fineTotal += fine.ingest(frame, 64, 40);
        coarse.takeDirty();
        fine.takeDirty();
    }
    assert.ok(coarseTotal > 0, "a coarse ramp still tracks real changes");
    assert.ok(
        coarseTotal * 4 < fineTotal,
        `4 shades should send far less than 48: ${coarseTotal} vs ${fineTotal}`
    );
});
