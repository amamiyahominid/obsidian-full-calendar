import {
    frontmatterTitle,
    retitleAfterRename,
    titleFromPath,
} from "./titleSync";

jest.mock("obsidian", () => ({ TFile: class {}, TFolder: class {} }), {
    virtual: true,
});

const note = (title: string) =>
    `---\nkind: task\ntitle: ${title}\nstatus: Backlog\n---\nbody\n`;

describe("a task's title follows its file name", () => {
    it("reads the name out of a path, without the date", () => {
        expect(titleFromPath("p/tasks/2026-11-10 Fix it.md")).toBe("Fix it");
        expect(titleFromPath("p/tasks/Fix it.md")).toBe("Fix it");
    });

    it("reads the title a note holds", () => {
        expect(frontmatterTitle(note("Fix it"))).toBe("Fix it");
        expect(frontmatterTitle(note('"Fix: it"'))).toBe("Fix: it");
        expect(frontmatterTitle("no frontmatter")).toBeNull();
        expect(frontmatterTitle("---\nkind: task\n---\ntitle: x\n")).toBeNull();
    });

    it("updates the title when the note is renamed", () => {
        expect(
            retitleAfterRename(
                note("Fix it"),
                "p/tasks/2026-11-10 Fix it.md",
                "p/tasks/2026-11-10 Fix it properly.md"
            )
        ).toBe(note("Fix it properly"));
    });

    it("leaves a title that was never the file name's", () => {
        const page = note("A different title");
        expect(
            retitleAfterRename(
                page,
                "p/tasks/2026-11-10 Fix it.md",
                "p/tasks/2026-11-10 Fix it properly.md"
            )
        ).toBe(page);
    });

    it("does nothing for a move or a date change", () => {
        const page = note("Fix it");
        expect(
            retitleAfterRename(
                page,
                "a/tasks/2026-11-10 Fix it.md",
                "b/tasks/2026-11-12 Fix it.md"
            )
        ).toBe(page);
    });
});
