import { EventApi, EventInput } from "@fullcalendar/core";
import { OFCEvent } from "../types";

import { DateTime, Duration } from "luxon";
import { rrulestr } from "rrule";
import { STATUS_COLORS, contrastTextColor } from "./colors";

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
        // NOTE: how exdates are handled does not support events which recur more than once per day.
        // Build each exdate from the skipDate's calendar day plus dtstart's local
        // wall-clock time, then convert to ISO (UTC) so it lines up with what
        // rrule emits internally. Pre-fix this used `toISOString().split("T")[1]`
        // which mixed the dtstart's UTC time onto the exdate's local date and
        // produced exdates that drifted by the host's UTC offset.
        const exdate = frontmatter.skipDates
            .map((d) => {
                const date = DateTime.fromISO(d).toISODate();
                if (!date) {
                    return undefined;
                }
                const local = dtstart.toJSDate();
                const [year, month, day] = date
                    .split("-")
                    .map((p) => parseInt(p, 10));
                const exdateLocal = new Date(
                    year,
                    month - 1,
                    day,
                    local.getHours(),
                    local.getMinutes(),
                    local.getSeconds()
                );
                return exdateLocal.toISOString();
            })
            .flatMap((d) => (d ? d : []));

        // For all-day rrules, anchor DTSTART at noon UTC on the start day so
        // that hosts both east and west of UTC stay on the same calendar day.
        // Timed events still use the local-time dtstart so the wall-clock
        // recurrence is preserved.
        const rruleDtstart = frontmatter.allDay
            ? (() => {
                  const [year, month, day] = frontmatter.startDate
                      .split("-")
                      .map((p) => parseInt(p, 10));
                  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
              })()
            : dtstart.toJSDate();

        event = {
            id,
            title: frontmatter.title,
            allDay: frontmatter.allDay,
            rrule: rrulestr(frontmatter.rrule, {
                dtstart: rruleDtstart,
            }).toString(),
            exdate,
            // Carry the source rule so fromEventApi() can reconstruct an
            // "rrule" OFCEvent on drag/resize instead of corrupting it into a
            // single event (which would happen if only `daysOfWeek` decided
            // the type).
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
                const duration = endTime?.minus(startTime);
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
                extendedProps: {
                    isTask:
                        frontmatter.completed !== undefined &&
                        frontmatter.completed !== null,
                    taskCompleted: frontmatter.completed,
                },
            };
        } else {
            event = {
                ...event,
                start: frontmatter.date,
                end: frontmatter.endDate || undefined,
                extendedProps: {
                    isTask:
                        frontmatter.completed !== undefined &&
                        frontmatter.completed !== null,
                    taskCompleted: frontmatter.completed,
                },
            };
        }
    }

    // Color the fill by task status (border stays the source color, which the
    // FullCalendar source applies). Unknown/absent statuses keep source color.
    if (frontmatter.type === "single" && frontmatter.status) {
        const statusColor = STATUS_COLORS[frontmatter.status];
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
                  ...(startDate !== endDate ? { endDate } : { endDate: null }),
                  completed: event.extendedProps.taskCompleted,
              }),
    };
}
