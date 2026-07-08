import {
    getInlineAttributes,
    getInlineEventFromLine,
    getTodoRegionListItems,
} from "./DailyNoteCalendar";
import { CachedMetadata, ListItemCache } from "obsidian";

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
