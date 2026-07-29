import { EventApi, EventInput } from "@fullcalendar/core";
import { OFCEvent } from "../types";

import { DateTime, Duration } from "luxon";
import { rrulestr } from "rrule";
import { contrastTextColor, getStatusColor, isDoneStatus } from "./colors";

/*
 * Functions for converting between the types used by the FullCalendar view plugin and types used internally by Obsidian Full Calendar.
 */

const parseTime = (time: string): Duration | null => {
    let parsed = DateTime.fromFormat(time, "h:mm a");
    if (parsed.invalidReason) {
        parsed = DateTime.fromFormat(time, "HH:mm");
    }
    if (parsed.invalidReason) {
        parsed = DateTime.fromFormat(time, "HH:mm:ss");
    }

    if (parsed.invalidReason) {
        console.error(
            `FC: Error parsing time string '${time}': ${parsed.invalidReason}'`
        );
        return null;
    }

    return Duration.fromISOTime(
        parsed.toISOTime({
            includeOffset: false,
            includePrefix: false,
        })
    );
};

const normalizeTimeString = (time: string): string | null => {
    const parsed = parseTime(time);
    if (!parsed) {
        return null;
    }
    return parsed.toISOTime({
        suppressMilliseconds: true,
        includePrefix: false,
        suppressSeconds: true,
    });
};

const add = (date: DateTime, time: Duration): DateTime => {
    let hours = time.hours;
    let minutes = time.minutes;
    return date.set({ hour: hours, minute: minutes });
};

const getTime = (date: Date): string =>
    DateTime.fromJSDate(date).toISOTime({
        suppressMilliseconds: true,
        includeOffset: false,
        suppressSeconds: true,
    });

const getDate = (date: Date): string => DateTime.fromJSDate(date).toISODate();

const combineDateTimeStrings = (date: string, time: string): string | null => {
    const parsedDate = DateTime.fromISO(date);
    if (parsedDate.invalidReason) {
        console.error(
            `FC: Error parsing time string '${date}': ${parsedDate.invalidReason}`
        );
        return null;
    }

    const parsedTime = parseTime(time);
    if (!parsedTime) {
        return null;
    }

    return add(parsedDate, parsedTime).toISO({
        includeOffset: false,
        suppressMilliseconds: true,
    });
};

const DAYS = "UMTWRFS";

/**
 * Rewrite a serialized rrule so every datetime in it is FLOATING: the local
 * wall clock packed into UTC fields, with no `Z` anywhere.
 *
 * The rrule library is UTC-naive — it reads a datetime's UTC fields as the
 * wall clock. Handing it a real instant (`DTSTART:20260728T230000Z` for an
 * 08:00 JST event) therefore makes it evaluate the recurrence on the UTC
 * calendar day, which for a morning JST event is the PREVIOUS day: BYDAY=WE
 * picks the UTC Wednesday and every occurrence renders one day late locally.
 * FREQ=DAILY rules hide this because their occurrences don't depend on the
 * weekday/monthday of DTSTART.
 *
 * The `Z` matters for a second reason: @fullcalendar/rrule's
 * `isTimeZoneSpecified` is the OR over DTSTART, EXDATE *and* UNTIL (see
 * `analyzeRRuleString`), and that flag is what picks local- vs UTC-field
 * reads in rruleExpand.ts. A Google "this and following" split carries
 * `UNTIL=…Z`, so leaving it alone would keep the flag true even with a
 * floating DTSTART. UNTIL is a real instant in ICS, so it is converted to
 * the equivalent local wall clock rather than merely stripped.
 */
function toFloatingRRuleString(rrule: string): string {
    return rrule.replace(/^(DTSTART[^:]*:\d{8}T\d{6})Z$/gm, "$1").replace(
        /\b(UNTIL=|EXDATE:)(\d{8}T\d{6})Z/g,
        (_match, key: string, datetime: string) =>
            key +
            DateTime.fromFormat(datetime, "yyyyMMdd'T'HHmmss", {
                zone: "utc",
            })
                .toLocal()
                .toFormat("yyyyMMdd'T'HHmmss")
    );
}

export function dateEndpointsToFrontmatter(
    start: Date,
    end: Date,
    allDay: boolean
): Partial<OFCEvent> {
    const date = getDate(start);
    const endDate = getDate(end);
    return {
        type: "single",
        date,
        endDate: date !== endDate ? endDate : undefined,
        allDay,
        ...(allDay
            ? {}
            : {
                  startTime: getTime(start),
                  endTime: getTime(end),
              }),
    };
}

export function toEventInput(
    id: string,
    frontmatter: OFCEvent
): EventInput | null {
    let event: EventInput = {
        id,
        title: frontmatter.title,
        allDay: frontmatter.allDay,
    };
    if (frontmatter.type === "recurring") {
        event = {
            ...event,
            daysOfWeek: frontmatter.daysOfWeek.map((c) => DAYS.indexOf(c)),
            startRecur: frontmatter.startRecur,
            endRecur: frontmatter.endRecur,
            extendedProps: { isTask: false },
        };
        if (!frontmatter.allDay) {
            event = {
                ...event,
                startTime: normalizeTimeString(frontmatter.startTime || ""),
                endTime: frontmatter.endTime
                    ? normalizeTimeString(frontmatter.endTime)
                    : undefined,
            };
        }
    } else if (frontmatter.type === "rrule") {
        const dtstart = (() => {
            if (frontmatter.allDay) {
                return DateTime.fromISO(frontmatter.startDate);
            } else {
                const dtstartStr = combineDateTimeStrings(
                    frontmatter.startDate,
                    frontmatter.startTime
                );

                if (!dtstartStr) {
                    return null;
                }
                return DateTime.fromISO(dtstartStr);
            }
        })();
        if (dtstart === null) {
            return null;
        }
        // Both branches pack a wall clock into UTC fields (see
        // toFloatingRRuleString): all-day rrules anchor at noon so hosts east
        // and west of UTC stay on the same calendar day, timed rrules keep the
        // event's own local time so the wall-clock recurrence is preserved.
        const rruleDtstart = frontmatter.allDay
            ? (() => {
                  const [year, month, day] = frontmatter.startDate
                      .split("-")
                      .map((p) => parseInt(p, 10));
                  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
              })()
            : new Date(
                  Date.UTC(
                      dtstart.year,
                      dtstart.month - 1,
                      dtstart.day,
                      dtstart.hour,
                      dtstart.minute,
                      dtstart.second
                  )
              );

        // NOTE: we deliberately do NOT hand the recurrence exclusions to
        // FullCalendar (neither a separate `exdate` prop nor an embedded
        // EXDATE line). In the Electron runtime — with our mismatched
        // @fullcalendar plugin versions (rrule 5.11.2 vs common 5.11.4) —
        // rrule's exclusion is unreliable: it either fails to drop the
        // overridden occurrence (leaving a duplicate next to the moved one) or
        // drops the wrong day entirely. rrule still EXPANDS occurrences
        // correctly, so we let it emit every instance and exclude skipDates
        // ourselves in the calendar's eventDidMount (see renderCalendar), which
        // is timezone- and version-independent. `skipDates` is carried in
        // extendedProps for that hook (and for drag/resize reconstruction).
        event = {
            id,
            title: frontmatter.title,
            allDay: frontmatter.allDay,
            rrule: toFloatingRRuleString(
                rrulestr(frontmatter.rrule, {
                    dtstart: rruleDtstart,
                }).toString()
            ),
            extendedProps: {
                isTask: false,
                rrule: frontmatter.rrule,
                skipDates: frontmatter.skipDates,
            },
        };

        if (!frontmatter.allDay) {
            const startTime = parseTime(frontmatter.startTime);
            if (startTime && frontmatter.endTime) {
                const endTime = parseTime(frontmatter.endTime);
                let duration = endTime?.minus(startTime);
                // An end time before the start time means the occurrence
                // crosses midnight (e.g. 22:00–08:00). A negative Duration
                // would make toISOTime() return null and silently drop the
                // duration, so wrap it forward a day.
                if (duration && duration.as("minutes") < 0) {
                    duration = duration.plus({ days: 1 });
                }
                if (duration) {
                    event.duration = duration.toISOTime({
                        includePrefix: false,
                        suppressMilliseconds: true,
                        suppressSeconds: true,
                    });
                }
            }
        }
    } else if (frontmatter.type === "single") {
        // Dateless cards (issues) live on the kanban, never the calendar.
        if (!frontmatter.date) {
            return null;
        }
        // Checkbox display state. `status` (workflow tasks) is the source of
        // truth when present; `completed` covers daily-note checkbox lines.
        // The raw completed value rides along so fromEventApi can round-trip
        // it verbatim instead of writing the derived value into frontmatter.
        const taskProps = {
            isTask:
                frontmatter.status !== undefined ||
                (frontmatter.completed !== undefined &&
                    frontmatter.completed !== null),
            taskCompleted:
                frontmatter.status !== undefined
                    ? isDoneStatus(frontmatter.status)
                    : frontmatter.completed,
            ofcCompleted: frontmatter.completed,
        };
        if (!frontmatter.allDay) {
            const start = combineDateTimeStrings(
                frontmatter.date,
                frontmatter.startTime
            );
            if (!start) {
                return null;
            }
            let end = undefined;
            if (frontmatter.endTime) {
                end = combineDateTimeStrings(
                    frontmatter.endDate || frontmatter.date,
                    frontmatter.endTime
                );
                if (!end) {
                    return null;
                }
            }

            event = {
                ...event,
                start,
                end,
                extendedProps: taskProps,
            };
        } else {
            event = {
                ...event,
                start: frontmatter.date,
                end: frontmatter.endDate || undefined,
                extendedProps: taskProps,
            };
        }
    }

    // Color the fill by task status (border stays the source color, which the
    // FullCalendar source applies). Unknown/absent statuses keep source color.
    if (frontmatter.type === "single" && frontmatter.status) {
        const statusColor = getStatusColor(frontmatter.status);
        if (statusColor) {
            event.backgroundColor = statusColor;
            event.textColor = contrastTextColor(statusColor);
        }
    }

    return event;
}

export function fromEventApi(event: EventApi): OFCEvent {
    const isRecurring: boolean = event.extendedProps.daysOfWeek !== undefined;
    const isRRule: boolean = event.extendedProps.rrule !== undefined;
    const startDate = getDate(event.start as Date);
    // When an all-day event is dragged onto the time-grid, FullCalendar may
    // leave `event.end` null. Fall back to start + 1h so endTime is never lost.
    const start = event.start as Date;
    const end =
        (event.end as Date | null) ??
        new Date(start.getTime() + 60 * 60 * 1000);
    const endDate = getDate(end);
    // All-day events carry an EXCLUSIVE end (next midnight) — with
    // forceEventDuration even a one-day event gets one, e.g. when a timed
    // TODO is dropped onto the all-day lane. That must round-trip as
    // endDate: null, or the daily-note writer rejects it as multi-day and
    // the drop reverts. (Genuine multi-day spans keep the exclusive form
    // for backwards compatibility.)
    const singleDayAllDay =
        event.allDay && getDate(new Date(end.getTime() - 1)) === startDate;
    return {
        title: event.title,
        ...(event.allDay
            ? { allDay: true }
            : {
                  allDay: false,
                  startTime: getTime(start),
                  endTime: getTime(end),
              }),

        ...(isRRule
            ? {
                  type: "rrule",
                  // Preserve the recurrence rule and its exceptions; only the
                  // anchor date follows a drag.
                  rrule: event.extendedProps.rrule,
                  skipDates: event.extendedProps.skipDates ?? [],
                  startDate,
              }
            : isRecurring
            ? {
                  type: "recurring",
                  daysOfWeek: event.extendedProps.daysOfWeek.map(
                      (i: number) => DAYS[i]
                  ),
                  startRecur:
                      event.extendedProps.startRecur &&
                      getDate(event.extendedProps.startRecur),
                  endRecur:
                      event.extendedProps.endRecur &&
                      getDate(event.extendedProps.endRecur),
              }
            : {
                  type: "single",
                  date: startDate,
                  ...(startDate !== endDate && !singleDayAllDay
                      ? { endDate }
                      : { endDate: null }),
                  // Raw value, NOT the status-derived taskCompleted — a drag
                  // must never materialize `completed` in task-note
                  // frontmatter (status owns done-ness there).
                  completed: event.extendedProps.ofcCompleted,
              }),
    };
}
