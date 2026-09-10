/**
 * Display probes.
 *
 * The full-resolution display leans on an undocumented corner of the protocol:
 * a *preview* `component` element carrying a `DomElementSchema` image. If a
 * host will not draw that, all you see is the black backdrop behind it — and
 * "it's black" does not say which part failed.
 *
 * So instead of guessing one change at a time, this lays every plausible
 * variant on the board side by side with a label under each. Whichever one
 * shows a picture is the one to build on.
 */
import type {
    Dimension,
    DomElementSchema,
    DrawdyElementSchema,
    DrawdyPreviewElementSchema,
} from "@drawdy/driver-protocol";
import type { Rect } from "./screen";

/** A 4x4 test image: red, green, blue and white quadrants. Unmistakable at any size. */
export const TEST_IMAGE_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAJUlEQVR4nGP8z4" +
    "AJmDBEUAUZsQtiVYopiFMJhiB+A7EK4gQAxHUEAWvUE9AAAAAASUVORK5CYII=";

export const TEST_IMAGE_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">` +
    `<rect width="1" height="1" x="0" y="0" fill="#e33"/><rect width="1" height="1" x="1" y="0" fill="#3c3"/>` +
    `<rect width="1" height="1" x="0" y="1" fill="#36f"/><rect width="1" height="1" x="1" y="1" fill="#fff"/></svg>`;

export const TEST_IMAGE_SVG_DATA_URL =
    "data:image/svg+xml;base64," +
    btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40" viewBox="0 0 2 2">` +
            `<rect width="1" height="1" x="0" y="0" fill="#e33"/><rect width="1" height="1" x="1" y="0" fill="#3c3"/>` +
            `<rect width="1" height="1" x="0" y="1" fill="#36f"/><rect width="1" height="1" x="1" y="1" fill="#fff"/></svg>`
    );

export interface Probe {
    label: string;
    /** Built as a preview element unless `commit` is set. */
    schema: DomElementSchema | null;
    /** Some probes are plain shapes/text, to prove the harness itself works. */
    raw?: (rect: Rect, id: string) => DrawdyPreviewElementSchema;
    /** Try this one as a committed scene element instead of a preview. */
    commit?: boolean;
}

/**
 * Ordered so that reading left to right narrows the cause:
 * does a component render at all → does an image node render → which URL
 * form → does sizing matter → is it preview-only.
 */
export function probes(source: string): Probe[] {
    const fill = (): { width: Dimension; height: Dimension } => ({ width: [100, "%"], height: [100, "%"] });
    return [
        {
            label: "1 shape (control)",
            schema: null,
            raw: (rect, id) => ({
                type: "shape",
                componentType: "rect",
                drawdyElementId: id,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                strokeColor: "#33cc33",
                fillColor: "#33cc33",
                fillStyle: "solid",
                strokeWidth: 0,
                cornerRadius: 0,
                roughness: 0,
            }),
        },
        {
            label: "2 component text",
            schema: { type: "text", child: "COMPONENT OK", styles: { color: "#33cc33", fontSize: [28, "px"] } },
        },
        {
            label: "3 component box",
            schema: { type: "box", styles: { ...fill, backgroundColor: "#33cc33" } },
        },
        {
            label: "4 img png 100%",
            schema: { type: "image", child: TEST_IMAGE_PNG, styles: { ...fill() } },
        },
        {
            label: "5 img png no styles",
            schema: { type: "image", child: TEST_IMAGE_PNG },
        },
        {
            label: "6 img png in box",
            schema: {
                type: "box",
                styles: { ...fill, backgroundColor: "#222" },
                children: [{ type: "image", child: TEST_IMAGE_PNG, styles: { ...fill() } }],
            },
        },
        {
            label: "7 img raw svg",
            schema: { type: "image", child: TEST_IMAGE_SVG, styles: { ...fill() } },
        },
        {
            label: "8 img svg data-url",
            schema: { type: "image", child: TEST_IMAGE_SVG_DATA_URL, styles: { ...fill() } },
        },
        {
            label: "9 img real frame",
            schema: { type: "image", child: source, styles: { ...fill() } },
        },
        {
            label: "10 committed img",
            schema: { type: "image", child: TEST_IMAGE_PNG, styles: { ...fill() } },
            commit: true,
        },
    ];
}

export interface ProbeLayout {
    previews: DrawdyPreviewElementSchema[];
    committed: DrawdyElementSchema[];
    labels: DrawdyPreviewElementSchema[];
}

/** Lay the probes out in a grid inside `area`, each with a caption beneath. */
export function layoutProbes(area: Rect, source: string, mintId: () => string, labelColor: string): ProbeLayout {
    const list = probes(source);
    const columns = 5;
    const rows = Math.ceil(list.length / columns);
    const cellWidth = area.width / columns;
    const cellHeight = area.height / rows;
    const pad = Math.min(cellWidth, cellHeight) * 0.08;
    const captionHeight = Math.min(34, cellHeight * 0.18);

    const previews: DrawdyPreviewElementSchema[] = [];
    const committed: DrawdyElementSchema[] = [];
    const labels: DrawdyPreviewElementSchema[] = [];

    list.forEach((probe, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const rect: Rect = {
            x: area.x + column * cellWidth + pad,
            y: area.y + row * cellHeight + pad,
            width: cellWidth - pad * 2,
            height: cellHeight - pad * 2 - captionHeight,
        };

        if (probe.raw) {
            previews.push(probe.raw(rect, mintId()));
        } else if (probe.schema) {
            const element = {
                type: "component" as const,
                drawdyElementId: mintId(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                schema: probe.schema,
            };
            if (probe.commit) committed.push(element);
            else previews.push(element);
        }

        labels.push({
            type: "text",
            drawdyElementId: mintId(),
            x: rect.x,
            y: rect.y + rect.height + 4,
            text: probe.label,
            fontSize: Math.max(11, Math.min(18, captionHeight * 0.62)),
            color: labelColor,
        });
    });

    return { previews, committed, labels };
}
