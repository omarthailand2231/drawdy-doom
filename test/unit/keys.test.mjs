import assert from "node:assert/strict";
import { test } from "node:test";
import { bindControlKey, asciiKey, isKeyName, CONTROL_SCHEME } from "../../src/doom/keys.ts";

const event = (key, modifiers = {}) => ({
    key,
    shift: false,
    ctrl: false,
    meta: false,
    alt: false,
    ...modifiers,
});

test("arrows walk and turn", () => {
    assert.deepEqual(bindControlKey(event("arrow-up")).keys, ["UPARROW"]);
    assert.deepEqual(bindControlKey(event("arrow-down")).keys, ["DOWNARROW"]);
    assert.deepEqual(bindControlKey(event("arrow-left")).keys, ["LEFTARROW"]);
});

test("alt is handed to DOOM as its own strafe modifier, not translated", () => {
    // DOOM's KEY_ALT already means "strafe instead of turn", so the arrow must
    // stay an arrow — rewriting it to STRAFE_L would double up.
    const binding = bindControlKey(event("arrow-left", { alt: true }));
    assert.deepEqual(binding.keys, ["ALT", "LEFTARROW"]);
    assert.match(binding.describe, /strafe/);
});

test("shift rides along as run", () => {
    assert.deepEqual(bindControlKey(event("arrow-up", { shift: true })).keys, ["SHIFT", "UPARROW"]);
});

test("space fires, shift+space uses", () => {
    assert.deepEqual(bindControlKey(event("space")).keys, ["FIRE"]);
    assert.deepEqual(bindControlKey(event("space", { shift: true })).keys, ["SHIFT", "USE"]);
});

test("enter covers both menu confirm and door opening", () => {
    // In a menu the ENTER selects and the USE is inert; in game the USE opens
    // and the ENTER is inert. One key, no modes for the player to track.
    assert.deepEqual(bindControlKey(event("enter")).keys, ["ENTER", "USE"]);
});

test("ctrl+arrow cycles weapons instead of holding a key", () => {
    assert.equal(bindControlKey(event("arrow-up", { ctrl: true })).weaponStep, 1);
    assert.equal(bindControlKey(event("arrow-down", { ctrl: true })).weaponStep, -1);
    assert.deepEqual(bindControlKey(event("arrow-up", { ctrl: true })).keys, []);
});

test("delete and backspace both mean back", () => {
    assert.deepEqual(bindControlKey(event("delete")).keys, ["BACKSPACE"]);
    assert.deepEqual(bindControlKey(event("backspace")).keys, ["BACKSPACE"]);
});

test("unknown control keys are ignored rather than guessed at", () => {
    assert.equal(bindControlKey(event("f13")), null);
});

test("printable keys map to ASCII, which is how digits pick weapons", () => {
    assert.equal(asciiKey("1"), 0x31);
    assert.equal(asciiKey("W"), 0x77); // lowercased
    assert.equal(asciiKey("ab"), null);
});

test("key names are validated before being trusted from the webview", () => {
    assert.ok(isKeyName("FIRE"));
    assert.ok(!isKeyName("EXEC"));
    assert.ok(!isKeyName(42));
});

test("the documented scheme is not empty", () => {
    assert.ok(CONTROL_SCHEME.length >= 8);
});
