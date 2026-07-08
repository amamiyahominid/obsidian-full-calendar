import { appendTodosUnderHeading } from "./todoRollover";

describe("appendTodosUnderHeading", () => {
    const todos = ["- [ ] ギア洗濯", "- [ ] 事務作業"];

    it("appends at the end of the heading's section, before the next heading", () => {
        const page = [
            "## TODO",
            "",
            "- [ ] 既存",
            "",
            "---",
            "",
            "## Memo",
        ].join("\n");
        const lines = appendTodosUnderHeading(page, "TODO", todos).split("\n");
        expect(lines[2]).toBe("- [ ] 既存");
        expect(lines[3]).toBe("- [ ] ギア洗濯");
        expect(lines[4]).toBe("- [ ] 事務作業");
        expect(lines).toContain("## Memo");
    });

    it("keeps trailing blank spacing below the inserted lines", () => {
        const page = ["## TODO", "", "- [ ] 既存", "", "---"].join("\n");
        const lines = appendTodosUnderHeading(page, "TODO", todos).split("\n");
        expect(lines[4]).toBe("- [ ] 事務作業");
        expect(lines[5]).toBe("");
        expect(lines[6]).toBe("---");
    });

    it("creates the section when the heading is missing", () => {
        const page = ["- some prose", ""].join("\n");
        const lines = appendTodosUnderHeading(page, "TODO", todos).split("\n");
        const idx = lines.indexOf("## TODO");
        expect(idx).toBeGreaterThan(0);
        expect(lines[idx + 2]).toBe("- [ ] ギア洗濯");
    });

    it("inserts at the very top for headingless (top-region) calendars", () => {
        const page = ["- [ ] 既存", "", "---", "memo"].join("\n");
        const lines = appendTodosUnderHeading(page, "", todos).split("\n");
        expect(lines[0]).toBe("- [ ] ギア洗濯");
        expect(lines[2]).toBe("- [ ] 既存");
    });
});
