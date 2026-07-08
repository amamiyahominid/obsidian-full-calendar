import {
    addToHeading,
    getInlineAttributes,
    getInlineEventFromLine,
    getTodoRegionListItems,
} from "./DailyNoteCalendar";
import { CachedMetadata, HeadingCache, ListItemCache } from "obsidian";
import { OFCEvent } from "../types";

it.each([
    ["one variable [hello:: world]", { hello: "world" }],
    ["[first:: a] message [second:: b]", { first: "a", second: "b" }],
    [
        "this is a long string with [some brackets] but no actual:: inline fields",
        {},
    ],
])("%p", (line: string, obj: any) => {
    expect(getInlineAttributes(line)).toEqual(obj);
});

describe("getInlineEventFromLine in TODO mode", () => {
    const globals = { date: "2026-07-08", type: "single" } as const;

    it("treats a bare unchecked checkbox line as an all-day task", () => {
        const event = getInlineEventFromLine("- [ ] 経費精算", globals, {
            implicitTodo: true,
        });
        expect(event).toEqual(
            expect.objectContaining({
                title: "経費精算",
                completed: false,
                allDay: true,
                date: "2026-07-08",
            })
        );
    });

    it("keeps the checked state of a bare checkbox line", () => {
        const event = getInlineEventFromLine(
            "- [x] コンディショナー",
            globals,
            {
                implicitTodo: true,
            }
        );
        expect(event).toBeTruthy();
        expect(event?.type === "single" && event.completed).toBeTruthy();
        expect(event?.allDay).toBe(true);
    });

    it("ignores checkbox lines with no text (they'd render blank)", () => {
        expect(
            getInlineEventFromLine("- [ ] ", globals, { implicitTodo: true })
        ).toBeNull();
    });

    it("ignores bullet lines without a checkbox", () => {
        expect(
            getInlineEventFromLine("- ただのメモ", globals, {
                implicitTodo: true,
            })
        ).toBeNull();
    });

    it("still ignores bare checkbox lines outside TODO mode", () => {
        expect(getInlineEventFromLine("- [ ] 経費精算", globals)).toBeNull();
    });

    it("still parses inline attributes on checkbox lines in TODO mode", () => {
        const event = getInlineEventFromLine(
            "- [ ] 打ち合わせ [startTime:: 10:00] [endTime:: 10:30]",
            globals,
            { implicitTodo: true }
        );
        expect(event).toEqual(
            expect.objectContaining({
                title: "打ち合わせ",
                allDay: false,
                startTime: "10:00",
                endTime: "10:30",
            })
        );
    });
});

describe("getTodoRegionListItems", () => {
    const item = (startOffset: number, endOffset: number): ListItemCache =>
        ({
            position: {
                start: { line: 0, col: 0, offset: startOffset },
                end: { line: 0, col: 0, offset: endOffset },
            },
        } as ListItemCache);

    it("returns items before the first thematic break", () => {
        const items = [item(0, 20), item(21, 40), item(60, 80)];
        const metadata = {
            listItems: items,
            sections: [
                {
                    type: "thematicBreak",
                    position: {
                        start: { line: 3, col: 0, offset: 45 },
                        end: { line: 3, col: 3, offset: 48 },
                    },
                },
            ],
        } as CachedMetadata;
        expect(getTodoRegionListItems(metadata)).toEqual([items[0], items[1]]);
    });

    it("returns items before the first heading", () => {
        const items = [item(0, 20), item(60, 80)];
        const metadata = {
            listItems: items,
            headings: [
                {
                    heading: "作業ログ",
                    level: 2,
                    position: {
                        start: { line: 3, col: 0, offset: 30 },
                        end: { line: 3, col: 7, offset: 37 },
                    },
                },
            ],
        } as CachedMetadata;
        expect(getTodoRegionListItems(metadata)).toEqual([items[0]]);
    });

    it("returns all items when there is no boundary", () => {
        const items = [item(0, 20), item(21, 40)];
        expect(
            getTodoRegionListItems({ listItems: items } as CachedMetadata)
        ).toEqual(items);
    });

    it("returns nothing for a file with no list items", () => {
        expect(getTodoRegionListItems({} as CachedMetadata)).toEqual([]);
    });
});

describe("addToHeading", () => {
    const session = {
        title: "[[APIリファクタ]]",
        type: "single",
        date: "2026-07-08",
        endDate: null,
        allDay: false,
        startTime: "14:00",
        endTime: "15:00",
    } as OFCEvent;

    const heading = (line: number): HeadingCache =>
        ({
            heading: "作業ログ",
            level: 2,
            position: {
                start: { line, col: 0, offset: 0 },
                end: { line, col: 7, offset: 7 },
            },
        } as HeadingCache);

    it("appends at the end of the heading's section, before the next heading", () => {
        const page = [
            "## 作業ログ",
            "- [[a]] [startTime:: 09:00]  [endTime:: 10:00]",
            "",
            "## メモ",
            "- foo",
        ].join("\n");
        const { page: result, lineNumber } = addToHeading(page, {
            heading: heading(0),
            item: session,
            headingText: "作業ログ",
        });
        const lines = result.split("\n");
        // A blank line is retrofitted between the heading and the entries.
        expect(lines[1]).toBe("");
        expect(lineNumber).toBe(3);
        expect(lines[3]).toContain("[[APIリファクタ]]");
        expect(lines[5]).toBe("## メモ");
    });

    it("appends at end of file, keeping a blank line under the section", () => {
        const page = ["## 作業ログ", "- first [startTime:: 09:00]"].join("\n");
        const { page: result, lineNumber } = addToHeading(page, {
            heading: heading(0),
            item: session,
            headingText: "作業ログ",
        });
        const lines = result.split("\n");
        expect(lines[1]).toBe("");
        expect(lineNumber).toBe(3);
        expect(lines[3]).toContain("[[APIリファクタ]]");
        expect(result.endsWith("\n\n")).toBe(true);
    });

    it("adds the first entry below a blank line after the heading", () => {
        const page = ["- memo", "", "## 作業ログ"].join("\n");
        const { page: result, lineNumber } = addToHeading(page, {
            heading: heading(2),
            item: session,
            headingText: "作業ログ",
        });
        const lines = result.split("\n");
        expect(lines[2]).toBe("## 作業ログ");
        expect(lines[3]).toBe("");
        expect(lineNumber).toBe(4);
        expect(lines[4]).toContain("[[APIリファクタ]]");
        expect(result.endsWith("\n\n")).toBe(true);
    });

    it("creates the heading at the end of the note when missing", () => {
        const page = ["- [ ] todo", "", "---", "", "- memo"].join("\n");
        const { page: result, lineNumber } = addToHeading(page, {
            heading: undefined,
            item: session,
            headingText: "作業ログ",
        });
        const lines = result.split("\n");
        // blank line above the heading, blank line under it, the entry,
        // then a visible blank line at the end
        expect(lines[lines.length - 6]).toBe("");
        expect(lines[lines.length - 5]).toBe("## 作業ログ");
        expect(lines[lines.length - 4]).toBe("");
        expect(lines[lines.length - 3]).toContain("[[APIリファクタ]]");
        expect(lineNumber).toBe(lines.length - 3);
        expect(result.endsWith("\n\n")).toBe(true);
    });
});
