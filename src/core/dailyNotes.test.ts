import {
    dailyPath,
    dateOfDailyPath,
    newDailyContent,
    parseDailySettings,
} from "./dailyNotes";

const settings = parseDailySettings(
    '{ "folder": "20_journal/daily", "template": "20_journal/daily/template" }'
);

describe("daily note settings", () => {
    it("reads Obsidian's file, with its defaults for what's missing", () => {
        expect(settings).toEqual({
            folder: "20_journal/daily",
            format: "YYYY-MM-DD",
            template: "20_journal/daily/template",
        });
        expect(parseDailySettings(null)).toEqual({
            folder: "",
            format: "YYYY-MM-DD",
            template: "",
        });
        expect(parseDailySettings("not json").format).toBe("YYYY-MM-DD");
        expect(parseDailySettings('{"folder":"/a/b/"}').folder).toBe("a/b");
    });
});

describe("daily note paths", () => {
    it("names the note for a date", () => {
        expect(dailyPath(settings, "2026-11-10")).toBe(
            "20_journal/daily/2026-11-10.md"
        );
        expect(dailyPath(parseDailySettings(null), "2026-11-10")).toBe(
            "2026-11-10.md"
        );
    });

    it("reads the date back off a path", () => {
        expect(
            dateOfDailyPath(settings, "20_journal/daily/2026-11-10.md")
        ).toBe("2026-11-10");
    });

    it("says no to everything that isn't a daily note", () => {
        for (const path of [
            "20_journal/daily/template.md",
            "20_journal/daily/routine.md",
            "20_journal/daily/2026-11-10 2.md",
            "20_journal/daily/2026-13-40.md",
            "20_journal/daily/sub/2026-11-10.md",
            "20_journal/weekly/2026-11-10.md",
            "20_journal/daily/2026-11-10.canvas",
        ]) {
            expect(dateOfDailyPath(settings, path)).toBeNull();
        }
    });

    it("follows a format with folders in it", () => {
        const nested = parseDailySettings(
            '{"folder":"j","format":"YYYY/MM/YYYY-MM-DD"}'
        );
        expect(dailyPath(nested, "2026-11-10")).toBe("j/2026/11/2026-11-10.md");
        expect(dateOfDailyPath(nested, "j/2026/11/2026-11-10.md")).toBe(
            "2026-11-10"
        );
        expect(dateOfDailyPath(nested, "j/2026-11-10.md")).toBeNull();
    });
});

describe("a new daily note", () => {
    it("fills in Obsidian's template variables", () => {
        const now = new Date(2026, 10, 9, 23, 5);
        expect(
            newDailyContent(
                "# {{title}}\n{{date}} {{date:M/D}} {{time}} {{time:HH}}\n## TODO\n",
                settings,
                "2026-11-10",
                now
            )
        ).toBe("# 2026-11-10\n2026-11-10 11/10 23:05 23\n## TODO\n");
    });

    it("leaves a template without variables as it is", () => {
        const t = "## TODO\n\n- [ ] \n\n---\n\n## Plan\n";
        expect(newDailyContent(t, settings, "2026-11-10")).toBe(t);
    });
});
