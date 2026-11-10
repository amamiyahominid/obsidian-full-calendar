/*
 * Reading a daily note's structure straight from its text: where a heading's
 * section is, which lines in it are list items, and the block id a line
 * ends with. No Obsidian metadata — the same functions serve any host that
 * can hand over the file's text (see docs/format.md).
 */

export type HeadingRef = { line: number; level: number };

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const BREAK = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
// A block id closes the line: one space, a caret, letters / digits / dashes.
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;

/** Line index just past the YAML frontmatter, or 0 when there is none. */
function bodyStart(lines: string[]): number {
    if (lines[0]?.trim() !== "---") {
        return 0;
    }
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    return close > 0 ? close + 1 : 0;
}

/** Every heading outside frontmatter and code fences, in order. */
export function headings(lines: string[]): (HeadingRef & { text: string })[] {
    const out: (HeadingRef & { text: string })[] = [];
    let inFence = false;
    for (let i = bodyStart(lines); i < lines.length; i++) {
        if (FENCE.test(lines[i])) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            continue;
        }
        const m = lines[i].match(HEADING);
        if (m) {
            out.push({ line: i, level: m[1].length, text: m[2] });
        }
    }
    return out;
}

/** The first heading with exactly this text. */
export function findHeading(
    lines: string[],
    text: string
): HeadingRef | undefined {
    const h = headings(lines).find((x) => x.text === text);
    return h ? { line: h.line, level: h.level } : undefined;
}

/**
 * [start, end) of the lines under a heading: up to the next heading of the
 * same or a higher level, or the end of the note. Null when the heading
 * isn't there.
 */
export function sectionUnder(
    lines: string[],
    text: string
): { start: number; end: number } | null {
    const all = headings(lines);
    const at = all.findIndex((x) => x.text === text);
    if (at < 0) {
        return null;
    }
    const next = all.slice(at + 1).find((x) => x.level <= all[at].level);
    return { start: all[at].line + 1, end: next ? next.line : lines.length };
}

function listLinesIn(lines: string[], start: number, end: number): number[] {
    const out: number[] = [];
    let inFence = false;
    for (let i = start; i < end; i++) {
        if (FENCE.test(lines[i])) {
            inFence = !inFence;
            continue;
        }
        if (!inFence && LIST_ITEM.test(lines[i])) {
            out.push(i);
        }
    }
    return out;
}

/** Line indexes of the list items under a heading. */
export function listLinesUnderHeading(lines: string[], text: string): number[] {
    const range = sectionUnder(lines, text);
    return range ? listLinesIn(lines, range.start, range.end) : [];
}

/**
 * Line indexes of the list items in the note's top region: from the top of
 * the body to the first heading or horizontal rule, whichever comes first.
 */
export function listLinesInTopRegion(lines: string[]): number[] {
    const start = bodyStart(lines);
    let end = lines.length;
    let inFence = false;
    for (let i = start; i < lines.length; i++) {
        if (FENCE.test(lines[i])) {
            inFence = !inFence;
            continue;
        }
        if (!inFence && (HEADING.test(lines[i]) || BREAK.test(lines[i]))) {
            end = i;
            break;
        }
    }
    return listLinesIn(lines, start, end);
}

/** The block id a line ends with ("… ^k3f9aq" → "k3f9aq"), or null. */
export function blockIdOf(line: string): string | null {
    return line.match(BLOCK_ID)?.[1] ?? null;
}

/** The line without its trailing block id. */
export function stripBlockId(line: string): string {
    return line.replace(BLOCK_ID, "");
}

/** Index of the line that ends with this block id, or -1. */
export function findLineByBlockId(lines: string[], id: string): number {
    return lines.findIndex((l) => blockIdOf(l) === id);
}

/** A fresh block id: six lowercase letters / digits, not yet in the note. */
export function newBlockId(lines: string[]): string {
    const used = new Set(
        lines.map(blockIdOf).filter((x): x is string => x !== null)
    );
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (;;) {
        let id = "";
        for (let i = 0; i < 6; i++) {
            id += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        if (!used.has(id)) {
            return id;
        }
    }
}

/*
 * Event ids for daily-note lines. A block id is unique within its note, so
 * the id events carry adds the note's date: "2026-11-10^k3f9aq".
 */
export const lineEventId = (date: string, blockId: string): string =>
    `${date}^${blockId}`;

/** The block id inside an event id, or null for ids of any other kind. */
export function blockIdFromEventId(id: string | undefined): string | null {
    if (!id) {
        return null;
    }
    const at = id.lastIndexOf("^");
    return at >= 0 && at < id.length - 1 ? id.slice(at + 1) : null;
}
