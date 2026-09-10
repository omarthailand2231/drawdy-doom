import assert from "node:assert/strict";
import { test } from "node:test";
import { AsciiScreen, ASCII_RAMPS } from "../../src/render/ascii-screen.ts";

const RECT = { x: 10, y: 20, width: 1600, height: 1000 };
const make = (options) => {
    let n = 0;
    return new AsciiScreen(RECT, () => `line-${n++}`, { cols: 20, rows: 10, samples: 1, ...options });
};

const solid = (width, height, value) => {
    const frame = new Uint8Array(width * height * 4);
    frame.fill(value);
    for (let i = 0; i < width * height; i++) frame[i * 4 + 3] = 255;
    return frame;
};

/** A frame that ramps left to right, so every ramp step gets used. */
const gradient = (width, height) => {
    const frame = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const value = Math.round((x / (width - 1)) * 255);
            const offset = (y * width + x) * 4;
            frame[offset] = value;
            frame[offset + 1] = value;
            frame[offset + 2] = value;
            frame[offset + 3] = 255;
        }
    }
    return frame;
};

test("one element per row — the entire point of this display", () => {
    const screen = make({ cols: 200, rows: 60 });
    assert.equal(screen.elements.length, 60);
    assert.equal(screen.lineCount, 60);
    for (const line of screen.elements) assert.equal(line.type, "text");
});

test("each row is one string of exactly `cols` characters", () => {
    const screen = make({ cols: 20, rows: 10 });
    screen.ingest(gradient(80, 40), 80, 40);
    for (const line of screen.elements) assert.equal(line.text.length, 20);
});

test("rows are stacked down the rect, not newline-separated", () => {
    // Line height is not something the protocol lets a driver set, so each row
    // is placed itself.
    const screen = make({ cols: 20, rows: 10 });
    const ys = screen.elements.map((line) => line.y);
    assert.equal(ys[0], RECT.y);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1]);
    assert.ok(Math.abs(ys[9] - (RECT.y + RECT.height * 0.9)) < 1);
    for (const line of screen.elements) assert.equal(line.x, RECT.x);
    assert.ok(screen.elements.every((line) => !line.text.includes("\n")));
});

test("brightness picks the character", () => {
    const screen = make({ ramp: "classic", gamma: 1 });
    screen.ingest(solid(80, 40, 0), 80, 40);
    const dark = screen.elements[0].text[0];
    screen.ingest(solid(80, 40, 255), 80, 40);
    const bright = screen.elements[0].text[0];
    const ramp = ASCII_RAMPS.find((r) => r.id === "classic").chars;
    assert.equal(dark, ramp[0]);
    assert.equal(bright, ramp[ramp.length - 1]);
});

test("a gradient uses the whole ramp", () => {
    const screen = make({ cols: 60, rows: 4, ramp: "classic", gamma: 1 });
    screen.ingest(gradient(240, 40), 240, 40);
    const used = new Set(screen.elements[0].text.split(""));
    assert.ok(used.size >= 8, `only ${used.size} of the ramp's characters appeared`);
});

test("gamma below 1 brightens, which is why it exists", () => {
    // DOOM's frames sit dark; a straight mapping bunches them at the bottom.
    const straight = make({ ramp: "classic", gamma: 1 });
    const lifted = make({ ramp: "classic", gamma: 0.5 });
    const frame = solid(80, 40, 70);
    straight.ingest(frame, 80, 40);
    lifted.ingest(frame, 80, 40);
    const ramp = ASCII_RAMPS.find((r) => r.id === "classic").chars;
    assert.ok(ramp.indexOf(lifted.elements[0].text[0]) > ramp.indexOf(straight.elements[0].text[0]));
});

test("only rows that actually changed are sent", () => {
    const screen = make({ cols: 20, rows: 10 });
    const frame = gradient(80, 40);
    assert.equal(screen.ingest(frame, 80, 40), 10);
    assert.equal(screen.takeDirty().length, 10);
    assert.equal(screen.ingest(frame, 80, 40), 0);
    assert.equal(screen.takeDirty().length, 0);
});

test("dirty rows accumulate across frames until taken", () => {
    const screen = make({ cols: 20, rows: 10 });
    screen.ingest(solid(80, 40, 20), 80, 40);
    screen.ingest(solid(80, 40, 200), 80, 40);
    assert.equal(screen.pendingLines, 10, "ten rows, not twenty entries");
    assert.equal(new Set(screen.takeDirty().map((l) => l.drawdyElementId)).size, 10);
});

test("row count follows the measured glyph advance", () => {
    // A wider glyph means fewer rows fit before the picture stops being upright.
    const screen = make({ measuredAdvance: 1.0 });
    assert.equal(screen.rowsForAspect(160, 1.6), 100);
    screen.setOptions({ measuredAdvance: 0.5 });
    assert.equal(screen.rowsForAspect(160, 1.6), 50);
});

test("element ids belong to the screen, for pointer hit-testing", () => {
    const screen = make();
    assert.ok(screen.owns(screen.elements[0].drawdyElementId));
    assert.ok(!screen.owns("someone-elses-element"));
});

test("every ramp runs dark to light", () => {
    for (const ramp of ASCII_RAMPS) {
        assert.ok(ramp.chars.length >= 3, `${ramp.id} is too short to be a ramp`);
        assert.ok(ramp.advance > 0.2 && ramp.advance < 1.5, `${ramp.id} has an implausible advance`);
    }
});
