import {
    appendMemoLine,
    memoBody,
    memoForDisplay,
    memoLines,
    replaceMemoBody,
} from "./memo";

jest.mock("obsidian", () => ({ TFile: class {} }), { virtual: true });
jest.mock("obsidian-daily-notes-interface", () => ({}));

const NOTE = [
    "## TODO",
    "",
    "- [ ] a",
    "",
    "---",
    "",
    "## Memo",
    "",
    "- ",
    "",
    "---",
    "",
    "## Log",
    "",
    "- x [startTime:: 09:00]  [endTime:: 10:00]",
].join("\n");

describe("memo", () => {
    it("fills the template's empty bullet first", () => {
        const page = appendMemoLine(NOTE, "first");
        expect(memoLines(page)).toEqual(["first"]);
        expect(page.split("\n").length).toBe(NOTE.split("\n").length);
    });

    it("appends after the last memo, before the break", () => {
        const page = appendMemoLine(appendMemoLine(NOTE, "first"), "second");
        expect(memoLines(page)).toEqual(["first", "second"]);
        const lines = page.split("\n");
        expect(lines[lines.indexOf("- second") + 1]).toBe("");
        expect(lines[lines.indexOf("- second") + 2]).toBe("---");
        expect(page).toContain("- x [startTime:: 09:00]");
    });

    it("does not read other sections as memos", () => {
        expect(memoLines(NOTE)).toEqual([]);
    });

    it("writes into an empty section", () => {
        const page = appendMemoLine("## Memo\n\n## Log\n", "m");
        expect(page).toBe("## Memo\n\n- m\n\n## Log\n");
    });

    it("adds the heading when the note has none", () => {
        const page = appendMemoLine("## TODO\n\n- [ ] a\n", "m");
        expect(page).toBe("## TODO\n\n- [ ] a\n\n## Memo\n\n- m\n");
        expect(memoLines(page)).toEqual(["m"]);
    });

    it("reads the template's bare bullet as an empty memo", () => {
        expect(memoBody(NOTE)).toBe("");
    });

    it("returns the section as written, nesting included", () => {
        const body = "- a\n    - b [[c]]\n- d";
        const page = replaceMemoBody(NOTE, body);
        expect(memoBody(page)).toBe(body);
    });

    it("replaces only the memo section", () => {
        const page = replaceMemoBody(NOTE, "- a\n    - b\n");
        const lines = page.split("\n");
        expect(lines.slice(0, 7)).toEqual(NOTE.split("\n").slice(0, 7));
        expect(lines.slice(7, 12)).toEqual(["", "- a", "    - b", "", "---"]);
        expect(page).toContain("- x [startTime:: 09:00]");
        expect(replaceMemoBody(page, memoBody(page))).toBe(page);
    });

    it("finds the heading under either spelling", () => {
        const page = "## メモ\n\n- a\n";
        expect(memoBody(page)).toBe("- a");
        expect(memoLines(appendMemoLine(page, "b"))).toEqual(["a", "b"]);
    });

    it("keeps a flush-left line after a list out of the list when drawn", () => {
        expect(memoForDisplay("#！\n- テスト\n#？\n- あ")).toBe(
            "#！\n- テスト\n\n#？\n- あ"
        );
    });

    it("leaves nesting, spaced text and code fences alone when drawn", () => {
        const body = "- a\n    - b\n    more\n\nnote\n```\n- x\ny\n```";
        expect(memoForDisplay(body)).toBe(body);
    });
});
