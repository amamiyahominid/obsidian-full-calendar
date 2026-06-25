/*
 * Helpers for translating between the EditEvent recurrence form and the
 * RFC-5545 RRULE strings stored on `type: "rrule"` events.
 *
 * Weekly recurrence keeps using the simpler `type: "recurring"` shape
 * (daysOfWeek), so these helpers only cover MONTHLY and YEARLY frequencies,
 * each of which can repeat either on a day-of-month or on an nth weekday
 * (e.g. the 2nd Sunday, or the last Friday).
 */

export type Frequency = "weekly" | "monthly" | "yearly";
export type DayMode = "dayOfMonth" | "weekday";

// RRULE two-letter weekday codes, indexed Sunday..Saturday.
export const RRULE_WEEKDAYS = [
    "SU",
    "MO",
    "TU",
    "WE",
    "TH",
    "FR",
    "SA",
] as const;

export const WEEKDAY_LABELS: Record<string, string> = {
    SU: "Sunday",
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
};

// Ordinal positions for nth-weekday recurrence. -1 means "last".
export const WEEKDAY_POSITIONS: { value: number; label: string }[] = [
    { value: 1, label: "1st" },
    { value: 2, label: "2nd" },
    { value: 3, label: "3rd" },
    { value: 4, label: "4th" },
    { value: -1, label: "Last" },
];

export interface RecurrenceForm {
    frequency: "monthly" | "yearly";
    dayMode: DayMode;
    // dayMode === "dayOfMonth"
    monthDay: number; // 1..31
    // dayMode === "weekday"
    position: number; // 1..4 or -1
    weekday: string; // one of RRULE_WEEKDAYS
    // frequency === "yearly"
    month: number; // 1..12
}

export const DEFAULT_RECURRENCE: RecurrenceForm = {
    frequency: "monthly",
    dayMode: "dayOfMonth",
    monthDay: 1,
    position: 1,
    weekday: "SU",
    month: 1,
};

/**
 * Build a bare RRULE string (no DTSTART — interop.ts anchors that from the
 * event's startDate) from the recurrence form.
 */
export function buildRRule(form: RecurrenceForm): string {
    const parts: string[] = [];
    parts.push(`FREQ=${form.frequency === "yearly" ? "YEARLY" : "MONTHLY"}`);
    if (form.frequency === "yearly") {
        parts.push(`BYMONTH=${form.month}`);
    }
    if (form.dayMode === "dayOfMonth") {
        parts.push(`BYMONTHDAY=${form.monthDay}`);
    } else {
        parts.push(`BYDAY=${form.position}${form.weekday}`);
    }
    return parts.join(";");
}

/**
 * Parse an RRULE string back into form state so an existing rrule event can be
 * edited. Returns null for frequencies the form does not model (e.g. WEEKLY),
 * which keeps callers from silently mangling unsupported rules.
 */
export function parseRRule(rrule: string): RecurrenceForm | null {
    const fields: Record<string, string> = {};
    for (const segment of rrule.replace(/^RRULE:/i, "").split(";")) {
        const [key, value] = segment.split("=");
        if (key && value !== undefined) {
            fields[key.toUpperCase()] = value;
        }
    }

    const freq = fields["FREQ"]?.toUpperCase();
    if (freq !== "MONTHLY" && freq !== "YEARLY") {
        return null;
    }

    const form: RecurrenceForm = { ...DEFAULT_RECURRENCE };
    form.frequency = freq === "YEARLY" ? "yearly" : "monthly";

    if (fields["BYMONTH"]) {
        const m = parseInt(fields["BYMONTH"], 10);
        if (!Number.isNaN(m)) form.month = m;
    }

    if (fields["BYDAY"]) {
        const match = fields["BYDAY"].match(/^(-?\d+)?([A-Z]{2})$/i);
        if (match) {
            form.dayMode = "weekday";
            form.position = match[1] ? parseInt(match[1], 10) : 1;
            form.weekday = match[2].toUpperCase();
        }
    } else if (fields["BYMONTHDAY"]) {
        const d = parseInt(fields["BYMONTHDAY"], 10);
        if (!Number.isNaN(d)) {
            form.dayMode = "dayOfMonth";
            form.monthDay = d;
        }
    }

    return form;
}
