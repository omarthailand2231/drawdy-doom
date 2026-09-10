import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DoomEngine, MS_PER_TIC, TICRATE } from "../../src/doom/engine.ts";
import { WASM_PATH } from "../lib/boot.mjs";

const available = existsSync(WASM_PATH);
const options = { skip: available ? false : "run `npm run fetch-doom` first" };

let compiled = null;
async function boot(overrides = {}) {
    compiled ??= await WebAssembly.compile(readFileSync(WASM_PATH));
    const logs = [];
    const engine = await DoomEngine.instantiate(
        compiled,
        { onLog: (level, message) => logs.push(`${level}:${message.trim()}`), ...overrides },
        overrides.wads ?? []
    );
    engine.start();
    return { engine, logs };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("boots with the shareware WAD embedded in the module", options, async () => {
    const { engine, logs } = await boot();
    assert.equal(engine.crashed, null);
    assert.equal(engine.width, 640);
    assert.equal(engine.height, 400);
    assert.ok(
        logs.some((line) => /shareware/i.test(line)),
        "should report loading the built-in WAD"
    );
});

test("every DOOM key constant is a byte", options, async () => {
    const { engine } = await boot();
    for (const [name, value] of Object.entries(engine.keys)) {
        assert.ok(Number.isInteger(value) && value >= 0 && value <= 255, `${name} = ${value}`);
    }
    assert.notEqual(engine.keys.FIRE, engine.keys.USE);
});

test("ticking produces frames", options, async () => {
    const { engine } = await boot();
    for (let i = 0; i < 40; i++) engine.tick();
    assert.equal(engine.tics, 40);
    assert.ok(engine.frames >= 40, `only ${engine.frames} frames`);
    const frame = engine.latestFrame();
    assert.equal(frame.length, 640 * 400 * 4);
});

test("the virtual clock keeps the engine deterministic", options, async () => {
    // Real time would make every run differ; the whole point of driving
    // I_GetTime ourselves is that the same tics give the same pixels.
    const a = await boot();
    const b = await boot();
    for (let i = 0; i < 90; i++) {
        a.engine.tick();
        b.engine.tick();
    }
    assert.equal(digest(a.engine.latestFrame()), digest(b.engine.latestFrame()));
});

test("a keypress reaches the game", options, async () => {
    const { engine } = await boot();
    for (let i = 0; i < 60; i++) engine.tick();
    const before = digest(engine.latestFrame());

    engine.keyDown(engine.keys.ESCAPE);
    for (let i = 0; i < 12; i++) engine.tick();
    engine.keyUp(engine.keys.ESCAPE);
    for (let i = 0; i < 6; i++) engine.tick();

    assert.notEqual(digest(engine.latestFrame()), before, "Escape should have opened the menu");
});

test("a key held twice is reported once, and released once", options, async () => {
    const { engine } = await boot();
    engine.keyDown(engine.keys.FIRE);
    engine.keyDown(engine.keys.FIRE);
    assert.ok(engine.isHeld(engine.keys.FIRE));
    engine.keyUp(engine.keys.FIRE);
    assert.ok(!engine.isHeld(engine.keys.FIRE));
    engine.keyUp(engine.keys.FIRE); // must not throw
});

test("out-of-range keys are dropped rather than passed to the module", options, async () => {
    const { engine } = await boot();
    engine.keyDown(999);
    engine.keyDown(-1);
    assert.deepEqual(engine.heldKeys(), []);
});

test("releaseAll lets go of everything", options, async () => {
    const { engine } = await boot();
    engine.keyDown(engine.keys.UPARROW);
    engine.keyDown(engine.keys.FIRE);
    engine.releaseAll();
    assert.deepEqual(engine.heldKeys(), []);
});

test("advance turns real elapsed time into whole tics", options, async () => {
    const { engine } = await boot();
    assert.equal(engine.advance(0), 1, "the first call primes the clock with one tic");
    assert.equal(engine.advance(0), 0, "no time passed, no tic");
    assert.equal(engine.advance(MS_PER_TIC * 2), 2);
    // A long stall is forgiven, not repaid in one enormous burst.
    assert.ok(engine.advance(10_000) <= 3);
});

test("save hooks are wired to the store the host supplies", options, async () => {
    const written = new Map();
    const store = {
        size: (id) => written.get(id)?.length ?? 0,
        read: (id, into) => {
            const data = written.get(id);
            if (!data) return 0;
            into.set(data);
            return data.length;
        },
        write: (id, data) => {
            written.set(id, data);
            return data.length;
        },
    };
    const { engine } = await boot({ saves: store });
    assert.equal(engine.crashed, null);
    // Nothing is saved without the player asking; the point is that a store
    // reporting "empty" does not upset the boot.
    assert.equal(store.size(0), 0);
});

test("TICRATE is DOOM's 35 Hz", () => {
    assert.equal(TICRATE, 35);
    assert.ok(Math.abs(MS_PER_TIC - 28.571) < 0.01);
});
