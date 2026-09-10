import assert from "node:assert/strict";
import { test } from "node:test";
import { InputRouter, DEFAULT_HOLD_TIMINGS } from "../../src/input.ts";

/** Stands in for DoomEngine: records what the game would have been told. */
function fakeEngine() {
    const held = new Set();
    const log = [];
    return {
        keys: {
            LEFTARROW: 172, RIGHTARROW: 174, UPARROW: 173, DOWNARROW: 175,
            STRAFE_L: 160, STRAFE_R: 161, FIRE: 163, USE: 162,
            SHIFT: 182, TAB: 9, ESCAPE: 27, ENTER: 13, BACKSPACE: 127, ALT: 184,
        },
        held,
        log,
        keyDown(key) {
            if (held.has(key)) return;
            held.add(key);
            log.push(`down ${key}`);
        },
        keyUp(key) {
            if (!held.delete(key)) return;
            log.push(`up ${key}`);
        },
        releaseAll() {
            for (const key of [...held]) this.keyUp(key);
        },
        heldKeys: () => [...held],
    };
}

test("a press is held, then released when its window closes", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.press(["UPARROW"], 1000);
    assert.ok(engine.held.has(173));
    input.expire(1000 + DEFAULT_HOLD_TIMINGS.firstMs - 1);
    assert.ok(engine.held.has(173), "must not let go early");
    input.expire(1000 + DEFAULT_HOLD_TIMINGS.firstMs);
    assert.ok(!engine.held.has(173));
});

test("the first window bridges the OS key-repeat delay, later ones are short", () => {
    // Without a long first window every walk stutters once: the key is released
    // before the operating system starts repeating it.
    assert.ok(DEFAULT_HOLD_TIMINGS.firstMs > 400);
    assert.ok(DEFAULT_HOLD_TIMINGS.repeatMs < DEFAULT_HOLD_TIMINGS.firstMs);

    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.press(["UPARROW"], 0);
    input.press(["UPARROW"], 100); // an OS repeat arrives
    input.expire(100 + DEFAULT_HOLD_TIMINGS.repeatMs);
    assert.ok(!engine.held.has(173), "a repeat re-arms with the short window");
});

test("holding a key does not re-report it to DOOM", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.press(["FIRE"], 0);
    input.press(["FIRE"], 10);
    input.press(["FIRE"], 20);
    assert.deepEqual(engine.log, ["down 163"]);
});

test("modifiers track their flag instead of waiting out a timer", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.syncModifier("SHIFT", true, 0);
    assert.ok(engine.held.has(182));
    input.syncModifier("SHIFT", false, 5);
    assert.ok(!engine.held.has(182), "letting go of Shift must stop the run at once");
});

test("weapon slots wrap around 1..7", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    assert.equal(input.selectWeapon(3, 0), 3);
    assert.ok(engine.held.has(0x33), "sends ASCII '3'");
    assert.equal(input.cycleWeapon(1, 0), 4);
    assert.equal(input.selectWeapon(7, 0), 7);
    assert.equal(input.cycleWeapon(1, 0), 1, "7 wraps to 1");
    assert.equal(input.cycleWeapon(-1, 0), 7, "1 wraps back to 7");
});

test("an owner's keys are released when that owner goes away", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.holdExternal("console", 163);
    input.holdExternal("pointer", 172);
    input.releaseOwner("console");
    assert.ok(!engine.held.has(163), "console let go");
    assert.ok(engine.held.has(172), "the pointer is still steering");
});

test("two owners on one key: the last one out turns off the light", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.holdExternal("console", 163);
    input.holdExternal("pointer", 163);
    input.releaseExternal("console", 163);
    assert.ok(engine.held.has(163), "the pointer still wants it down");
    input.releaseExternal("pointer", 163);
    assert.ok(!engine.held.has(163));
});

test("a timed hold does not cancel a key someone is physically holding", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.holdExternal("console", 173); // real keydown, no keyup yet
    input.pressRaw(173, 0); // board synthesised the same key
    input.expire(10_000); // the synthesised window lapses
    assert.ok(engine.held.has(173), "the physical hold survives the timer");
});

test("releaseAll clears everything", () => {
    const engine = fakeEngine();
    const input = new InputRouter(engine);
    input.press(["UPARROW"], 0);
    input.holdExternal("console", 163);
    input.releaseAll();
    assert.equal(engine.held.size, 0);
    assert.equal(input.heldCount, 0);
});
