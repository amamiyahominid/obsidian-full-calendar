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

// Fixed semantic palette for the workflow stages. Muted (Tailwind-300-ish)
// pastels so events stay easy on the eye, ordered to read as a progression:
// neutral slate → cool blue → warm amber → orange → green. Free-form statuses
// not in this map fall back to the source color.
export const STATUS_COLORS: Record<string, string> = {
    Backlog: "#cbd5e1", // slate
    Ready: "#93c5fd", // blue
    "In Progress": "#fcd34d", // amber
    Review: "#fdba74", // orange
    Done: "#86efac", // green
};

// Source border palette — 10 visually distinct colors assigned sequentially as
// new calendar sources are added. Deterministic and collision-free until all
// ten are in use, then it cycles.
export const SOURCE_PALETTE = [
    "#e6194b", // red
    "#3cb44b", // green
    "#4363d8", // blue
    "#f58231", // orange
    "#911eb4", // purple
    "#42d4f4", // cyan
    "#f032e6", // magenta
    "#bfef45", // lime
    "#469990", // teal
    "#9a6324", // brown
];

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
