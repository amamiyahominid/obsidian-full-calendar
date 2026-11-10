import {
    blockIdFromEventId,
    blockIdOf,
    findHeading,
    findLineByBlockId,
    lineEventId,
    listLinesInTopRegion,
    listLinesUnderHeading,
    newBlockId,
    sectionUnder,
    stripBlockId,
} from "./dailyText";
import {
    addToHeading,
    getInlineEventFromLine,
} from "../calendars/DailyNoteCalendar";
import { OFCEvent } from "../types";

const NOTE = [
    "---",
    "x: 1",
    "---",
    "## TODO",
    "",
    "- [ ] [[task]] ^aaa111",
    "- [x] plain",
    "",
    "---",
    "",
    "## Memo",
    "",
    "- note",
    "```",
    "## Log",
    "- not a line",
    "```",
    "",
    "## Log",
    "",
    "- [[task]] [startTime:: 09:00]  [endTime:: 10:00] ^bbb222",
    "-  [[task]] [startTime:: 10:00]",
    "### Sub",
    "- under sub",
    "## After",
    "- elsewhere",
].join("\n");
const lines = NOTE.split("\n");

describe("daily note structure from text", () => {
    it("finds a heading outside frontmatter and code fences", () => {
        expect(findHeading(lines, "Log")).toEqual({ line: 18, level: 2 });
        expect(findHeading(lines, "Nope")).toBeUndefined();
    });

    it("ends a section at the next heading of the same or higher level", () => {
        expect(sectionUnder(lines, "Log")).toEqual({ start: 19, end: 24 });
        expect(sectionUnder(lines, "After")).toEqual({ start: 25, end: 26 });
    });

    it("lists the list items under a heading, sub-headings included", () => {
        expect(listLinesUnderHeading(lines, "Log")).toEqual([20, 21, 23]);
        expect(listLinesUnderHeading(lines, "TODO")).toEqual([5, 6]);
        expect(listLinesUnderHeading(lines, "Memo")).toEqual([12]);
    });

    it("reads the top region up to the first heading or rule", () => {
        const top = ["- [ ] a", "- [ ] b", "", "---", "- c", "## H"];
        expect(listLinesInTopRegion(top)).toEqual([0, 1]);
        expect(listLinesInTopRegion(lines)).toEqual([]);
    });
});

describe("block ids", () => {
    it("reads and strips the id a line ends with", () => {
        expect(blockIdOf(lines[20])).toBe("bbb222");
        expect(blockIdOf(lines[21])).toBeNull();
        expect(stripBlockId(lines[5])).toBe("- [ ] [[task]]");
        // A caret inside the text is not an id.
        expect(blockIdOf("- 2^10 is 1024")).toBeNull();
    });

    it("finds a line by id wherever it moved", () => {
        expect(findLineByBlockId(lines, "bbb222")).toBe(20);
        expect(findLineByBlockId(["", ...lines], "bbb222")).toBe(21);
        expect(findLineByBlockId(lines, "zzz999")).toBe(-1);
    });

    it("makes ids that the note doesn't have yet", () => {
        const id = newBlockId(lines);
        expect(id).toMatch(/^[a-z0-9]{6}$/);
        expect(findLineByBlockId(lines, id)).toBe(-1);
    });

    it("pairs a block id with its note's date for the event id", () => {
        expect(lineEventId("2026-11-10", "bbb222")).toBe("2026-11-10^bbb222");
        expect(blockIdFromEventId("2026-11-10^bbb222")).toBe("bbb222");
        expect(blockIdFromEventId("17")).toBeNull();
        expect(blockIdFromEventId(undefined)).toBeNull();
    });
});

describe("lines with ids, read and written", () => {
    const globals = { date: "2026-11-10", type: "single" } as const;

    it("reads the id off the line and keeps it out of the title", () => {
        const event = getInlineEventFromLine(lines[20], globals);
        expect(event).toMatchObject({
            id: "2026-11-10^bbb222",
            title: "[[task]]",
            startTime: "09:00",
            endTime: "10:00",
        });
        const todo = getInlineEventFromLine(lines[5], globals, {
            implicitTodo: true,
        });
        expect(todo).toMatchObject({
            id: "2026-11-10^aaa111",
            title: "[[task]]",
            completed: false,
        });
    });

    it("leaves a line without an id without one", () => {
        expect(getInlineEventFromLine(lines[21], globals)?.id).toBeUndefined();
    });

    it("writes the id last, after the inline fields", () => {
        const event = getInlineEventFromLine(lines[20], globals) as OFCEvent;
        const { page, lineNumber } = addToHeading("## Log\n", {
            heading: { position: { start: { line: 0 } }, level: 2 },
            item: event,
            headingText: "Log",
        });
        const written = page.split("\n")[lineNumber];
        expect(written).toMatch(/\[endTime:: 10:00\] \^bbb222$/);
        expect(written).not.toContain("[id::");
        // And it reads back as the same event.
        expect(getInlineEventFromLine(written, globals)).toEqual(event);
    });
});
