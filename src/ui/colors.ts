/*
 * Color assignment for the calendar.
 *
 * Two independent channels:
 *   - Source color → event BORDER (set at the FullCalendar source level).
 *   - Task status  → event FILL (per-event override of the source color).
 *
 * Non-task events (no status) keep the source color for both border and fill,
 * so their appearance is unchanged.
 */

// Fixed semantic palette for the workflow stages. Dusty pastels kept at a
// uniform tone (high lightness, muted saturation) so the set reads as one
// cohesive family, ordered as a temperature arc: neutral → cool → warm →
// resolved. Free-form statuses not in this map fall back to the source color.
export const STATUS_COLORS: Record<string, string> = {
    Backlog: "#c9cfd8", // dove gray — dormant
    Ready: "#a6c4e2", // powder blue — queued
    "In Progress": "#e6d29a", // wheat — active
    Review: "#e6b394", // apricot — attention
    Done: "#aad6b5", // sage — complete
};

// Source border palette — 10 visually distinct colors assigned sequentially as
// new calendar sources are added. Deterministic and collision-free until all
// ten are in use, then it cycles.
export const SOURCE_PALETTE = [
    "#c41540", // red
    "#339940", // green
    "#3954b8", // blue
    "#d06f2a", // orange
    "#7b1a99", // purple
    "#2f9cb8", // cyan
    "#cc2bc4", // magenta
    "#8aab2f", // lime
    "#3c827a", // teal
    "#83541f", // brown
];

// The earlier, more vivid source palette. Kept only so existing sources can be
// migrated to the current (deepened) palette on load. Index-aligned with
// SOURCE_PALETTE.
const LEGACY_SOURCE_PALETTE = [
    "#e6194b",
    "#3cb44b",
    "#4363d8",
    "#f58231",
    "#911eb4",
    "#42d4f4",
    "#f032e6",
    "#bfef45",
    "#469990",
    "#9a6324",
];

/**
 * Map a legacy palette color to its current-palette equivalent. Colors that
 * aren't from the legacy palette (custom picks) are returned unchanged.
 */
export function migrateSourceColor(color: string): string {
    if (!color) {
        return color;
    }
    const i = LEGACY_SOURCE_PALETTE.findIndex(
        (c) => c.toLowerCase() === color.toLowerCase()
    );
    return i === -1 ? color : SOURCE_PALETTE[i];
}

/**
 * Pick the next source color: the first palette entry not already used by an
 * existing source, falling back to a stable rotation once all are taken.
 */
export function nextSourceColor(usedColors: string[]): string {
    const used = new Set(
        usedColors.filter(Boolean).map((c) => c.toLowerCase())
    );
    const free = SOURCE_PALETTE.find((c) => !used.has(c.toLowerCase()));
    return free ?? SOURCE_PALETTE[usedColors.length % SOURCE_PALETTE.length];
}

/**
 * Choose black or white text for a hex fill color, by perceived brightness.
 * Mirrors the threshold used by getCalendarColors() in view.ts.
 */
export function contrastTextColor(hex: string): string {
    const m = hex.slice(1).match(hex.length === 7 ? /(\S{2})/g : /(\S{1})/g);
    if (!m) {
        return "white";
    }
    const r = parseInt(m[0], 16);
    const g = parseInt(m[1], 16);
    const b = parseInt(m[2], 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 150 ? "black" : "white";
}
