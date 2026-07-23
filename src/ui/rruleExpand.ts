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
 * Which fields hold an occurrence's calendar day depends on how the rrule
 * string was written (see toEventInput in interop.ts, which always emits
 * Z-suffixed datetimes today):
 *   - Timezone-specified (Z) rrules produce occurrences that are REAL
 *     instants, so the calendar day must be read in the host's local zone.
 *     Reading UTC fields here shifted every event whose local time is before
 *     the UTC offset (e.g. a 07:00 JST event = 22:00Z the previous day) back
 *     by one day.
 *   - Floating rrules pack the wall clock into UTC fields, so the day must be
 *     read back out of UTC.
 */
export function expandRRuleOccurrences(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errd: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fr: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    de: any
): Date[] {
    const dtstart: Date = errd.rruleSet._dtstart;
    const hours = dtstart.getHours();
    const minutes = dtstart.getMinutes();
    const endDate = de.toDate(fr.end);
    endDate.setHours(23, 59, 59, 999);
    // Look back one extra day so a cross-midnight occurrence (e.g.
    // 22:00–08:00) that STARTS the day before the requested window still
    // produces its morning segment inside the window. Out-of-window
    // occurrences this admits don't intersect the view and aren't rendered.
    const startDate = de.toDate(fr.start);
    startDate.setDate(startDate.getDate() - 1);
    return errd.rruleSet.between(startDate, endDate, true).map((d: Date) => {
        const [year, month, day] = errd.isTimeZoneSpecified
            ? [d.getFullYear(), d.getMonth(), d.getDate()]
            : [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
        return new Date(Date.UTC(year, month, day, hours, minutes));
    });
}
