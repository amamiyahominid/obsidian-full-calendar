import { Notice } from "obsidian";
import { DateTime } from "luxon";
import DailyNoteCalendar from "../calendars/DailyNoteCalendar";
import { OFCEvent } from "../types";
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
 * Timed sessions default to one hour (clamped to midnight); all-day drops
 * (month view, all-day lane) become all-day sessions.
 */
export async function createSession(
    plugin: FullCalendarPlugin,
    taskLink: string,
    start: Date,
    allDay: boolean
): Promise<boolean> {
    const calendarId = getWorklogCalendarId(plugin);
    if (!calendarId) {
        new Notice(
            'No work-log calendar configured. Add a "Daily Note" calendar (e.g. under a 作業ログ heading) in the Full Calendar settings.'
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
        const end = dt.plus({ hours: 1 });
        event = {
            type: "single",
            title: taskLink,
            date,
            endDate: null,
            allDay: false,
            startTime: dt.toFormat("HH:mm"),
            endTime: end.toISODate() === date ? end.toFormat("HH:mm") : "23:59",
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
