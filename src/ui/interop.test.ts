/**
 * Boundary tests for rrule events as FullCalendar actually expands them.
 *
 * IMPORTANT: the calendar view does NOT use @fullcalendar/rrule's stock
 * `expand` — calendar.ts replaces it with expandRRuleOccurrences (see
 * rruleExpand.ts). These tests drive toEventInput()'s rrule string through
 * the plugin's real `parse` and then through that replacement expand, so a
 * regression anywhere between OFCEvent and the rendered occurrence days
 * shows up here. (An earlier version of this test used the pristine plugin
 * expand and missed a real one-day shift for JST morning events.)
 *
 * Scenario under test: a Google Calendar "this and following events" edit on
 * a JST calendar. Google splits the recurrence at local midnight of the split
 * day, expressed in UTC (UNTIL=...T145959Z == 23:59:59 JST). The old series
 * must keep its last occurrence on the day before the split, and the new
 * series must not start a day early — including for events whose local time
 * is before the UTC offset (a 07:00 JST event is 22:00Z the PREVIOUS day).
 */
// NOTE: these tests rely on jest.config.js pinning TZ=Asia/Tokyo. The
// east-of-UTC day-shift guarded against here is structurally invisible at
// UTC (local reads and UTC reads of a real instant coincide there).
import "@fullcalendar/core";
import { DateEnv } from "@fullcalendar/common";
import rrulePlugin from "@fullcalendar/rrule";

import { fromEventApi, toEventInput } from "./interop";
import { expandRRuleOccurrences } from "./rruleExpand";
import { OFCEvent } from "../types";

// Marker for the local wall-clock time FullCalendar would display. FC markers
// are UTC-coded local datetimes, so this is timezone-independent.
const marker = (y: number, mon: number, d: number, h = 0, min = 0): number =>
    Date.UTC(y, mon - 1, d, h, min);

const dateEnv = new DateEnv({
    timeZone: "local",
    calendarSystem: "gregory",
    locale: {
        codeArg: "en",
        codes: ["en"],
        week: { dow: 0, doy: 4 },
        simpleNumberFormat: new Intl.NumberFormat("en"),
        options: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recurringType = (rrulePlugin as any).recurringTypes[0];

function expandDisplayedMarkers(event: OFCEvent, from: number, to: number) {
    const input = toEventInput("test", event);
    expect(input).toBeTruthy();
    const parsed = recurringType.parse(
        { rrule: input!.rrule, duration: null },
        dateEnv
    );
    expect(parsed).toBeTruthy();
    const markers: Date[] = expandRRuleOccurrences(
        parsed.typeData,
        { start: new Date(from), end: new Date(to) },
        dateEnv
    );
    return markers.map((m) => m.valueOf());
}

const rruleEvent = (
    title: string,
    startDate: string,
    startTime: string,
    endTime: string,
    rrule: string
): OFCEvent => ({
    type: "rrule",
    title,
    id: `ics::${title}::${startDate}::recurring`,
    rrule,
    skipDates: [],
    startDate,
    allDay: false,
    startTime,
    endTime,
});

describe("JST this-and-following split boundary", () => {
    const windowStart = marker(2026, 6, 28);
    const windowEnd = marker(2026, 7, 8);

    describe("morning event (local time before the UTC offset)", () => {
        const oldSeries = rruleEvent(
            "Old series",
            "2026-05-26",
            "06:00",
            "07:30",
            "DTSTART:20260526T060000\nRRULE:FREQ=DAILY;UNTIL=20260702T145959Z"
        );
        const newSeries = rruleEvent(
            "New series",
            "2026-07-03",
            "07:00",
            "08:30",
            "DTSTART:20260703T070000\nRRULE:FREQ=DAILY"
        );

        it("keeps the old series through 7/2 at the old time and no further", () => {
            const days = expandDisplayedMarkers(
                oldSeries,
                windowStart,
                windowEnd
            );
            expect(days).toContain(marker(2026, 7, 1, 6, 0));
            expect(days).toContain(marker(2026, 7, 2, 6, 0));
            expect(Math.max(...days)).toBe(marker(2026, 7, 2, 6, 0));
        });

        it("starts the new series exactly on 7/3 at the new time", () => {
            const days = expandDisplayedMarkers(
                newSeries,
                windowStart,
                windowEnd
            );
            expect(Math.min(...days)).toBe(marker(2026, 7, 3, 7, 0));
            expect(days).toContain(marker(2026, 7, 4, 7, 0));
            // Nothing may leak onto 7/2.
            expect(days.filter((d) => d < marker(2026, 7, 3))).toEqual([]);
        });
    });

    describe("afternoon event (local time after the UTC offset)", () => {
        const afternoon = rruleEvent(
            "Afternoon",
            "2026-05-26",
            "16:00",
            "17:00",
            "DTSTART:20260526T160000\nRRULE:FREQ=DAILY;UNTIL=20260702T145959Z"
        );

        it("keeps the last occurrence on 7/2", () => {
            const days = expandDisplayedMarkers(
                afternoon,
                windowStart,
                windowEnd
            );
            expect(days).toContain(marker(2026, 7, 2, 16, 0));
            expect(Math.max(...days)).toBe(marker(2026, 7, 2, 16, 0));
        });
    });
});

describe("cross-midnight rrule event (Google ICS 22:00–08:00 daily)", () => {
    const overnight = rruleEvent(
        "Overnight",
        "2026-07-23",
        "22:00",
        "08:00",
        "DTSTART:20260723T220000\nRRULE:FREQ=DAILY"
    );

    it("wraps the negative end-minus-start into a positive next-day duration", () => {
        const input = toEventInput("test", overnight);
        expect(input!.duration).toBe("10:00");
    });

    it("expands the occurrence that starts the day before the window so its morning segment can render", () => {
        // A day view of 7/24 must include the occurrence starting 7/23 22:00,
        // whose 00:00–08:00 tail falls inside the window.
        const days = expandDisplayedMarkers(
            overnight,
            marker(2026, 7, 24),
            marker(2026, 7, 25)
        );
        expect(days).toContain(marker(2026, 7, 23, 22, 0));
        expect(days).toContain(marker(2026, 7, 24, 22, 0));
    });
});

describe("BYDAY rrule from a JST feed (weekly Google event + moved override)", () => {
    // Google emits the series as BYDAY=WE. The rrule library is UTC-naive, so
    // a real-instant DTSTART (08:00 JST = 23:00Z the day before) made it pick
    // the UTC Wednesday — rendering every occurrence on Thursday, right next
    // to the RECURRENCE-ID override that legitimately moved to Thursday, and
    // out of reach of the skipDates hiding (which keys on the original day).
    const weekly = rruleEvent(
        "レビュー",
        "2026-07-29",
        "08:00",
        "10:00",
        "DTSTART:20260729T080000\nRRULE:FREQ=WEEKLY;BYDAY=WE"
    );

    it("emits a floating rrule so the library reads the local wall clock", () => {
        expect(toEventInput("test", weekly)!.rrule).toBe(
            "DTSTART:20260729T080000\nRRULE:FREQ=WEEKLY;BYDAY=WE"
        );
    });

    it("renders on the Wednesday, not the day after", () => {
        const days = expandDisplayedMarkers(
            weekly,
            marker(2026, 7, 26),
            marker(2026, 8, 2)
        );
        expect(days).toEqual([marker(2026, 7, 29, 8, 0)]);
    });

    it("keeps a monthly BYDAY rule on its nth weekday", () => {
        // 4th Wednesday of August 2026 is the 26th.
        const monthly = rruleEvent(
            "Monthly review",
            "2026-07-29",
            "08:00",
            "10:00",
            "DTSTART:20260729T080000\nRRULE:FREQ=MONTHLY;BYDAY=+4WE"
        );
        const days = expandDisplayedMarkers(
            monthly,
            marker(2026, 8, 1),
            marker(2026, 9, 1)
        );
        expect(days).toEqual([marker(2026, 8, 26, 8, 0)]);
    });
});

describe("fromEventApi single-day all-day normalization", () => {
    const api = (overrides: Record<string, unknown>) =>
        ({
            title: "todo",
            extendedProps: { ofcCompleted: false },
            ...overrides,
        } as unknown as Parameters<typeof fromEventApi>[0]);

    it("normalizes a one-day all-day event (exclusive next-midnight end) to endDate: null", () => {
        const result = fromEventApi(
            api({
                allDay: true,
                start: new Date(2026, 6, 8, 0, 0, 0),
                end: new Date(2026, 6, 9, 0, 0, 0),
            })
        );
        expect(result).toEqual(
            expect.objectContaining({
                type: "single",
                date: "2026-07-08",
                endDate: null,
                allDay: true,
            })
        );
    });

    it("keeps the exclusive end for genuine multi-day spans", () => {
        const result = fromEventApi(
            api({
                allDay: true,
                start: new Date(2026, 6, 8, 0, 0, 0),
                end: new Date(2026, 6, 10, 0, 0, 0),
            })
        );
        expect(result).toEqual(
            expect.objectContaining({
                date: "2026-07-08",
                endDate: "2026-07-10",
            })
        );
    });
});
