import assert from "node:assert/strict";
import { test } from "node:test";
import { QualityGovernor, SLOW_UPDATE_MS, FAST_UPDATE_MS } from "../../src/quality.ts";

const LADDER = [
    { id: "tiny", label: "Tiny" },
    { id: "small", label: "Small" },
    { id: "medium", label: "Medium" },
    { id: "large", label: "Large" },
    { id: "insane", label: "Insane" },
];
const ceiling = () => ({ resolution: "large", shades: 16, colorBits: 6 });
const grind = (governor, ms, palette, times) => {
    let last = null;
    for (let i = 0; i < times; i++) last = governor.observe(ms, palette) ?? last;
    return last;
};

test("a single slow frame changes nothing", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    assert.equal(governor.observe(SLOW_UPDATE_MS + 50, "mono"), null);
    assert.ok(!governor.degraded);
});

test("sustained slowness spends colour before it spends pixels", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    const message = grind(governor, 90, "mono", 20);
    assert.match(message, /shades/);
    assert.equal(governor.current.resolution, "large", "resolution is the last thing to go");
    assert.ok(governor.current.shades < 16);
});

test("colour mode spends bits per channel instead of shades", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    const message = grind(governor, 90, "color", 20);
    assert.match(message, /bits of colour/);
    assert.equal(governor.current.colorBits, 5);
    assert.equal(governor.current.resolution, "large");
});

test("resolution goes only once colour has bottomed out", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    // 16 -> 12 -> 8 -> 6 is three steps; the fourth is the first to cost pixels.
    grind(governor, 90, "mono", 20 * 3);
    assert.equal(governor.current.shades, 6, "shade floor reached");
    assert.equal(governor.current.resolution, "large", "pixels still untouched");
    grind(governor, 90, "mono", 20);
    assert.equal(governor.current.resolution, "medium", "then, and only then, pixels");
});

test("it bottoms out rather than degrading forever", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    grind(governor, 500, "mono", 2000);
    assert.equal(governor.current.shades, 6);
    assert.equal(governor.current.resolution, "tiny");
});

test("a fast streak has to be sustained far longer than a slow one", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    grind(governor, 90, "mono", 20);
    const degraded = governor.current.shades;
    grind(governor, FAST_UPDATE_MS - 5, "mono", 50);
    assert.equal(governor.current.shades, degraded, "must not bounce straight back");
    grind(governor, FAST_UPDATE_MS - 5, "mono", 400);
    assert.ok(governor.current.shades > degraded, "but it does recover eventually");
});

test("recovery never climbs past what the player asked for", () => {
    const governor = new QualityGovernor({ resolution: "small", shades: 8, colorBits: 5 }, LADDER);
    grind(governor, 1, "mono", 5000);
    assert.equal(governor.current.shades, 8);
    assert.equal(governor.current.resolution, "small");
    assert.ok(!governor.degraded);
});

test("an in-between frame rate settles on neither streak", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    grind(governor, (SLOW_UPDATE_MS + FAST_UPDATE_MS) / 2, "mono", 2000);
    assert.ok(!governor.degraded);
});

test("changing a setting makes it the new ceiling", () => {
    const governor = new QualityGovernor(ceiling(), LADDER);
    grind(governor, 90, "mono", 400);
    assert.ok(governor.degraded);
    governor.reset({ resolution: "medium", shades: 12, colorBits: 6 });
    assert.ok(!governor.degraded);
    assert.equal(governor.current.shades, 12);
});

test("it stops at the bottom instead of reporting phantom changes", () => {
    const governor = new QualityGovernor({ resolution: "tiny", shades: 6, colorBits: 4 }, LADDER);
    assert.equal(grind(governor, 500, "mono", 2000), null);
    assert.equal(governor.current.resolution, "tiny");
});
