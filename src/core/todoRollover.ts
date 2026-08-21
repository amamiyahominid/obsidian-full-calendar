import { TFile } from "obsidian";
import { DateTime } from "luxon";
import moment from "moment";
import {
    createDailyNote,
    getAllDailyNotes,
    getDailyNote,
} from "obsidian-daily-notes-interface";
import DailyNoteCalendar from "../calendars/DailyNoteCalendar";
import type FullCalendarPlugin from "../main";

/*
 * Plugin-owned TODO rollover.
 *
 * The daily-note template used to COPY unchecked `- [ ]` lines into each new
 * note, which meant every unfinished TODO existed in every note since its
 * creation — and anything that made the plugin write to a FUTURE note (moving
 * a TODO to tomorrow) collided with the copier and duplicated lines.
 *
 * The plugin now MOVES unchecked TODO lines from past daily notes into
 * today's note instead: one line, one TODO, always. Text-level deduplication
 * doubles as the one-time migration that sweeps up the copies the old
 * template left behind. Checked lines are never touched — they stay in their
 * note as the day's history.
 */

const UNCHECKED_RE = /^\s*-\s+\[ \]\s*\S/;
const ANY_CHECKBOX_RE = /^\s*-\s+\[.\]\s*\S/;

/** Normalized dedup key for a TODO line: text without checkbox/indent. */
const todoKey = (line: string): string =>
    line.replace(/^\s*-\s+\[.\]\s*/, "").trim();

const escapeRegExp = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Insert TODO lines at the end of the given heading's section (or at the top
 * of the note when the calendar is configured headingless). Pure — exported
 * for tests.
 */
export function appendTodosUnderHeading(
    contents: string,
    heading: string,
    todoLines: string[]
): string {
    const lines = contents.split("\n");
    if (!heading) {
        lines.splice(0, 0, ...todoLines);
        return lines.join("\n");
    }
    const headingRe = new RegExp(`^(#{1,6})\\s+${escapeRegExp(heading)}\\s*$`);
    let headingLine = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(headingRe);
        if (m) {
            headingLine = i;
            level = m[1].length;
            break;
        }
    }
    if (headingLine === -1) {
        // Note predates the heading convention — append a fresh section.
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
            lines.pop();
        }
        if (lines.length > 0) {
            lines.push("");
        }
        lines.push(`## ${heading}`, "", ...todoLines, "");
        return lines.join("\n");
    }
    let boundary = lines.length;
    for (let i = headingLine + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s/);
        if (m && m[1].length <= level) {
            boundary = i;
            break;
        }
        // The daily template separates sections with horizontal rules;
        // entries must land above the rule, not after it.
        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i])) {
            boundary = i;
            break;
        }
    }
    let insertAt = boundary;
    while (insertAt > headingLine + 1 && lines[insertAt - 1].trim() === "") {
        insertAt--;
    }
    lines.splice(insertAt, 0, ...todoLines);
    return lines.join("\n");
}

function getTodoCalendar(plugin: FullCalendarPlugin): DailyNoteCalendar | null {
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (cal instanceof DailyNoteCalendar && cal.todos) {
            return cal;
        }
    }
    return null;
}

/**
 * Move every unchecked TODO from past daily notes into today's note.
 * Returns how many lines landed in today's note (deduplicated); the removal
 * also sweeps duplicate copies left behind by the old copy-forward template.
 */
export async function rollTodosForward(
    plugin: FullCalendarPlugin
): Promise<number> {
    const cal = getTodoCalendar(plugin);
    if (!cal) {
        return 0;
    }
    const source = plugin.cache.getAllEvents().find((s) => s.id === cal.id);
    if (!source) {
        return 0;
    }
    const today = DateTime.now().toISODate();

    // Past unchecked TODO lines, located via the cache, grouped per file.
    const byPath = new Map<string, number[]>();
    for (const { id, event } of source.events) {
        if (event.type !== "single" || event.completed !== false) {
            continue;
        }
        if (!event.date || event.date >= today) {
            continue;
        }
        const loc = plugin.cache.getEventLocation(id);
        if (!loc?.path || loc.lineNumber === undefined) {
            continue;
        }
        const numbers = byPath.get(loc.path) ?? [];
        numbers.push(loc.lineNumber);
        byPath.set(loc.path, numbers);
    }
    if (byPath.size === 0) {
        return 0;
    }

    // Seed the dedup set with EVERY checkbox line today's note already
    // holds — unchecked (already rolled) AND checked. A TODO completed today
    // must not resurrect from a stale unchecked copy in a past note.
    const seen = new Set<string>();
    let todayFile = getDailyNote(moment(), getAllDailyNotes()) as TFile;
    if (todayFile) {
        const contents = await plugin.app.vault.read(todayFile);
        for (const line of contents.split("\n")) {
            if (ANY_CHECKBOX_RE.test(line)) {
                seen.add(todoKey(line));
            }
        }
    }

    // Oldest first so the surviving copy of a duplicate keeps its original
    // relative order.
    const movedLines: string[] = [];
    const paths = [...byPath.keys()].sort();
    for (const path of paths) {
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            continue;
        }
        const lineNumbers = byPath.get(path)!;
        const contents = await plugin.app.vault.read(file);
        const lines = contents.split("\n");
        // Validate ascending (collection order), remove descending (so line
        // numbers stay valid mid-splice).
        const confirmed: number[] = [];
        for (const n of [...lineNumbers].sort((a, b) => a - b)) {
            const line = lines[n];
            if (line === undefined || !UNCHECKED_RE.test(line)) {
                // Cache location went stale — leave the line alone.
                continue;
            }
            confirmed.push(n);
            const key = todoKey(line);
            if (!seen.has(key)) {
                seen.add(key);
                movedLines.push(line.trim());
            }
        }
        if (confirmed.length > 0) {
            for (const n of confirmed.sort((a, b) => b - a)) {
                lines.splice(n, 1);
            }
            await plugin.app.vault.modify(file, lines.join("\n"));
        }
    }
    if (movedLines.length === 0) {
        return 0;
    }

    if (!todayFile) {
        todayFile = (await createDailyNote(moment())) as TFile;
    }
    const todayContents = await plugin.app.vault.read(todayFile);
    await plugin.app.vault.modify(
        todayFile,
        appendTodosUnderHeading(todayContents, cal.heading, movedLines)
    );
    return movedLines.length;
}
