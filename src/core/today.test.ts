import { nextRow, reorderLines, sessionOfRow, TodayRow } from "./today";
import { RunningSession } from "./worklog";

jest.mock("../calendars/DailyNoteCalendar", () => ({ default: class {} }));
jest.mock("../ui/tasks", () => ({ toggleTask: jest.fn() }));
jest.mock("obsidian", () => ({ Notice: class {} }), { virtual: true });

const row = (id: string, title: string, done = false): TodayRow => ({
    id,
    title,
    date: "2026-11-10",
    done,
    line: 0,
});
const running = (title: string): RunningSession =>
    ({
        id: "s",
        event: {
            type: "single",
            title,
            date: "2026-11-10",
            allDay: false,
            startTime: "10:00",
            endTime: null,
        },
    } as unknown as RunningSession);

const rows = [
    row("a", "[[2026-11-10 Fix it]]"),
    row("b", "[[趣味]]：地図の段を決める"),
    row("c", "食事のメニューを直す"),
    row("d", "済んだ用事", true),
];

describe("what comes next", () => {
    it("is the first line that isn't done", () => {
        expect(nextRow(rows, [])?.id).toBe("a");
        expect(nextRow([rows[3]], [])).toBeUndefined();
    });

    it("skips the line that is already running", () => {
        expect(nextRow(rows, [running("[[2026-11-10 Fix it]]")])?.id).toBe("b");
    });

    it("matches a task's session by its link, any other by its text", () => {
        expect(
            sessionOfRow(rows[0], [running("[[2026-11-10 Fix it]]")])
        ).toBeDefined();
        expect(
            sessionOfRow(rows[1], [running("[[趣味]]：地図の段を決める")])
        ).toBeDefined();
        // A different line that names the same hand is not this one.
        expect(
            sessionOfRow(rows[1], [running("[[趣味]]：別の用事")])
        ).toBeUndefined();
        expect(
            sessionOfRow(rows[2], [running("[[2026-11-10 Fix it]]")])
        ).toBeUndefined();
    });
});

describe("reordering lines", () => {
    const lines = [
        "## TODO",
        "",
        "- [ ] a",
        "- [ ] b",
        "- [ ] ",
        "- [ ] c",
        "",
    ];

    it("moves only the named lines, into the same slots", () => {
        // c, a, b — the placeholder at index 4 stays put.
        expect(reorderLines(lines, [5, 2, 3])).toEqual([
            "## TODO",
            "",
            "- [ ] c",
            "- [ ] a",
            "- [ ] ",
            "- [ ] b",
            "",
        ]);
    });

    it("changes nothing when the order is the same", () => {
        expect(reorderLines(lines, [2, 3, 5])).toEqual(lines);
    });
});
