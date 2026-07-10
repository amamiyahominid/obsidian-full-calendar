import { Notice } from "obsidian";
import { DateTime } from "luxon";
import DailyNoteCalendar from "../calendars/DailyNoteCalendar";
import { OFCEvent } from "../types";
import { totalScheduledMinutes } from "../ui/sprint";
import type FullCalendarPlugin from "../main";

/*
 * Work-log sessions: one line per work session in the daily note, linked to a
 * task note with a wikilink, e.g.
 *
 *   ## 作業ログ
 *   - [[2026-07-08 APIリファクタ]] [startTime:: 14:00]  [endTime:: 15:00]
 *
 * Tasks themselves never move onto the calendar — sessions do. The heading
 * daily-note calendar (the non-TODO one) is the destination for all sessions.
 */

/** The calendar sessions are written to: the heading-mode daily note
 * calendar. There is at most one (settings enforce it). */
export function getWorklogCalendarId(
    plugin: FullCalendarPlugin
): string | null {
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (cal instanceof DailyNoteCalendar && !cal.todos) {
            return source.id;
        }
    }
    return null;
}

/**
 * Persist a work session for the given task wikilink starting at `start`.
 * Timed sessions run until `end` when given, else one hour (either way
 * clamped to midnight); all-day drops (month view, all-day lane) become
 * all-day sessions.
 */
export async function createSession(
    plugin: FullCalendarPlugin,
    taskLink: string,
    start: Date,
    allDay: boolean,
    end?: Date
): Promise<boolean> {
    const calendarId = getWorklogCalendarId(plugin);
    if (!calendarId) {
        new Notice(
            'No work-log calendar configured. Add a "Daily Note" calendar in the Full Calendar settings — sessions are written under its heading.'
        );
        return false;
    }
    const dt = DateTime.fromJSDate(start);
    const date = dt.toISODate();
    let event: OFCEvent;
    if (allDay) {
        event = {
            type: "single",
            title: taskLink,
            date,
            endDate: null,
            allDay: true,
        };
    } else {
        const endDt = end ? DateTime.fromJSDate(end) : dt.plus({ hours: 1 });
        event = {
            type: "single",
            title: taskLink,
            date,
            endDate: null,
            allDay: false,
            startTime: dt.toFormat("HH:mm"),
            endTime:
                endDt.toISODate() === date ? endDt.toFormat("HH:mm") : "23:59",
        };
    }
    try {
        return await plugin.cache.addEvent(calendarId, event);
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
        return false;
    }
}

/**
 * The wikilink target (note basename, no .md) of an editable event's file.
 * Used as the join key between task cards and their session lines.
 */
export function linktextForEvent(
    plugin: FullCalendarPlugin,
    eventId: string
): string | null {
    try {
        const { location } = plugin.cache.getInfoForEditableEvent(eventId);
        const path = location?.path;
        if (!path) {
            return null;
        }
        return path.split("/").pop()!.replace(/\.md$/, "");
    } catch {
        return null;
    }
}

/**
 * Total logged minutes per task linktext across all closed session lines.
 * Running sessions (no endTime) and all-day sessions don't count until
 * they're given real times.
 */
export function actualMinutesByLinktext(
    plugin: FullCalendarPlugin
): Map<string, number> {
    const totals = new Map<string, number>();
    const calendarId = getWorklogCalendarId(plugin);
    if (!calendarId) {
        return totals;
    }
    const source = plugin.cache.getAllEvents().find((s) => s.id === calendarId);
    if (!source) {
        return totals;
    }
    for (const { event } of source.events) {
        if (event.type !== "single" || event.allDay) {
            continue;
        }
        const link = firstLinktext(event.title);
        if (!link) {
            continue;
        }
        const minutes = totalScheduledMinutes([event]);
        if (minutes > 0) {
            totals.set(link, (totals.get(link) ?? 0) + minutes);
        }
    }
    return totals;
}

// ---- Running sessions (start/stop buttons) ----
//
// A session line with a startTime but no endTime is "running". The note is
// the only state: restarts, device switches, and manual edits all agree.

export type RunningSession = {
    id: string;
    event: Extract<OFCEvent, { type: "single"; allDay: false }>;
};

/** The first wikilink target in a session title ("[[a|b]] x" → "a"). */
export function firstLinktext(title: string): string | null {
    const m = title.match(/\[\[([^\]|#]+)/);
    return m ? m[1].trim() : null;
}

export function findRunningSessions(
    plugin: FullCalendarPlugin
): RunningSession[] {
    const calendarId = getWorklogCalendarId(plugin);
    if (!calendarId) {
        return [];
    }
    const source = plugin.cache.getAllEvents().find((s) => s.id === calendarId);
    if (!source) {
        return [];
    }
    const running: RunningSession[] = [];
    for (const { id, event } of source.events) {
        if (event.type !== "single" || event.allDay) {
            continue;
        }
        if (event.startTime && !event.endTime) {
            running.push({ id, event });
        }
    }
    return running;
}

/**
 * Close a running session. Sessions from a previous day (forgotten stops)
 * are closed at 23:59 of their own day; fine-tune by resizing the block.
 */
export async function stopSession(
    plugin: FullCalendarPlugin,
    session: RunningSession
): Promise<boolean> {
    const now = DateTime.now();
    const endTime =
        session.event.date === now.toISODate()
            ? now.toFormat("HH:mm")
            : "23:59";
    try {
        await plugin.cache.updateEventWithId(session.id, {
            ...session.event,
            endTime,
        });
        return true;
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
        return false;
    }
}

/**
 * Re-open an existing session block as THE running session (any other
 * running session is stopped first). A block on today keeps its planned
 * startTime — clearing only endTime — unless that time is still ahead of
 * the clock (starting early: a session can't run from the future). Blocks
 * on other days move to today and start now; their planned time says
 * nothing about when work actually began.
 */
export async function startSessionFromBlock(
    plugin: FullCalendarPlugin,
    id: string,
    event: OFCEvent
): Promise<boolean> {
    if (event.type !== "single") {
        return false;
    }
    for (const running of findRunningSessions(plugin)) {
        if (running.id !== id) {
            await stopSession(plugin, running);
        }
    }
    const now = DateTime.now();
    const today = now.toISODate();
    const nowTime = now.toFormat("HH:mm");
    const planned = !event.allDay ? event.startTime : null;
    const startTime =
        event.date === today && planned && planned <= nowTime
            ? planned
            : nowTime;
    try {
        const updated = await plugin.cache.updateEventWithId(id, {
            ...event,
            date: today,
            endDate: null,
            allDay: false,
            startTime,
            endTime: null,
        });
        return !!updated;
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
        return false;
    }
}

/**
 * Start working on a task now: writes a running session line into today's
 * daily note. One thing at a time — any currently running session is stopped
 * first, so switching tasks is a single click.
 */
export async function startSession(
    plugin: FullCalendarPlugin,
    taskLink: string
): Promise<boolean> {
    for (const running of findRunningSessions(plugin)) {
        await stopSession(plugin, running);
    }
    const calendarId = getWorklogCalendarId(plugin);
    if (!calendarId) {
        new Notice(
            'No work-log calendar configured. Add a "Daily Note" calendar in the Full Calendar settings — sessions are written under its heading.'
        );
        return false;
    }
    const now = DateTime.now();
    const event: OFCEvent = {
        type: "single",
        title: taskLink,
        date: now.toISODate(),
        endDate: null,
        allDay: false,
        startTime: now.toFormat("HH:mm"),
        endTime: null,
    };
    try {
        return await plugin.cache.addEvent(calendarId, event);
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
        return false;
    }
}
