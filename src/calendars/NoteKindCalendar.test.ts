import { TFile } from "obsidian";
import { ObsidianInterface } from "../ObsidianAdapter";
import { MockApp, MockAppBuilder } from "../../test_helpers/AppBuilder";
import { FileBuilder } from "../../test_helpers/FileBuilder";
import NoteKindCalendar, { isSetAside, linkTarget } from "./NoteKindCalendar";
import { parseEvent } from "../types/schema";

const makeApp = (app: MockApp): ObsidianInterface => ({
    getAbstractFileByPath: (path) => app.vault.getAbstractFileByPath(path),
    getFileByPath(path: string): TFile | null {
        const f = app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? f : null;
    },
    getMarkdownFiles: () => app.vault.getMarkdownFiles(),
    createFolder: jest.fn(),
    readConfigFile: jest.fn(),
    getMetadata: (file) => app.metadataCache.getFileCache(file),
    waitForMetadata: (file) =>
        Promise.resolve(app.metadataCache.getFileCache(file)!),
    read: (file) => app.vault.read(file),
    create: jest.fn(),
    rewrite: jest.fn(),
    rename: jest.fn(),
    delete: jest.fn(),
    process: jest.fn(),
});

const task = (project: string, extra: Record<string, unknown> = {}) =>
    new FileBuilder().frontmatter({
        kind: "task",
        status: "Backlog",
        date: "2026-11-10",
        project: `[[${project}]]`,
        ...extra,
    });

// Tasks sit in all sorts of places on purpose: where a note is must not
// decide what it is.
const vault = () =>
    makeApp(
        MockAppBuilder.make()
            .folder(
                new MockAppBuilder("projects")
                    .folder(
                        new MockAppBuilder("01_alpha")
                            .file(
                                "Alpha.md",
                                new FileBuilder().frontmatter({
                                    kind: "project",
                                })
                            )
                            .folder(
                                new MockAppBuilder("tasks")
                                    .file("a1.md", task("Alpha"))
                                    .file("b-stray.md", task("Beta"))
                            )
                    )
                    .folder(
                        new MockAppBuilder("99_archive").file(
                            "old.md",
                            task("Alpha")
                        )
                    )
                    .folder(
                        new MockAppBuilder("template").file(
                            "t.md",
                            task("Alpha")
                        )
                    )
            )
            .folder(
                new MockAppBuilder("elsewhere")
                    .file("a2.md", task("Alpha|the alpha one"))
                    .file("template.md", task("Alpha"))
                    .file(
                        "plain.md",
                        new FileBuilder().frontmatter({ status: "Backlog" })
                    )
                    .file(
                        "q.md",
                        new FileBuilder().frontmatter({
                            kind: "issue",
                            status: "Backlog",
                        })
                    )
            )
            .done()
    );

const alpha = { name: "Alpha", path: "projects/01_alpha/Alpha.md" };
const beta = { name: "Beta", path: "projects/02_beta/Beta.md" };

describe("notes found by kind and project", () => {
    it("reads link targets however they are written", () => {
        expect(linkTarget("[[Alpha]]")).toBe("Alpha");
        expect(linkTarget("[[Alpha|a]]")).toBe("Alpha");
        expect(linkTarget("[[dir/Alpha#h]]")).toBe("Alpha");
        expect(linkTarget(["[[Alpha]]", "[[Beta]]"])).toBe("Alpha");
        expect(linkTarget("Alpha")).toBe("Alpha");
        expect(linkTarget(undefined)).toBeNull();
    });

    it("sets archived and template notes aside", () => {
        expect(isSetAside("p/99_archive/x.md")).toBe(true);
        expect(isSetAside("p/archive/x.md")).toBe(true);
        expect(isSetAside("p/template/x.md")).toBe(true);
        expect(isSetAside("p/template.md")).toBe(true);
        expect(isSetAside("p/archived-ideas/x.md")).toBe(false);
        expect(isSetAside("p/tasks/x.md")).toBe(false);
    });

    it("gathers a project's tasks from anywhere in the vault", async () => {
        const cal = new NoteKindCalendar(vault(), "#000", "task", alpha);
        const paths = (await cal.getEvents()).map(([, loc]) => loc.file.path);
        expect(paths.sort()).toEqual([
            "elsewhere/a2.md",
            "projects/01_alpha/tasks/a1.md",
        ]);
    });

    it("goes by the link, not the folder a task sits in", async () => {
        const cal = new NoteKindCalendar(vault(), "#000", "task", beta);
        const paths = (await cal.getEvents()).map(([, loc]) => loc.file.path);
        expect(paths).toEqual(["projects/01_alpha/tasks/b-stray.md"]);
    });

    it("gathers issues by kind alone", async () => {
        const cal = new NoteKindCalendar(vault(), "#000", "issue");
        const paths = (await cal.getEvents()).map(([, loc]) => loc.file.path);
        expect(paths).toEqual(["elsewhere/q.md"]);
        expect(cal.id).toBe("local::kind/issue");
    });

    it("names itself after its project", () => {
        const cal = new NoteKindCalendar(vault(), "#000", "task", alpha);
        expect(cal.id).toBe("local::project/Alpha");
        expect(cal.name).toBe("Alpha");
        expect(cal.directory).toBe("projects/01_alpha/tasks");
    });

    it("creates a task beside its project, linked to it", async () => {
        const app = vault();
        const cal = new NoteKindCalendar(app, "#000", "task", alpha);
        (app.create as jest.Mock).mockReturnValue({ path: "x" });
        await cal.createEvent(
            parseEvent({ title: "New", date: "2026-11-11", allDay: true })
        );
        const [path, content] = (app.create as jest.Mock).mock.calls[0];
        expect(path).toBe("projects/01_alpha/tasks/2026-11-11 New.md");
        expect(content).toContain("kind: task");
        expect(content).toContain('project: "[[Alpha]]"');
        expect(content).toContain("status: Backlog");
    });
});
