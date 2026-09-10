/**
 * Wrap setTimeout before the driver bundle loads, to see how its game loop is
 * actually being scheduled.
 *
 * This earned its place: when the frame rate was a fifth of what it should
 * have been, this is what proved the loop was firing on time (262 timers,
 * median 0.5 ms late) and that the loss was downstream, not in the pacing.
 */
const realSetTimeout = globalThis.setTimeout;
const delays = new Map();
const lateness = [];
let scheduled = 0;
let fired = 0;

/** Only game-loop-sized delays; longer timers are someone else's business. */
const LOOP_DELAY_CEILING_MS = 40;

globalThis.setTimeout = function (callback, delay, ...rest) {
    if (typeof delay !== "number" || delay > LOOP_DELAY_CEILING_MS) {
        return realSetTimeout.call(this, callback, delay, ...rest);
    }
    scheduled++;
    const bucket = Math.round(delay);
    delays.set(bucket, (delays.get(bucket) ?? 0) + 1);
    const due = performance.now() + delay;
    return realSetTimeout.call(
        this,
        function (...args) {
            fired++;
            lateness.push(performance.now() - due);
            return callback.apply(this, args);
        },
        delay,
        ...rest
    );
};

export function timerReport() {
    const sorted = [...lateness].sort((a, b) => a - b);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    return {
        scheduled,
        fired,
        commonDelays: [...delays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        latenessMedianMs: Number((at(0.5) ?? 0).toFixed(2)),
        latenessP90Ms: Number((at(0.9) ?? 0).toFixed(2)),
        latenessMaxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    };
}
