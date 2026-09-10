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
