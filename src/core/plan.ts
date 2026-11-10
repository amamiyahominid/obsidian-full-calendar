import {
    blockIdOf,
    listLinesUnderHeading,
    newBlockId,
    sectionUnder,
    stripBlockId,
} from "./dailyText";

/*
 * Plan and Log (docs/format.md). Both headings of a daily note hold blocks
 * of time in the same line shape; Plan is what the day is meant to hold, Log
 * what it did hold. Pure text in, text out.
 *
 * Three moves live here:
 *  - the routine: the blocks a weekday always starts with, read from one
 *    plain note instead of template code;
 *  - filling a new day's Plan from the routine;
 *  - confirming: moving the Plan blocks whose time has passed into Log.
 */

export const PLAN = "Plan";
export const LOG = "Log";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const GROUPS: Record<string, number[]> = {
    毎日: [0, 1, 2, 3, 4, 5, 6],
    平日: [1, 2, 3, 4, 5],
    週末: [0, 6],
};
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const END_TIME = /\[endTime:: ?(\d{1,2}:\d{2})\]/;
const START_TIME = /\[startTime:: ?(\d{1,2}:\d{2})\]/;

/** Weekdays (0 = Sunday) a routine heading names: "毎日", "平日", "月 火 木". */
export function weekdaysOf(heading: string): number[] {
    const days = new Set<number>();
    for (const word of heading.split(/[\s、,・]+/).filter(Boolean)) {
        if (GROUPS[word]) {
            GROUPS[word].forEach((d) => days.add(d));
            continue;
        }
        for (const ch of word) {
            const d = WEEKDAYS.indexOf(ch);
            if (d >= 0) {
                days.add(d);
            }
        }
    }
    return [...days];
}

/**
 * The routine's blocks for one weekday (0 = Sunday), in the order written:
 * every list line under a heading that names that day. The routine note is
 * just headings naming days, each followed by block lines.
 */
export function routineFor(routine: string, weekday: number): string[] {
    const out: string[] = [];
    let on = false;
    for (const line of routine.split("\n")) {
        const h = line.match(/^#{1,6}\s+(.*?)\s*$/);
        if (h) {
            on = weekdaysOf(h[1]).includes(weekday);
        } else if (on && /^\s*-\s+\S/.test(line)) {
            out.push(stripBlockId(line).trim());
        }
    }
    return out.sort((a, b) =>
        (a.match(START_TIME)?.[1] ?? "").localeCompare(
            b.match(START_TIME)?.[1] ?? ""
        )
    );
}

/** Where new lines go in a section: after its last line of content, above
 * any rule or blank lines that close it. */
function insertionPoint(lines: string[], start: number, end: number): number {
    let stop = end;
    for (let i = start; i < end; i++) {
        if (RULE.test(lines[i])) {
            stop = i;
            break;
        }
    }
    while (stop > start && lines[stop - 1].trim() === "") {
        stop--;
    }
    return stop;
}

function insertUnder(lines: string[], heading: string, items: string[]): void {
    const range = sectionUnder(lines, heading);
    if (!range || items.length === 0) {
        return;
    }
    let at = insertionPoint(lines, range.start, range.end);
    // One blank line between the heading and its first entry…
    if (at === range.start) {
        lines.splice(at, 0, "");
        at++;
    }
    lines.splice(at, 0, ...items);
    // …and one after the last, before whatever follows.
    const after = at + items.length;
    if (after >= lines.length || lines[after].trim() !== "") {
        lines.splice(after, 0, "");
    }
}

/**
 * Put the routine's blocks under Plan — only when the note has a Plan
 * heading with nothing listed yet, so a day that already has a plan (typed,
 * or filled on another device) is left as it is. Each line gets its name.
 */
export function fillPlan(page: string, blocks: string[]): string {
    const lines = page.split("\n");
    if (
        blocks.length === 0 ||
        !sectionUnder(lines, PLAN) ||
        listLinesUnderHeading(lines, PLAN).length > 0
    ) {
        return page;
    }
    const named: string[] = [];
    for (const block of blocks) {
        named.push(`${block} ^${newBlockId([...lines, ...named])}`);
    }
    insertUnder(lines, PLAN, named);
    return lines.join("\n");
}

/**
 * Confirm the plan: move Plan's blocks into Log, lines unchanged (names and
 * all), so the day's record starts from what was meant and only the
 * differences need fixing by hand.
 *
 * `upTo` ("HH:mm") limits it to blocks that have ended by then — for today,
 * whose later blocks are still ahead. Null moves every block (a past day).
 * Blocks with no end time are left in Plan either way.
 */
export function confirmPlan(
    page: string,
    upTo: string | null
): { page: string; moved: number } {
    const lines = page.split("\n");
    if (!sectionUnder(lines, PLAN) || !sectionUnder(lines, LOG)) {
        return { page, moved: 0 };
    }
    const pad = (t: string) => t.padStart(5, "0");
    const picked = listLinesUnderHeading(lines, PLAN).filter((i) => {
        const end = lines[i].match(END_TIME)?.[1];
        return !!end && (upTo === null || pad(end) <= pad(upTo));
    });
    if (picked.length === 0) {
        return { page, moved: 0 };
    }
    const moving = picked.map((i) => lines[i]);
    for (const i of [...picked].reverse()) {
        lines.splice(i, 1);
    }
    insertUnder(lines, LOG, moving);
    return { page: lines.join("\n"), moved: moving.length };
}

/** For tests and checks: the block ids under a heading, in order. */
export function blockIdsUnder(page: string, heading: string): string[] {
    const lines = page.split("\n");
    return listLinesUnderHeading(lines, heading)
        .map((i) => blockIdOf(lines[i]))
        .filter((x): x is string => x !== null);
}
