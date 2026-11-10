import {
    allDailyFiles,
    createDaily,
    dailyFile,
    DailyIO,
    dateOfFile,
    ensureDaily,
    loadDailySettings,
} from "./dailyService";

// A vault as a map of path → text; just enough of the file operations.
function fakeVault(files: Record<string, string>): DailyIO & {
    files: Record<string, string>;
    folders: Set<string>;
} {
    const folders = new Set<string>(["j/daily"]);
    const asFile = (path: string) => (path in files ? ({ path } as any) : null);
    return {
        files,
        folders,
        readConfigFile: async (name) => files[`.obsidian/${name}`] ?? null,
        getFileByPath: asFile,
        getAbstractFileByPath: (path) =>
            asFile(path) ?? (folders.has(path) ? { path } : null),
        getMarkdownFiles: () =>
            Object.keys(files)
                .filter((p) => p.endsWith(".md"))
                .map((path) => ({ path } as any)),
        read: async (file) => files[file.path],
        create: async (path, contents) => {
            files[path] = contents;
            return { path } as any;
        },
        createFolder: async (path) => {
            folders.add(path);
        },
    };
}

const vault = () =>
    fakeVault({
        ".obsidian/daily-notes.json":
            '{"folder":"j/daily","template":"j/daily/template"}',
        "j/daily/template.md": "## TODO\n\n## Plan\n\n## Log\n",
        "j/daily/routine.md": "## 毎日\n",
        "j/daily/2026-11-09.md": "## TODO\n",
        "j/daily/2026-11-10.md": "## TODO\n",
        "notes/2026-11-10.md": "not a daily note",
    });

describe("daily notes, found through the vault's own settings", () => {
    it("knows which files are daily notes", async () => {
        const io = vault();
        await loadDailySettings(io);
        expect(dateOfFile({ path: "j/daily/2026-11-10.md" })).toBe(
            "2026-11-10"
        );
        expect(dateOfFile({ path: "notes/2026-11-10.md" })).toBeNull();
        expect(allDailyFiles(io).map((f) => f.path)).toEqual([
            "j/daily/2026-11-09.md",
            "j/daily/2026-11-10.md",
        ]);
        expect(dailyFile(io, "2026-11-10")?.path).toBe("j/daily/2026-11-10.md");
        expect(dailyFile(io, "2026-11-11")).toBeNull();
    });

    it("creates a missing day from the template, and only once", async () => {
        const io = vault();
        await loadDailySettings(io);
        const made = await ensureDaily(io, "2026-11-11");
        expect(made.path).toBe("j/daily/2026-11-11.md");
        expect(io.files["j/daily/2026-11-11.md"]).toBe(
            "## TODO\n\n## Plan\n\n## Log\n"
        );
        io.files["j/daily/2026-11-11.md"] = "edited";
        await createDaily(io, "2026-11-11");
        expect(io.files["j/daily/2026-11-11.md"]).toBe("edited");
    });

    it("makes the folder when it isn't there, and copes with no template", async () => {
        const io = fakeVault({
            ".obsidian/daily-notes.json": '{"folder":"new/place"}',
        });
        await loadDailySettings(io);
        await createDaily(io, "2026-11-11");
        expect(io.folders.has("new/place")).toBe(true);
        expect(io.files["new/place/2026-11-11.md"]).toBe("");
    });
});
