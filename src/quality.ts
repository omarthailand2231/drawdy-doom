/**
 * Auto quality.
 *
 * When the board cannot keep up, something has to give — but not all quality
 * is equally precious. Resolution is the thing a player notices first, and
 * colour depth is the thing they notice last, so the ladder spends colour
 * before it spends pixels:
 *
 *   colour depth  →  fewer shades / fewer bits per channel
 *   resolution    →  one grid size down
 *
 * Both directions are gated on sustained evidence rather than a single slow
 * frame, and recovery never climbs above what the player actually asked for.
 */
import type { PaletteMode, ResolutionId } from "./render/screen";

/** The grid sizes to walk, coarsest first. Supplied by the caller so this
 *  module stays pure policy with no dependency on the renderer. */
export interface ResolutionStep {
    id: ResolutionId;
    label: string;
}

/** A draw slower than this means we are behind. */
export const SLOW_UPDATE_MS = 45;
/** A draw faster than this is headroom we could spend on quality. */
export const FAST_UPDATE_MS = 18;
/** Consecutive slow draws before stepping down. */
const DOWN_STREAK = 20;
/** Consecutive fast draws before stepping back up — deliberately much longer. */
const UP_STREAK = 400;

const SHADE_LADDER = [6, 8, 12, 16, 24, 32, 48] as const;
const BIT_LADDER = [4, 5, 6] as const;

export interface QualityLevel {
    resolution: ResolutionId;
    shades: number;
    colorBits: number;
}

/** How far down each axis can go before the next axis gives way. */
const FLOOR = { shades: SHADE_LADDER[0], colorBits: BIT_LADDER[0] };



function stepLadder(ladder: readonly number[], value: number, direction: -1 | 1): number | null {
    // Snap to the ladder first: a hand-set value need not be on it.
    let index = ladder.findIndex((step) => step >= value);
    if (index < 0) index = ladder.length - 1;
    else if (ladder[index] !== value && direction < 0) index = Math.max(0, index);
    const next = index + direction;
    if (next < 0 || next >= ladder.length) return null;
    const candidate = ladder[next]!;
    return candidate === value ? null : candidate;
}

export class QualityGovernor {
    /** What the player asked for; recovery never exceeds it. */
    ceiling: QualityLevel;
    /** What is actually in use. */
    current: QualityLevel;

    private slowStreak = 0;
    private fastStreak = 0;
    private readonly ladder: readonly ResolutionStep[];

    constructor(ceiling: QualityLevel, ladder: readonly ResolutionStep[]) {
        this.ceiling = { ...ceiling };
        this.current = { ...ceiling };
        this.ladder = ladder;
    }

    private resolutionIndex(id: ResolutionId): number {
        return this.ladder.findIndex((step) => step.id === id);
    }

    /** The player changed a setting: that is the new ceiling, and the new level. */
    reset(ceiling: QualityLevel): void {
        this.ceiling = { ...ceiling };
        this.current = { ...ceiling };
        this.slowStreak = 0;
        this.fastStreak = 0;
    }

    get degraded(): boolean {
        return (
            this.current.resolution !== this.ceiling.resolution ||
            this.current.shades !== this.ceiling.shades ||
            this.current.colorBits !== this.ceiling.colorBits
        );
    }

    /**
     * Feed in how long the last draw took.
     *
     * @returns a description of what changed, or null if nothing did.
     */
    observe(elapsedMs: number, palette: PaletteMode): string | null {
        if (elapsedMs > SLOW_UPDATE_MS) {
            this.fastStreak = 0;
            if (++this.slowStreak < DOWN_STREAK) return null;
            this.slowStreak = 0;
            return this.stepDown(palette, elapsedMs);
        }
        if (elapsedMs < FAST_UPDATE_MS) {
            this.slowStreak = 0;
            if (++this.fastStreak < UP_STREAK) return null;
            this.fastStreak = 0;
            return this.stepUp(palette);
        }
        this.slowStreak = 0;
        this.fastStreak = 0;
        return null;
    }

    private stepDown(palette: PaletteMode, elapsedMs: number): string | null {
        const cost = `drawing is taking ${elapsedMs.toFixed(0)} ms`;

        if (palette !== "color" && this.current.shades > FLOOR.shades) {
            const next = stepLadder(SHADE_LADDER, this.current.shades, -1);
            if (next !== null) {
                this.current.shades = next;
                return `${cost} — down to ${next} shades`;
            }
        }
        if (palette === "color" && this.current.colorBits > FLOOR.colorBits) {
            const next = stepLadder(BIT_LADDER, this.current.colorBits, -1);
            if (next !== null) {
                this.current.colorBits = next;
                return `${cost} — down to ${next} bits of colour`;
            }
        }
        const index = this.resolutionIndex(this.current.resolution);
        if (index > 0) {
            const next = this.ladder[index - 1]!;
            this.current.resolution = next.id;
            return `${cost} — down to ${next.label}`;
        }
        return null;
    }

    private stepUp(palette: PaletteMode): string | null {
        // Climb back in the reverse order it was spent: pixels first, then colour.
        const index = this.resolutionIndex(this.current.resolution);
        if (index < this.resolutionIndex(this.ceiling.resolution)) {
            const next = this.ladder[index + 1]!;
            this.current.resolution = next.id;
            return `room to spare — back up to ${next.label}`;
        }
        if (palette === "color" && this.current.colorBits < this.ceiling.colorBits) {
            const next = stepLadder(BIT_LADDER, this.current.colorBits, 1);
            if (next !== null && next <= this.ceiling.colorBits) {
                this.current.colorBits = next;
                return `room to spare — back up to ${next} bits of colour`;
            }
        }
        if (palette !== "color" && this.current.shades < this.ceiling.shades) {
            const next = stepLadder(SHADE_LADDER, this.current.shades, 1);
            if (next !== null && next <= this.ceiling.shades) {
                this.current.shades = next;
                return `room to spare — back up to ${next} shades`;
            }
        }
        return null;
    }
}
