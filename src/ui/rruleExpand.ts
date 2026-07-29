/**
 * Replacement for @fullcalendar/rrule's recurring-type `expand`.
 *
 * There is an issue with FullCalendar RRule support around DST boundaries
 * which is fixed by this monkeypatch:
 * https://github.com/fullcalendar/fullcalendar/issues/5273#issuecomment-1360459342
 *
 * Tweaks on top of the upstream snippet:
 *   1. Extend the `between` window to the end of the requested day so that
 *      events that occur late in the day (or as a whole-day occurrence) are
 *      not silently dropped at view boundaries.
 *   2. Re-pack each occurrence's calendar day with the dtstart's wall-clock
 *      time so DST shifts can't move the displayed time.
 *
 * Which fields hold an occurrence's calendar day, time and window bounds
 * depends on how the rrule string was written:
 *   - Timezone-specified (Z) rrules produce occurrences that are REAL
 *     instants, so everything must be read in the host's local zone. Reading
 *     UTC fields there shifted every event whose local time is before the UTC
 *     offset (e.g. a 07:00 JST event = 22:00Z the previous day) back by a day.
 *   - Floating rrules pack the wall clock into UTC fields, so everything must
 *     be read back out of UTC.
 * toEventInput now always emits FLOATING rrules (see toFloatingRRuleString in
 * interop.ts — a Z-suffixed DTSTART made the UTC-naive rrule library evaluate
 * BYDAY on the wrong calendar day), but the zoned branch stays correct for any
 * Z-carrying string that reaches this expand.
 */
export function expandRRuleOccurrences(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errd: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fr: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    de: any
): Date[] {
    const zoned: boolean = errd.isTimeZoneSpecified;
    const dtstart: Date = errd.rruleSet._dtstart;
    // The occurrence's time-of-day must be read out of the same field set as
    // its calendar day below: a floating rruleSet holds the wall clock in its
    // UTC fields, so reading local hours there would offset every occurrence.
    const hours = zoned ? dtstart.getHours() : dtstart.getUTCHours();
    const minutes = zoned ? dtstart.getMinutes() : dtstart.getUTCMinutes();
    // Likewise for the query window: real instants are compared against real
    // instants, floating occurrences against FullCalendar's markers (which are
    // themselves UTC-coded local datetimes).
    const startDate = zoned
        ? de.toDate(fr.start)
        : new Date(fr.start.valueOf());
    const endDate = zoned ? de.toDate(fr.end) : new Date(fr.end.valueOf());
    // Extend to the end of the requested day so late-in-the-day occurrences
    // aren't dropped at a view boundary, and look back one extra day so a
    // cross-midnight occurrence (e.g. 22:00–08:00) that STARTS the day before
    // the window still produces its morning segment inside it. Out-of-window
    // occurrences this admits don't intersect the view and aren't rendered.
    if (zoned) {
        endDate.setHours(23, 59, 59, 999);
        startDate.setDate(startDate.getDate() - 1);
    } else {
        endDate.setUTCHours(23, 59, 59, 999);
        startDate.setUTCDate(startDate.getUTCDate() - 1);
    }
    return errd.rruleSet.between(startDate, endDate, true).map((d: Date) => {
        const [year, month, day] = zoned
            ? [d.getFullYear(), d.getMonth(), d.getDate()]
            : [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
        return new Date(Date.UTC(year, month, day, hours, minutes));
    });
}
