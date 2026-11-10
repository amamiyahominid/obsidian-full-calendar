import { Notice } from "obsidian";
import { DateTime } from "luxon";
import type FullCalendarPlugin from "../main";
import DailyNoteCalendar from "../calendars/DailyNoteCalendar";
import {
    findRunningSessions,
    firstLinktext,
    RunningSession,
    startSession,
    stopSession,
} from "./worklog";
import { toggleTask } from "../ui/tasks";

/*
 * Today's list: the daily notes' TODO lines up to today, in the order to
 * work in — and the three moves that need no aiming: start what's next,
 * stop what's running, finish it and go on. The list already says what
 * comes next, so none of them asks which.
 */

export type TodayRow = {
    id: string;
    title: string;
    date: string;
    done: boolean;
    /** Line in its daily note — today's list reads in written order. */
    line: number;
};

// Sticky keys for TODO rows. Event IDs churn when the daily note is edited,
// so key on what identifies the line to a human instead.
export const todoKey = (date: string, title: string) => `${date}::${title}`;

/**
 * Day-scoped TODO lines for the tray. Open ones up to today, oldest (most
 * forgotten) first; then today's checked ones — checking a box shouldn't
 * make the line vanish (mis-taps get unticked, and the list doubles as an
 * at-a-glance "what got done today"). Checked TODOs from PAST days are
 * history and stay hidden, EXCEPT ones `isSticky` vouches for: checking an
 * old TODO must not make it disappear mid-session.
 */
export function collectTodayRows(
    plugin: FullCalendarPlugin,
    isSticky?: (key: string) => boolean
): TodayRow[] {
    const today = DateTime.now().toISODate();
    const todos: TodayRow[] = [];
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (!(cal instanceof DailyNoteCalendar) || !cal.todos) {
            continue;
        }
        for (const { id, event } of source.events) {
            // Only checkbox lines carry a completed value; work-log sessions
            // and plain lines don't.
            if (
                event.type !== "single" ||
                event.completed === undefined ||
                event.completed === null
            ) {
                continue;
            }
            if (!event.date || event.date > today) {
                continue;
            }
            const done = event.completed !== false;
            if (
                done &&
                event.date !== today &&
                !(isSticky?.(todoKey(event.date, event.title)) ?? false)
            ) {
                continue;
            }
            let line = 0;
            try {
                line =
                    plugin.cache.getInfoForEditableEvent(id).location
                        ?.lineNumber ?? 0;
            } catch {
                // Not in the store any more; order it first.
            }
            todos.push({
                id,
                title: event.title,
                date: event.date,
                done,
                line,
            });
        }
    }
    // Done sinks last, mirroring the task cards; open ones oldest day
    // first, and within a day in the order they were written — the daily
    // note's order is the order to work in.
    return todos.sort((a, b) =>
        a.done !== b.done
            ? Number(a.done) - Number(b.done)
            : a.date.localeCompare(b.date) || a.line - b.line
    );
}

/** "[[a|b]] rest" → "b rest": TODO lines read as text, not as markup. */
export const plainTitle = (title: string): string =>
    title.replace(
        /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
        (_m, target: string, alias?: string) => alias || target
    );

/** The task a TODO line stands for, when the line is nothing but a link. */
export const soleLinktext = (title: string): string | null => {
    const m = title.trim().match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
    return m ? m[1].trim() : null;
};

function todoCalendarId(plugin: FullCalendarPlugin): string | null {
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (cal instanceof DailyNoteCalendar && cal.todos) {
            return source.id;
        }
    }
    return null;
}

/** Put a task on today's list: one `- [ ] [[task]]` line in the daily
 * note's TODO. A task already listed today is left alone. */
export async function addTaskToToday(
    plugin: FullCalendarPlugin,
    linktext: string
): Promise<void> {
    const calendarId = todoCalendarId(plugin);
    if (!calendarId) {
        new Notice(
            'No TODO calendar configured. Add a "Daily Note" calendar with TODOs enabled in the Full Calendar settings.'
        );
        return;
    }
    const today = DateTime.now().toISODate();
    const listed = plugin.cache
        .getAllEvents()
        .filter((s) => s.id === calendarId)
        .flatMap((s) => s.events)
        .some(
            ({ event }) =>
                event.type === "single" &&
                event.date === today &&
                soleLinktext(event.title) === linktext
        );
    if (listed) {
        return;
    }
    try {
        await plugin.cache.addEvent(calendarId, {
            type: "single",
            title: `[[${linktext}]]`,
            date: today,
            endDate: null,
            allDay: true,
            completed: false,
        });
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
    }
}

/**
 * The session running for a row, if any. A row that stands for a task is
 * matched by the task its session links to; any other row by its own text,
 * which is what its session is logged under.
 */
export function sessionOfRow(
    row: TodayRow,
    running: RunningSession[]
): RunningSession | undefined {
    const link = soleLinktext(row.title);
    return running.find((r) =>
        link
            ? firstLinktext(r.event.title) === link
            : r.event.title.trim() === row.title.trim()
    );
}

/**
 * What "start" starts: the first line of the list that isn't done and isn't
 * already running. One rule, readable off the list.
 */
export function nextRow(
    rows: TodayRow[],
    running: RunningSession[]
): TodayRow | undefined {
    return rows.find((r) => !r.done && !sessionOfRow(r, running));
}

/** Start working on a row: its session is logged under the row's own text. */
export function startRow(
    plugin: FullCalendarPlugin,
    row: TodayRow
): Promise<boolean> {
    return startSession(plugin, row.title);
}

/**
 * One key for both: stop whatever is running; if nothing is, start what's
 * next. Returns what happened, for the caller to tell the user.
 */
export async function startOrStop(
    plugin: FullCalendarPlugin
): Promise<"stopped" | "started" | "nothing"> {
    const running = findRunningSessions(plugin);
    if (running.length > 0) {
        for (const session of running) {
            await stopSession(plugin, session);
        }
        return "stopped";
    }
    const next = nextRow(collectTodayRows(plugin), running);
    if (!next) {
        return "nothing";
    }
    await startRow(plugin, next);
    return "started";
}

/**
 * Finish and go on: tick the running row, stop its session, start the next
 * line. With nothing running it just starts the next line.
 */
export async function doneAndNext(
    plugin: FullCalendarPlugin
): Promise<"started" | "finished" | "nothing"> {
    const running = findRunningSessions(plugin);
    const rows = collectTodayRows(plugin);
    const current = rows.find((r) => !r.done && sessionOfRow(r, running));
    for (const session of running) {
        await stopSession(plugin, session);
    }
    if (current) {
        await plugin.cache.processEvent(current.id, (e) => toggleTask(e, true));
    }
    const next = rows.find((r) => !r.done && r.id !== current?.id);
    if (!next) {
        return current ? "finished" : "nothing";
    }
    await startRow(plugin, next);
    return "started";
}

/**
 * Put lines in a new order without disturbing anything around them: the
 * lines at `order` (line indexes, in the order wanted) are written back
 * into those same positions, sorted. Everything else in the note — blank
 * lines, a placeholder bullet, other sections — stays where it was.
 */
export function reorderLines(lines: string[], order: number[]): string[] {
    const slots = [...order].sort((a, b) => a - b);
    const out = [...lines];
    order.forEach((from, k) => {
        out[slots[k]] = lines[from];
    });
    return out;
}
