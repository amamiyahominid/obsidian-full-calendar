import type { TFile } from "obsidian";
import type FullCalendarPlugin from "../main";
import { dailyFile, ensureDaily, todayISO } from "./dailyService";

/*
 * Quick memo capture: one line typed in the tray lands as a bullet under
 * the daily note's "Memo" heading. Memos are plain bullets, not events —
 * they never reach the calendar or the event cache.
 */

export const MEMO_HEADING = "Memo";
// The heading may be written either way in the note; new ones get the first.
const MEMO_HEADINGS = [MEMO_HEADING, "メモ"];

const headingRe = /^(#{1,6})\s+(.*?)\s*$/;

/** [start, end) line range of the body under `heading`, or null. The body
 * ends at the next heading of the same or higher level, a thematic break
 * (`---`), or the end of the note. */
function sectionRange(
    lines: string[],
    heading: string | string[]
): { start: number; end: number } | null {
    const names = Array.isArray(heading) ? heading : [heading];
    let level = 0;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(headingRe);
        if (start < 0) {
            if (m && names.includes(m[2])) {
                level = m[1].length;
                start = i + 1;
            }
            continue;
        }
        if ((m && m[1].length <= level) || /^---+\s*$/.test(lines[i])) {
            return { start, end: i };
        }
    }
    return start < 0 ? null : { start, end: lines.length };
}

/** The non-empty bullets under the memo heading, markers stripped. */
export function memoLines(
    page: string,
    heading: string | string[] = MEMO_HEADINGS
): string[] {
    const lines = page.split("\n");
    const range = sectionRange(lines, heading);
    if (!range) {
        return [];
    }
    return lines
        .slice(range.start, range.end)
        .map((l) => l.match(/^\s*[-*+]\s+(.*\S)\s*$/)?.[1])
        .filter((l): l is string => !!l);
}

/**
 * Add `- text` at the end of the memo section. An empty placeholder bullet
 * (the daily template leaves a bare `- `) is filled in rather than left
 * dangling above the new line; a missing heading is appended to the note.
 */
export function appendMemoLine(
    page: string,
    text: string,
    heading: string | string[] = MEMO_HEADINGS
): string {
    const item = `- ${text.trim()}`;
    const lines = page.split("\n");
    const range = sectionRange(lines, heading);
    if (!range) {
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
            lines.pop();
        }
        if (lines.length > 0) {
            lines.push("");
        }
        const name = Array.isArray(heading) ? heading[0] : heading;
        lines.push(`## ${name}`, "", item, "");
        return lines.join("\n");
    }
    let last = -1;
    for (let i = range.start; i < range.end; i++) {
        if (/^\s*[-*+]\s*$/.test(lines[i])) {
            lines[i] = item;
            return lines.join("\n");
        }
        if (lines[i].trim() !== "") {
            last = i;
        }
    }
    if (last >= 0) {
        lines.splice(last + 1, 0, item);
    } else {
        // Empty section: keep one blank line after the heading and one
        // before whatever follows.
        const tail = range.end < lines.length ? [""] : [];
        lines.splice(range.start, range.end - range.start, "", item, ...tail);
    }
    return lines.join("\n");
}

const isPlaceholder = (line: string) => /^\s*[-*+]?\s*$/.test(line);

/**
 * The memo section exactly as written — nesting, links and all — minus the
 * blank lines around it. A section holding nothing but the template's bare
 * bullet reads as empty.
 */
export function memoBody(
    page: string,
    heading: string | string[] = MEMO_HEADINGS
): string {
    const lines = page.split("\n");
    const range = sectionRange(lines, heading);
    if (!range) {
        return "";
    }
    const body = lines.slice(range.start, range.end);
    if (body.every(isPlaceholder)) {
        return "";
    }
    while (body.length > 0 && body[0].trim() === "") {
        body.shift();
    }
    while (body.length > 0 && body[body.length - 1].trim() === "") {
        body.pop();
    }
    return body.join("\n");
}

/** Swap the whole memo section for `body`, leaving the rest of the note
 * byte-for-byte. A missing heading is appended to the note. */
export function replaceMemoBody(
    page: string,
    body: string,
    heading: string | string[] = MEMO_HEADINGS
): string {
    const lines = page.split("\n");
    const next = body.replace(/\s+$/, "").split("\n");
    const range = sectionRange(lines, heading);
    if (!range) {
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
            lines.pop();
        }
        if (lines.length > 0) {
            lines.push("");
        }
        const name = Array.isArray(heading) ? heading[0] : heading;
        lines.push(`## ${name}`, "", ...next, "");
        return lines.join("\n");
    }
    const tail = range.end < lines.length ? [""] : [];
    lines.splice(range.start, range.end - range.start, "", ...next, ...tail);
    return lines.join("\n");
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * The memo as it should be DRAWN. Markdown folds an unindented line that
 * directly follows a list item into that item ("lazy continuation"), so

 *     - a
 *     note

 * renders "note" indented under the bullet — while the editor shows it flush
 * left, as typed. A blank line before such a line makes the preview agree
 * with the editor. Display only: the note itself is never rewritten.
 */
export function memoForDisplay(body: string): string {
    const out: string[] = [];
    let inList = false;
    let inFence = false;
    for (const line of body.split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
        }
        if (inFence) {
            out.push(line);
            continue;
        }
        if (line.trim() === "") {
            inList = false;
        } else if (LIST_ITEM.test(line)) {
            inList = true;
        } else if (!/^\s/.test(line)) {
            if (inList) {
                out.push("");
            }
            inList = false;
        }
        out.push(line);
    }
    return out.join("\n");
}

function todayNote(plugin: FullCalendarPlugin): TFile | null {
    return dailyFile(plugin.io, todayISO());
}

/** Today's memo section and the note it lives in; empty when the daily
 * note doesn't exist yet. */
export async function readTodayMemo(
    plugin: FullCalendarPlugin
): Promise<{ body: string; path: string | null }> {
    const file = todayNote(plugin);
    if (!file) {
        return { body: "", path: null };
    }
    return {
        body: memoBody(await plugin.io.read(file)),
        path: file.path,
    };
}

/** Path of today's daily note, or null when it doesn't exist yet. */
export function todayNotePath(plugin: FullCalendarPlugin): string | null {
    return todayNote(plugin)?.path ?? null;
}

/**
 * Save an in-tray edit of the whole memo section. `original` is the memo as
 * the editor last knew it: if the note's memo has changed since (edited in
 * the note itself, or on another device), nothing is written and null comes
 * back, so neither side's words are lost. On success the memo as it now
 * reads in the note comes back — the next save's `original`.
 */
export async function saveTodayMemo(
    plugin: FullCalendarPlugin,
    original: string,
    body: string
): Promise<string | null> {
    const file = await ensureDaily(plugin.io, todayISO());
    const page = await plugin.io.read(file);
    if (memoBody(page) !== original) {
        return null;
    }
    const next = replaceMemoBody(page, body);
    if (next !== page) {
        await plugin.io.rewrite(file, () => next);
    }
    return memoBody(next);
}
