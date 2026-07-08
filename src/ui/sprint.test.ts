import { DateTime } from "luxon";
import {
    formatHours,
    isWeekString,
    sprintBucket,
    totalScheduledMinutes,
    weekOf,
    weekStartDate,
} from "./sprint";

describe("weekOf", () => {
    const midYear = DateTime.fromISO("2026-07-04T12:00:00");

    it("formats the current ISO week", () => {
        expect(weekOf(0, midYear)).toBe("2026-W27");
    });

    it("advances by whole weeks", () => {
        expect(weekOf(1, midYear)).toBe("2026-W28");
        expect(weekOf(3, midYear)).toBe("2026-W30");
    });

    it("crosses year boundaries via ISO week-years", () => {
        const lateDecember = DateTime.fromISO("2026-12-30T12:00:00");
        // 2026-12-30 falls in ISO week 2026-W53; the next week is 2027-W01.
        expect(weekOf(0, lateDecember)).toBe("2026-W53");
        expect(weekOf(1, lateDecember)).toBe("2027-W01");
    });

    it("uses the ISO week-year for early January", () => {
        // 2027-01-01 belongs to ISO week 2026-W53.
        const newYear = DateTime.fromISO("2027-01-01T12:00:00");
        expect(weekOf(0, newYear)).toBe("2026-W53");
    });
});

describe("sprintBucket", () => {
    const current = "2026-W27";

    it("puts unassigned cards in the backlog column", () => {
        expect(sprintBucket(undefined, false, current)).toBe("none");
        expect(sprintBucket(null, false, current)).toBe("none");
        expect(sprintBucket("", false, current)).toBe("none");
    });

    it("collects unfinished past weeks into carryover", () => {
        expect(sprintBucket("2026-W26", false, current)).toBe("carryover");
        expect(sprintBucket("2025-W53", false, current)).toBe("carryover");
    });

    it("hides finished past weeks", () => {
        expect(sprintBucket("2026-W26", true, current)).toBeNull();
    });

    it("keeps current and future weeks as their own bucket", () => {
        expect(sprintBucket("2026-W27", false, current)).toBe("2026-W27");
        expect(sprintBucket("2026-W30", true, current)).toBe("2026-W30");
        expect(sprintBucket("2027-W01", false, current)).toBe("2027-W01");
    });

    it("surfaces malformed values instead of hiding them", () => {
        expect(sprintBucket("Invalid date-WInvalid date", false, current)).toBe(
            "Invalid date-WInvalid date"
        );
        expect(sprintBucket("Invalid date-WInvalid date", true, current)).toBe(
            "Invalid date-WInvalid date"
        );
    });
});

describe("isWeekString", () => {
    it("accepts zero-padded ISO weeks", () => {
        expect(isWeekString("2026-W08")).toBe(true);
        expect(isWeekString("2026-W27")).toBe(true);
    });

    it("rejects other shapes", () => {
        expect(isWeekString("2026-W8")).toBe(false);
        expect(isWeekString("W27")).toBe(false);
        expect(isWeekString("Invalid date-WInvalid date")).toBe(false);
    });
});

describe("weekStartDate", () => {
    it("returns the Monday of an ISO week", () => {
        expect(weekStartDate("2026-W27")).toBe("2026-06-29");
        expect(weekStartDate("2026-W28")).toBe("2026-07-06");
    });

    it("handles week 1 of a year starting mid-week", () => {
        // ISO 2027-W01 starts on Monday 2027-01-04.
        expect(weekStartDate("2027-W01")).toBe("2027-01-04");
    });

    it("returns null for malformed weeks", () => {
        expect(weekStartDate("Invalid date-WInvalid date")).toBeNull();
        expect(weekStartDate("")).toBeNull();
    });
});

describe("totalScheduledMinutes", () => {
    it("sums 24-hour ranges", () => {
        expect(
            totalScheduledMinutes([
                { startTime: "09:00", endTime: "10:30" },
                { startTime: "13:00", endTime: "14:00" },
            ])
        ).toBe(150);
    });

    it("parses 12-hour times", () => {
        expect(
            totalScheduledMinutes([
                { startTime: "9:00 AM", endTime: "1:00 PM" },
            ])
        ).toBe(240);
    });

    it("skips open-ended, inverted, and unparseable entries", () => {
        expect(
            totalScheduledMinutes([
                { startTime: "09:00", endTime: null },
                { startTime: "10:00", endTime: "09:00" },
                { startTime: "banana", endTime: "10:00" },
                {},
            ])
        ).toBe(0);
    });
});

describe("formatHours", () => {
    it("renders minutes as decimal hours", () => {
        expect(formatHours(90)).toBe("1.5h");
        expect(formatHours(60)).toBe("1h");
        expect(formatHours(100)).toBe("1.7h");
    });
});
