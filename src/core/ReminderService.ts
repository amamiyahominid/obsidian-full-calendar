import { Notice, Platform, TFile } from "obsidian";
import { DateTime } from "luxon";
import { rrulestr } from "rrule";
import type FullCalendarPlugin from "../main";
import { OFCEvent } from "../types";

const SECOND = 1000;
// How often we scan the cache for upcoming events. 30s keeps notifications
// punctual without being wasteful; it also bounds how late a reminder can fire
// (at most one tick after the threshold is crossed).
const CHECK_INTERVAL_MS = 30 * SECOND;

// Maps a JS weekday index (0 = Sunday) to Full Calendar's day codes.
const DAYS = "UMTWRFS";

/**
 * Fires native OS notifications a configurable number of minutes before an
 * event starts. Desktop-only: iOS/Android WebViews don't support the Web
 * Notification API and suspend background timers, so the service no-ops there.
 *
 * It reads from the same in-memory EventCache the calendar view uses, so it
 * covers every source — local notes, daily notes, and remote (ical/CalDAV)
 * calendars — including recurring and rrule events.
 */
export default class ReminderService {
    private plugin: FullCalendarPlugin;
    private intervalId: number | null = null;
    // De-dupe set: "<eventId>::<occurrenceISO>" -> occurrence epoch ms.
    // The value is kept so we can prune past entries and not leak memory.
    private notified = new Map<string, number>();

    constructor(plugin: FullCalendarPlugin) {
        this.plugin = plugin;
    }

    /**
     * Start the polling loop if reminders are enabled and we're on desktop.
     * Safe to call repeatedly — a second call while running is a no-op.
     */
    start(): void {
        if (!Platform.isDesktopApp) {
            return;
        }
        if (!this.plugin.settings.enableReminders) {
            return;
        }
        if (this.intervalId !== null) {
            return;
        }
        this.requestPermission();
        // Run once immediately so a reminder window that's already open fires
        // right away (e.g. opening Obsidian 5 minutes before a meeting).
        this.check();
        this.intervalId = window.setInterval(
            () => this.check(),
            CHECK_INTERVAL_MS
        );
        // Let Obsidian clear the interval on unload as a backstop.
        this.plugin.registerInterval(this.intervalId);
    }

    stop(): void {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /** Apply changed settings (enable/disable, minutes). */
    restart(): void {
        this.stop();
        this.start();
    }

    private requestPermission(): void {
        if (
            typeof Notification !== "undefined" &&
            Notification.permission === "default"
        ) {
            Notification.requestPermission().catch(() => {
                /* user can grant later via OS settings */
            });
        }
    }

    private notify(title: string, body: string, eventId: string): void {
        if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
        ) {
            try {
                const n = new Notification(title, { body });
                n.onclick = () => this.openEvent(eventId);
                return;
            } catch (e) {
                console.error("FC: native notification failed", e);
            }
        }
        // Fallback to an in-app toast if the OS notification isn't available.
        const notice = new Notice(`${title}\n${body}`);
        // `noticeEl` is a runtime property not present in the public typings.
        const noticeEl = (notice as unknown as { noticeEl: HTMLElement })
            .noticeEl;
        noticeEl.style.cursor = "pointer";
        noticeEl.addEventListener("click", () => this.openEvent(eventId));
    }

    /**
     * Navigate to the event's note (focusing Obsidian first). Remote events
     * have no file, so they fall back to opening the calendar view.
     */
    private async openEvent(eventId: string): Promise<void> {
        try {
            window.focus();
        } catch (e) {
            /* best-effort: OS usually focuses the app on notification click */
        }
        const location = this.plugin.cache.getEventLocation(eventId);
        if (location?.path) {
            const file = this.plugin.app.vault.getAbstractFileByPath(
                location.path
            );
            if (file instanceof TFile) {
                const leaf = this.plugin.app.workspace.getLeaf(false);
                await leaf.openFile(
                    file,
                    location.lineNumber != null
                        ? { eState: { line: location.lineNumber } }
                        : undefined
                );
                return;
            }
        }
        // Remote (ical/CalDAV) event or missing file — open the calendar.
        await this.plugin.activateView();
    }

    private check(): void {
        const minutes = this.plugin.settings.reminderMinutesBefore;
        if (!Number.isFinite(minutes) || minutes < 0) {
            return;
        }

        // The cache is populated lazily when the calendar view first opens.
        // Trigger a populate so reminders work even if the user never opens the
        // view; we'll read the results on the next tick.
        if (!this.plugin.cache.initialized) {
            this.plugin.cache.populate();
            return;
        }

        const now = DateTime.now();
        this.prune(now);

        // Look at today and tomorrow so reminders that span midnight (e.g. a
        // 30-minute lead time at 00:10) still fire.
        const days = [now.startOf("day"), now.startOf("day").plus({ days: 1 })];

        for (const source of this.plugin.cache.getAllEvents()) {
            for (const { event, id } of source.events) {
                if (event.allDay) {
                    continue; // "N minutes before" has no meaning for all-day.
                }
                for (const day of days) {
                    const start = this.occurrenceStart(event, day);
                    if (!start) {
                        continue;
                    }
                    const reminderAt = start.minus({ minutes });
                    // Fire once the reminder threshold is reached, but only
                    // while the event hasn't started yet.
                    if (now >= reminderAt && now < start) {
                        const key = `${id}::${start.toISO()}`;
                        if (this.notified.has(key)) {
                            continue;
                        }
                        this.notified.set(key, start.toMillis());
                        this.fire(event, id, start, now);
                    }
                }
            }
        }
    }

    private fire(
        event: OFCEvent,
        id: string,
        start: DateTime,
        now: DateTime
    ): void {
        const minsAway = Math.round(start.diff(now, "minutes").minutes);
        const when = start.toFormat(
            this.plugin.settings.timeFormat24h ? "HH:mm" : "h:mm a"
        );
        const body =
            minsAway <= 0
                ? `Starting now · ${when}`
                : `Starts in ${minsAway} min · ${when}`;
        this.notify(event.title || "(untitled event)", body, id);
    }

    /**
     * The start DateTime for this event on the given local calendar day, or
     * null if the event doesn't occur that day. All-day events are filtered
     * out before this is called.
     */
    private occurrenceStart(event: OFCEvent, day: DateTime): DateTime | null {
        if (event.allDay) {
            return null;
        }
        if (!this.occursOnDay(event, day)) {
            return null;
        }
        const hm = this.parseTime(event.startTime);
        if (!hm) {
            return null;
        }
        return day.set({
            hour: hm.hour,
            minute: hm.minute,
            second: 0,
            millisecond: 0,
        });
    }

    private occursOnDay(event: OFCEvent, day: DateTime): boolean {
        const iso = day.toISODate();
        if (event.type === "single") {
            return event.date === iso;
        }
        if (event.type === "recurring") {
            const code = DAYS[day.weekday % 7]; // luxon: Mon=1..Sun=7 → Sun=0
            if (!event.daysOfWeek.includes(code as any)) {
                return false;
            }
            if (event.startRecur && iso < event.startRecur) {
                return false;
            }
            if (event.endRecur && iso > event.endRecur) {
                return false;
            }
            return true;
        }
        if (event.type === "rrule") {
            if (event.skipDates.some((d) => d.startsWith(iso))) {
                return false;
            }
            return this.rruleHitsDay(event, day);
        }
        return false;
    }

    private rruleHitsDay(
        event: Extract<OFCEvent, { type: "rrule" }>,
        day: DateTime
    ): boolean {
        const parts = event.startDate.split("-").map((p) => parseInt(p, 10));
        const [y, m, d] = parts;
        if (!y || !m || !d) {
            return false;
        }
        // Anchor at noon UTC so occurrences land squarely inside a UTC calendar
        // day regardless of the host's timezone offset (mirrors interop.ts).
        const dtstart = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        try {
            const rule = rrulestr(event.rrule, { dtstart });
            const dayStart = new Date(
                Date.UTC(day.year, day.month - 1, day.day, 0, 0, 0)
            );
            const dayEnd = new Date(
                Date.UTC(day.year, day.month - 1, day.day, 23, 59, 59)
            );
            return rule.between(dayStart, dayEnd, true).length > 0;
        } catch (e) {
            console.error("FC: failed to parse rrule for reminder", e);
            return false;
        }
    }

    private parseTime(time: string): { hour: number; minute: number } | null {
        for (const fmt of ["h:mm a", "HH:mm", "HH:mm:ss"]) {
            const parsed = DateTime.fromFormat(time, fmt);
            if (!parsed.invalidReason) {
                return { hour: parsed.hour, minute: parsed.minute };
            }
        }
        return null;
    }

    /** Drop de-dupe entries for occurrences more than a day in the past. */
    private prune(now: DateTime): void {
        const cutoff = now.minus({ days: 1 }).toMillis();
        for (const [key, ms] of this.notified) {
            if (ms < cutoff) {
                this.notified.delete(key);
            }
        }
    }
}
