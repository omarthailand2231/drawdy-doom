/**
 * Save games, persisted through `command:kv-storage:*`.
 *
 * DOOM's save hooks are synchronous C calls and Drawdy's storage is an async
 * command, so the slots live in memory and are mirrored out to storage after
 * the fact. Hydrating at start-up means a save made yesterday is there when
 * the player opens the load menu today.
 */
import { base64ToBytes, bytesToBase64 } from "../bytes";
import { call } from "../protocol";
import type { SaveStore } from "./engine";

const KEY_PREFIX = "doom.save.";
/** DOOM has six save slots; ids come straight from the menu. */
export const SAVE_SLOTS = 6;
/** Refuse anything absurd rather than wedging the browser's storage. */
const MAX_SLOT_BYTES = 4 * 1024 * 1024;

export class KvSaveStore implements SaveStore {
    private readonly slots = new Map<number, Uint8Array>();
    private readonly flushing = new Set<number>();
    /** Set when storage refused us, so the UI can say saving is off. */
    denied = false;
    lastError: string | null = null;

    /** Pull existing saves into memory. Failure is not fatal — saving just won't persist. */
    async hydrate(): Promise<number> {
        let found = 0;
        for (let id = 0; id < SAVE_SLOTS; id++) {
            const outcome = await call("command:kv-storage:get", { key: `${KEY_PREFIX}${id}` });
            if (outcome.error) {
                if (outcome.error.type === "unauthorized") {
                    this.denied = true;
                    this.lastError = "storage permission denied";
                    return found;
                }
                continue;
            }
            const payload = outcome.value?.got as { data?: unknown } | undefined;
            if (typeof payload?.data !== "string") continue;
            try {
                this.slots.set(id, base64ToBytes(payload.data));
                found++;
            } catch {
                /* corrupt slot — ignore it rather than block the boot */
            }
        }
        return found;
    }

    size(id: number): number {
        return this.slots.get(id)?.length ?? 0;
    }

    read(id: number, into: Uint8Array): number {
        const data = this.slots.get(id);
        if (!data) return 0;
        const length = Math.min(data.length, into.length);
        into.set(data.subarray(0, length));
        return length;
    }

    write(id: number, data: Uint8Array): number {
        if (data.length > MAX_SLOT_BYTES) {
            this.lastError = `save slot ${id} is ${data.length} bytes — refusing`;
            return 0;
        }
        this.slots.set(id, data);
        void this.flush(id);
        return data.length;
    }

    slotsInUse(): number[] {
        return [...this.slots.keys()].sort((a, b) => a - b);
    }

    async clear(id: number): Promise<void> {
        this.slots.delete(id);
        await call("command:kv-storage:delete", { key: `${KEY_PREFIX}${id}` });
    }

    private async flush(id: number): Promise<void> {
        if (this.flushing.has(id)) return; // a later write will carry the newest bytes
        this.flushing.add(id);
        try {
            const data = this.slots.get(id);
            if (!data) return;
            const outcome = await call("command:kv-storage:set", {
                key: `${KEY_PREFIX}${id}`,
                payload: { data: bytesToBase64(data), bytes: data.length, at: Date.now() },
            });
            if (outcome.error) {
                this.denied = outcome.error.type === "unauthorized";
                this.lastError = outcome.error.message ?? outcome.error.type;
            }
        } finally {
            this.flushing.delete(id);
        }
    }
}
