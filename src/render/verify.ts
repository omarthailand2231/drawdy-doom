/**
 * Did the board actually draw it?
 *
 * The full-resolution display relies on a host drawing a preview `component`
 * with an image inside. If a host quietly ignores that, the driver hears
 * nothing — the update succeeds, `updated: 1` comes back, and the player sees
 * the black backdrop and assumes the extension is broken.
 *
 * `command:scene:capture-screenshot` closes the loop: take a picture of the
 * region we just drew into and compare its brightness with the frame we sent.
 * A bright frame that lands on a black rectangle means the host did not draw
 * it, and the driver can fall back to the shape grid on its own.
 */
import { call } from "../protocol";
import type { Rect } from "./screen";

/** Mean luminance below this is "nothing there". */
const DARK = 6;
/** Only judge a frame with enough light in it to be conclusive. */
const BRIGHT_ENOUGH = 22;

export type VerifyResult = "drawn" | "blank" | "inconclusive";

/** Mean luminance of a BGRA frame, sampled rather than summed. */
export function frameLuminance(frame: Uint8Array, width: number, height: number): number {
    const pixels = width * height;
    const step = Math.max(1, Math.floor(pixels / 4000));
    let total = 0;
    let count = 0;
    for (let i = 0; i < pixels; i += step) {
        const offset = i * 4;
        // Rec. 601 luma, on BGRA.
        total += 0.114 * frame[offset]! + 0.587 * frame[offset + 1]! + 0.299 * frame[offset + 2]!;
        count++;
    }
    return count === 0 ? 0 : total / count;
}

async function screenshotLuminance(area: Rect): Promise<number | null> {
    const shot = await call("command:scene:capture-screenshot", { area });
    if (shot.error) return null;
    try {
        const bitmap = await createImageBitmap(shot.value.png);
        // Scaling down to a thumbnail is both cheap and all the fidelity a
        // "is anything there" question needs.
        const width = Math.max(1, Math.min(48, bitmap.width));
        const height = Math.max(1, Math.min(30, bitmap.height));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const { data } = context.getImageData(0, 0, width, height);
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
            total += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        }
        return total / (data.length / 4);
    } catch {
        return null;
    }
}

/**
 * Compare what we sent with what the board shows.
 *
 * Deliberately conservative: anything short of "we sent a clearly lit frame
 * and the board is black" is `inconclusive`, because falling back on a false
 * positive would downgrade a display that was working fine.
 */
export async function verifyDisplay(area: Rect, sentLuminance: number): Promise<VerifyResult> {
    if (sentLuminance < BRIGHT_ENOUGH) return "inconclusive";
    if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return "inconclusive";
    const shown = await screenshotLuminance(area);
    if (shown === null) return "inconclusive";
    return shown < DARK ? "blank" : "drawn";
}
