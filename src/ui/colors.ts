/*
 * The workflow stages, and the colours calendar sources are given.
 *
 * The stages are fixed (docs/format.md): five, in this order, the last one
 * meaning done. Nothing about them is configured, and none is painted with
 * a colour of its own (docs/ux.md §1).
 */

const STAGES = ["Backlog", "Ready", "In Progress", "Review", "Done"];

// Stages whose tray group starts collapsed, besides the done one.
const TUCKED_AWAY = new Set(["Review"]);

/** Workflow stage names, in kanban column order. */
export const workflowStages = (): string[] => [...STAGES];

/**
 * Whether this status's tray group starts COLLAPSED. Every status renders
 * as a group; the done stage and Review are tucked away by default, the
 * rest start open. The user's expand/collapse clicks override this.
 */
export function trayCollapsedByDefault(status: string | undefined): boolean {
    return !!status && (isDoneStatus(status) || TUCKED_AWAY.has(status));
}

/** The last stage counts as done (checked on the calendar). */
export const doneStatus = (): string => STAGES[STAGES.length - 1];

export const isDoneStatus = (s: string | undefined): boolean =>
    s !== undefined && s === doneStatus();

/** The stage a task returns to when its checkbox is unticked. */
export const statusAfterUncheck = (): string => "Review";

// Source border palette — 10 visually distinct colors assigned sequentially as
// new calendar sources are added. Deterministic and collision-free until all
// ten are in use, then it cycles. Used for actionable sources (local task
// folders, CalDAV).
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

// External/read-only (ical) calendars all share one muted tone, so subscribed
// calendars read as a single quiet "context" layer behind actionable tasks. A
// personal calendar can still be given its own color by hand. Sits in the
// violet range, which the status palette never uses, so external fills don't
// get confused with a task's status fill.
export const EXTERNAL_COLOR = "#a89cb5";

// Choose the palette appropriate to a source type. Subscribed ical calendars
// collapse to the single external tone; everything else gets the vivid palette.
export function paletteForType(type: string): string[] {
    return type === "ical" ? [EXTERNAL_COLOR] : SOURCE_PALETTE;
}

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
 * Pick the next source color for a source of the given type: the first entry of
 * that type's palette not already used, falling back to a stable rotation once
 * all are taken.
 */
export function nextSourceColor(
    usedColors: string[],
    type: string = "local"
): string {
    const palette = paletteForType(type);
    const used = new Set(
        usedColors.filter(Boolean).map((c) => c.toLowerCase())
    );
    const free = palette.find((c) => !used.has(c.toLowerCase()));
    return free ?? palette[usedColors.length % palette.length];
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
