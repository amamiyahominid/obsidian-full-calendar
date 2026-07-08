import { DateTime } from "luxon";

/*
 * Sprint helpers for the kanban board's "group by sprint" mode.
 *
 * Sprints are ISO weeks serialized as "2026-W27" (zero-padded, ISO week-year),
 * matching how metadata-menu writes them into task frontmatter. Because the
 * format is fixed-width, chronological order equals lexicographic order, so
 * past/future checks are plain string comparisons.
 */

const WEEK_RE = /^\d{4}-W\d{2}$/;

/** The ISO week `offset` weeks from now, e.g. weekOf(0) === "2026-W27". */
export function weekOf(offset: number, now: DateTime = DateTime.now()): string {
    return now.plus({ weeks: offset }).toFormat("kkkk-'W'WW");
}

export function isWeekString(s: string): boolean {
    return WEEK_RE.test(s);
}

/**
 * Which sprint-mode column a card belongs in.
 *
 * - no sprint → "none" (the backlog column)
 * - a past week & unfinished → "carryover"
 * - a past week & done → null (hidden; retrospectives live in status mode)
 * - anything else (current/future week, or a malformed value) → itself,
 *   so out-of-window weeks and garbage values surface as extra columns
 *   instead of silently disappearing.
 */
export function sprintBucket(
    sprint: string | null | undefined,
    done: boolean,
    currentWeek: string
): string | null {
    if (!sprint) {
        return "none";
    }
    if (isWeekString(sprint) && sprint < currentWeek) {
        return done ? null : "carryover";
    }
    return sprint;
}

/**
 * Sum the scheduled minutes of (startTime, endTime) pairs. Times parse as
 * 24-hour "HH:mm" or 12-hour "h:mm a" (the two formats the plugin reads);
 * pairs that don't parse or aren't positive are skipped.
 */
export function totalScheduledMinutes(
    times: { startTime?: string; endTime?: string | null }[]
): number {
    let total = 0;
    for (const { startTime, endTime } of times) {
        if (!startTime || !endTime) {
            continue;
        }
        const start = parseTime(startTime);
        const end = parseTime(endTime);
        if (start === null || end === null || end <= start) {
            continue;
        }
        total += end - start;
    }
    return total;
}

/**
 * ISO date of the Monday starting the given week ("2026-W28" → "2026-07-06"),
 * or null for strings that aren't parseable ISO weeks.
 */
export function weekStartDate(week: string): string | null {
    const parsed = DateTime.fromISO(`${week}-1`);
    return parsed.isValid ? parsed.toISODate() : null;
}

/** Minutes since midnight, or null if the string isn't a recognized time. */
function parseTime(time: string): number | null {
    for (const format of ["HH:mm", "h:mm a"]) {
        const parsed = DateTime.fromFormat(time, format);
        if (parsed.isValid) {
            return parsed.hour * 60 + parsed.minute;
        }
    }
    return null;
}

/** "90" minutes → "1.5h", rounded to one decimal. */
export function formatHours(minutes: number): string {
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `${hours}h`;
}
