import { buildRRule, parseRRule, RecurrenceForm } from "./recurrence";

describe("buildRRule", () => {
    it("monthly on a day of month", () => {
        expect(
            buildRRule({
                frequency: "monthly",
                dayMode: "dayOfMonth",
                monthDay: 15,
                position: 1,
                weekday: "SU",
                month: 1,
            })
        ).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
    });

    it("monthly on the nth weekday", () => {
        expect(
            buildRRule({
                frequency: "monthly",
                dayMode: "weekday",
                monthDay: 1,
                position: 2,
                weekday: "SU",
                month: 1,
            })
        ).toBe("FREQ=MONTHLY;BYDAY=2SU");
    });

    it("monthly on the last weekday", () => {
        expect(
            buildRRule({
                frequency: "monthly",
                dayMode: "weekday",
                monthDay: 1,
                position: -1,
                weekday: "FR",
                month: 1,
            })
        ).toBe("FREQ=MONTHLY;BYDAY=-1FR");
    });

    it("yearly on a date", () => {
        expect(
            buildRRule({
                frequency: "yearly",
                dayMode: "dayOfMonth",
                monthDay: 25,
                position: 1,
                weekday: "SU",
                month: 12,
            })
        ).toBe("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25");
    });

    it("yearly on the nth weekday", () => {
        expect(
            buildRRule({
                frequency: "yearly",
                dayMode: "weekday",
                monthDay: 1,
                position: 2,
                weekday: "SU",
                month: 3,
            })
        ).toBe("FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    });
});

describe("parseRRule", () => {
    const roundtrips: RecurrenceForm[] = [
        {
            frequency: "monthly",
            dayMode: "dayOfMonth",
            monthDay: 15,
            position: 1,
            weekday: "SU",
            month: 1,
        },
        {
            frequency: "monthly",
            dayMode: "weekday",
            monthDay: 1,
            position: -1,
            weekday: "FR",
            month: 1,
        },
        {
            frequency: "yearly",
            dayMode: "weekday",
            monthDay: 1,
            position: 2,
            weekday: "SU",
            month: 3,
        },
    ];

    it.each(roundtrips)("round-trips %o", (form) => {
        expect(parseRRule(buildRRule(form))).toEqual(form);
    });

    it("tolerates an RRULE: prefix", () => {
        expect(parseRRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=3")?.monthDay).toBe(3);
    });

    it("returns null for unsupported (weekly) frequencies", () => {
        expect(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE")).toBeNull();
    });
});
