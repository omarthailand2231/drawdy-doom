/**
 * Turning Drawdy's key *presses* into DOOM's key *holds*.
 *
 * `subscription:keyboard:control-keys` never reports a release, so holding a
 * key has to be inferred. A press holds the key for a window; the operating
 * system's own key repeat re-arms that window while the key stays down, so a
 * held arrow walks continuously and a tap is a short step. The first window is
 * deliberately long enough to bridge the OS's initial repeat delay (typically
 * ~500 ms) — without that, every walk would stutter once at the start.
 *
 * Input that already knows when it ends — real keydown/keyup from the console
 * webview, or a pointer held down over the screen — bypasses all of this and is
 * tracked per owner, so losing console focus drops exactly the keys the console
 * was holding and leaves the pointer's (and the board's) alone.
 */
import type { DoomEngine } from "./doom/engine";
import type { KeyName } from "./doom/keys";

export interface HoldTimings {
    /** Held this long on the first press — long enough to bridge OS repeat delay. */
    firstMs: number;
    /** Held this long once the OS is repeating and the key is clearly down. */
    repeatMs: number;
}

export const DEFAULT_HOLD_TIMINGS: HoldTimings = { firstMs: 430, repeatMs: 190 };

export class InputRouter {
    timings: HoldTimings = { ...DEFAULT_HOLD_TIMINGS };

    /** doomKey -> wall-clock ms at which the synthesised hold lapses. */
    private readonly expiries = new Map<number, number>();
    /** owner -> keys that owner is physically holding; never released on a timer. */
    private readonly owned = new Map<string, Set<number>>();
    /** 1..7, remembered so Ctrl+arrow can cycle without reading game state. */
    private weaponSlot = 2;

    private readonly engine: DoomEngine;

    // Written out rather than a constructor parameter property: those are not
    // erasable TypeScript, and the tests import these modules straight into
    // Node, which only strips types.
    constructor(engine: DoomEngine) {
        this.engine = engine;
    }

    private keyValue(name: KeyName): number {
        return this.engine.keys[name];
    }

    /** A synthesised press from the board: hold it, then let it lapse. */
    press(names: KeyName[], now: number): void {
        for (const name of names) this.pressRaw(this.keyValue(name), now);
    }

    pressRaw(key: number, now: number): void {
        const alreadyHeld = this.expiries.has(key);
        this.expiries.set(key, now + (alreadyHeld ? this.timings.repeatMs : this.timings.firstMs));
        this.engine.keyDown(key);
    }

    /** Keep a modifier in step with its flag so letting go of Shift stops the run at once. */
    syncModifier(name: KeyName, active: boolean, now: number): void {
        const key = this.keyValue(name);
        if (active) this.pressRaw(key, now);
        else if (this.expiries.delete(key) && !this.isOwned(key)) this.engine.keyUp(key);
    }

    /** Tap a weapon slot (1..7); DOOM ignores slots the player has not picked up. */
    selectWeapon(slot: number, now: number): number {
        const clamped = ((((slot - 1) % 7) + 7) % 7) + 1;
        this.weaponSlot = clamped;
        this.pressRaw(0x30 + clamped, now);
        return clamped;
    }

    cycleWeapon(step: number, now: number): number {
        return this.selectWeapon(this.weaponSlot + step, now);
    }

    private isOwned(key: number, except?: string): boolean {
        for (const [owner, keys] of this.owned) {
            if (owner !== except && keys.has(key)) return true;
        }
        return false;
    }

    /** A press whose release we will genuinely be told about (console key, pointer). */
    holdExternal(owner: string, key: number): void {
        let keys = this.owned.get(owner);
        if (!keys) this.owned.set(owner, (keys = new Set()));
        keys.add(key);
        this.engine.keyDown(key);
    }

    releaseExternal(owner: string, key: number): void {
        if (!this.owned.get(owner)?.delete(key)) return;
        // A synthesised hold, or another owner, may still want the key down.
        if (!this.expiries.has(key) && !this.isOwned(key)) this.engine.keyUp(key);
    }

    /** That owner went away (console lost focus, pointer left the screen). */
    releaseOwner(owner: string): void {
        const keys = this.owned.get(owner);
        if (!keys) return;
        for (const key of [...keys]) this.releaseExternal(owner, key);
        this.owned.delete(owner);
    }

    /** Release every synthesised hold whose window has closed. Call each frame. */
    expire(now: number): void {
        if (this.expiries.size === 0) return;
        for (const [key, expiry] of [...this.expiries]) {
            if (expiry > now) continue;
            this.expiries.delete(key);
            if (!this.isOwned(key)) this.engine.keyUp(key);
        }
    }

    releaseAll(): void {
        this.expiries.clear();
        this.owned.clear();
        this.engine.releaseAll();
    }

    get heldCount(): number {
        return this.engine.heldKeys().length;
    }
}
