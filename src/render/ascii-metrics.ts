/**
 * Measuring the board's font.
 *
 * ASCII output needs to know how wide a glyph is, and the protocol has no
 * font-family field — a driver cannot ask for monospace, or even find out what
 * it got. Guessing an advance ratio means the picture either falls short of
 * the right edge or runs past it.
 *
 * But the host will measure text for us. Put a couple of throwaway text
 * elements on the board, ask `command:scene:element-rects` how big they came
 * out, and the answer falls out: width / (characters x font size) is the
 * advance, and two different strings of the same length coming back the same
 * width means the font is monospaced and the columns will hold.
 *
 * Best effort by design. If the host will not measure preview elements the
 * caller keeps its configured defaults, which are chosen to be reasonable.
 */
import { call } from "../protocol";

export interface FontMetrics {
    /** Glyph width as a fraction of font size. */
    advance: number;
    /** True when different characters came back the same width. */
    monospaced: boolean;
    /** How the numbers were arrived at, for the console. */
    source: "measured" | "assumed";
}

const SAMPLE_LENGTH = 24;
const PROBE_FONT_SIZE = 100;
/** Widths within this fraction of each other count as equal. */
const SAME_WIDTH = 0.02;

/**
 * @param mintId host id minter
 * @param sample characters to measure with — pass the ramp actually in use
 */
export async function measureFont(mintId: () => string, sample: string): Promise<FontMetrics | null> {
    const uniform = (sample[sample.length - 1] ?? "#").repeat(SAMPLE_LENGTH);
    // A mixed string of the same length: same width means uniform advance.
    let mixed = "";
    for (let i = 0; i < SAMPLE_LENGTH; i++) mixed += sample[i % sample.length];

    const uniformId = mintId();
    const mixedId = mintId();
    const common = {
        type: "text" as const,
        // Parked far off-screen: measured, never seen.
        y: -1e6,
        fontSize: PROBE_FONT_SIZE,
        color: "#000000",
    };

    const created = await call("command:scene:create-drawdy-preview-elements", {
        elements: [
            { ...common, drawdyElementId: uniformId, x: -1e6, text: uniform },
            { ...common, drawdyElementId: mixedId, x: -1e6, text: mixed },
        ],
    });
    if (created.error) return null;

    try {
        const rects = await call("command:scene:element-rects", {
            drawdyElementIds: [uniformId, mixedId],
        });
        if (rects.error) return null;

        const widthOf = (id: string): number | null =>
            rects.value.rects.find((entry) => entry.drawdyElementId === id)?.rect.width ?? null;
        const uniformWidth = widthOf(uniformId);
        const mixedWidth = widthOf(mixedId);
        if (!uniformWidth || uniformWidth <= 0) return null;

        const advance = uniformWidth / (SAMPLE_LENGTH * PROBE_FONT_SIZE);
        // A sane advance is roughly 0.3–1.2 em; anything else means the host
        // measured something other than what we think it did.
        if (!Number.isFinite(advance) || advance < 0.2 || advance > 1.5) return null;

        const monospaced =
            mixedWidth !== null && Math.abs(mixedWidth - uniformWidth) / uniformWidth <= SAME_WIDTH;

        return { advance, monospaced, source: "measured" };
    } finally {
        await call("command:scene:delete-drawdy-preview-elements", {
            previewIds: [created.value.previewId],
        });
    }
}

/**
 * Candidate glyphs, ordered by how much ink they put on the page.
 *
 * Deliberately mixed: ASCII punctuation, letters that read as solid blocks,
 * digits (often tabular, so equal width even in a proportional font) and the
 * Unicode block elements. Only the ones that measure the same are kept, so
 * whichever family this board's font happens to render uniformly is the one
 * that gets used.
 */
const CANDIDATES = [
    ".", "'", ",", ":", ";", "-", "~", "!", "*", "=", "+", "?", "t", "f", "j",
    "c", "v", "u", "n", "x", "z", "o", "a", "k", "h", "d", "b", "q", "p", "w",
    "m", "O", "0", "Q", "L", "C", "J", "U", "Y", "X", "Z", "8", "S", "A", "H",
    "K", "D", "B", "G", "N", "W", "M", "#", "%", "$", "@",
    "░", "▒", "▓", "█",
];

/** Glyphs must measure within this fraction of each other to count as equal. */
const UNIFORM_TOLERANCE = 0.015;
/** A ramp shorter than this is not worth having. */
const MIN_RAMP = 5;
/** Trim to at most this many steps; more is noise, not detail. */
const MAX_RAMP = 12;

export interface DiscoveredRamp {
    /** Characters, darkest first. */
    chars: string;
    advance: number;
    /** How many candidates were measured and how many survived. */
    considered: number;
    kept: number;
}

/**
 * Build a ramp whose glyphs are all the same width on *this* board.
 *
 * The reason rows appear to breathe is that a proportional font renders
 * `.` narrower than `@`, so a row's width changes with its content and the
 * picture shifts under itself. Measuring every candidate and keeping only the
 * largest group that agrees on a width removes the cause rather than hiding
 * it — and because the group is chosen by measurement, it works whatever font
 * the host turns out to use.
 */
export async function discoverUniformRamp(mintId: () => string): Promise<DiscoveredRamp | null> {
    const ids = CANDIDATES.map(() => mintId());
    const elements = CANDIDATES.map((character, index) => ({
        type: "text" as const,
        drawdyElementId: ids[index]!,
        x: -1e6,
        y: -1e6 - index * 200,
        text: character.repeat(SAMPLE_LENGTH),
        fontSize: PROBE_FONT_SIZE,
        color: "#000000",
        textAlign: "left" as const,
    }));

    const created = await call("command:scene:create-drawdy-preview-elements", { elements });
    if (created.error) return null;

    try {
        const rects = await call("command:scene:element-rects", { drawdyElementIds: ids });
        if (rects.error) return null;

        const widths = new Map<string, number>();
        for (const entry of rects.value.rects) {
            const index = ids.indexOf(entry.drawdyElementId);
            if (index < 0 || !(entry.rect.width > 0)) continue;
            widths.set(CANDIDATES[index]!, entry.rect.width);
        }
        if (widths.size < MIN_RAMP) return null;

        // Group by width and take the largest group: that is the family this
        // font renders uniformly.
        let best: { width: number; chars: string[] } | null = null;
        for (const width of widths.values()) {
            const group: string[] = [];
            // CANDIDATES order is ink order, so the group comes out sorted.
            for (const character of CANDIDATES) {
                const candidate = widths.get(character);
                if (candidate === undefined) continue;
                if (Math.abs(candidate - width) / width <= UNIFORM_TOLERANCE) group.push(character);
            }
            if (!best || group.length > best.chars.length) best = { width, chars: group };
        }
        if (!best || best.chars.length < MIN_RAMP) return null;

        // Thin an over-long group down evenly, keeping the extremes.
        let chars = best.chars;
        if (chars.length > MAX_RAMP) {
            const step = (chars.length - 1) / (MAX_RAMP - 1);
            chars = Array.from({ length: MAX_RAMP }, (_, i) => chars[Math.round(i * step)]!);
        }

        return {
            chars: chars.join(""),
            advance: best.width / (SAMPLE_LENGTH * PROBE_FONT_SIZE),
            considered: widths.size,
            kept: best.chars.length,
        };
    } finally {
        await call("command:scene:delete-drawdy-preview-elements", {
            previewIds: [created.value.previewId],
        });
    }
}
