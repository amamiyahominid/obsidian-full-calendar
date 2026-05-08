import ical from "ical.js";
import { OFCEvent, validateEvent } from "../../types";
import { rrulestr } from "rrule";

// Render an ical.Time as YYYY-MM-DD using the host system's local zone.
// The original implementation used UTC, which silently shifted dates
// by ±1 day for users east/west of UTC (most importantly JST users —
// see obsidian-community/obsidian-full-calendar#311).
function getDate(t: ical.Time): string {
    const d = t.toJSDate();
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// HH:MM in the host system's local zone. iCal "VALUE=DATE" entries
// (i.e. floating all-day) are reported as midnight.
function getLocalTime(t: ical.Time): string {
    if (t.isDate) {
        return "00:00";
    }
    const d = t.toJSDate();
    const hours = d.getHours().toString().padStart(2, "0");
    const minutes = d.getMinutes().toString().padStart(2, "0");
    return `${hours}:${minutes}`;
}

function specifiesEnd(iCalEvent: ical.Event) {
    return (
        Boolean(iCalEvent.component.getFirstProperty("dtend")) ||
        Boolean(iCalEvent.component.getFirstProperty("duration"))
    );
}

function icsToOFC(input: ical.Event): OFCEvent {
    if (input.isRecurring()) {
        // Re-anchor the rrule's DTSTART to the local wall-clock value of the
        // event start, packed into a UTC Date. rrule operates on UTC and
        // FullCalendar later interprets DTSTART as local time, so we want
        // "the wall clock the user sees" to drive the recurrence — without
        // this, weekly events shift by a day around timezone boundaries.
        const rruleString = input.component
            .getFirstProperty("rrule")
            .getFirstValue()
            .toString();
        const localStart = input.startDate.toJSDate();
        const dtstartForRrule = new Date(
            Date.UTC(
                localStart.getFullYear(),
                localStart.getMonth(),
                localStart.getDate(),
                localStart.getHours(),
                localStart.getMinutes(),
                localStart.getSeconds()
            )
        );
        const rrule = rrulestr(rruleString, { dtstart: dtstartForRrule });
        // Strip the trailing Z so FullCalendar reads DTSTART as a floating
        // local time rather than UTC.
        const rruleStr = rrule
            .toString()
            .replace(/^DTSTART:(\d{8}T\d{6})Z/m, "DTSTART:$1");

        const allDay = input.startDate.isDate;
        const exdates = input.component
            .getAllProperties("exdate")
            .map((exdateProp) => {
                const exdate = exdateProp.getFirstValue();
                // NOTE: We only store the date from an exdate and recreate the full datetime exdate later,
                // so recurring events with exclusions that happen more than once per day are not supported.
                return getDate(exdate);
            });

        return {
            type: "rrule",
            title: input.summary,
            id: `ics::${input.uid}::${getDate(input.startDate)}::recurring`,
            rrule: rruleStr,
            skipDates: exdates,
            startDate: getDate(input.startDate),
            ...(allDay
                ? { allDay: true }
                : {
                      allDay: false,
                      startTime: getLocalTime(input.startDate),
                      endTime: getLocalTime(input.endDate),
                  }),
        };
    } else {
        const date = getDate(input.startDate);
        const endDate =
            specifiesEnd(input) && input.endDate
                ? getDate(input.endDate)
                : undefined;
        const allDay = input.startDate.isDate;
        return {
            type: "single",
            id: `ics::${input.uid}::${date}::single`,
            title: input.summary,
            date,
            endDate: date !== endDate ? endDate || null : null,
            ...(allDay
                ? { allDay: true }
                : {
                      allDay: false,
                      startTime: getLocalTime(input.startDate),
                      endTime: getLocalTime(input.endDate),
                  }),
        };
    }
}

export function getEventsFromICS(text: string): OFCEvent[] {
    const jCalData = ical.parse(text);
    const component = new ical.Component(jCalData);

    // TODO: Timezone support
    // const tzc = component.getAllSubcomponents("vtimezone");
    // const tz = new ical.Timezone(tzc[0]);

    const events: ical.Event[] = component
        .getAllSubcomponents("vevent")
        .map((vevent) => new ical.Event(vevent))
        .filter((evt) => {
            evt.iterator;
            try {
                evt.startDate.toJSDate();
                evt.endDate.toJSDate();
                return true;
            } catch (err) {
                // skipping events with invalid time
                return false;
            }
        });

    // Events with RECURRENCE-ID will have duplicated UIDs.
    // We need to modify the base event to exclude those recurrence exceptions.
    const baseEvents = Object.fromEntries(
        events
            .filter((e) => e.recurrenceId === null)
            .map((e) => [e.uid, icsToOFC(e)])
    );

    const recurrenceExceptions = events.filter((e) => e.recurrenceId !== null);

    for (const exception of recurrenceExceptions) {
        const baseEvent = baseEvents[exception.uid];
        if (!baseEvent) {
            continue;
        }
        if (baseEvent.type !== "rrule") {
            console.warn(
                "Recurrence exception found but base event is not recurring",
                { baseEvent, recurrenceException: exception }
            );
            continue;
        }
        // Use the original RECURRENCE-ID rather than the moved date so the
        // exclusion lands on the right slot, even if the exception was moved
        // to a new day.
        baseEvent.skipDates.push(getDate(exception.recurrenceId!));
    }

    const allEvents = Object.values(baseEvents).concat(
        recurrenceExceptions.map((e) => icsToOFC(e))
    );

    return allEvents.map(validateEvent).flatMap((e) => (e ? [e] : []));
}
