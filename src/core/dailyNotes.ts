import moment from "moment";

/*
 * Where daily notes live and how a new one starts — worked out from the
 * vault itself, with nothing from Obsidian's runtime. Obsidian keeps the
 * daily-notes settings in `.obsidian/daily-notes.json`; any host that can
 * read that file can find, name and create daily notes the same way
 * Obsidian does (docs/format.md).
 */

export type DailySettings = {
    // Folder the notes are in, no trailing slash; "" for the vault root.
    folder: string;
    // Moment format of the note's name (may contain slashes for subfolders).
    format: string;
    // Path of the template note, without ".md"; "" for none.
    template: string;
};

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";
export const DAILY_SETTINGS_PATH = ".obsidian/daily-notes.json";

/** Settings from the JSON text of `.obsidian/daily-notes.json`. Missing or
 * unreadable text gives Obsidian's own defaults. */
export function parseDailySettings(json: string | null): DailySettings {
    let raw: Record<string, unknown> = {};
    try {
        raw = json ? JSON.parse(json) : {};
    } catch {
        // Fall through to the defaults.
    }
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
        folder: text(raw.folder).replace(/^\/+|\/+$/g, ""),
        format: text(raw.format) || DEFAULT_DAILY_FORMAT,
        template: text(raw.template).replace(/\.md$/, ""),
    };
}

const join = (folder: string, name: string) =>
    folder ? `${folder}/${name}` : name;

/** The path of the daily note for a date ("YYYY-MM-DD"). */
export function dailyPath(settings: DailySettings, date: string): string {
    return join(
        settings.folder,
        moment(date, "YYYY-MM-DD", true).format(settings.format) + ".md"
    );
}

/**
 * The date ("YYYY-MM-DD") a path is the daily note of, or null when it
 * isn't one: outside the folder, or its name isn't exactly a date in the
 * configured format (`template.md`, `routine.md`, a conflict copy).
 */
export function dateOfDailyPath(
    settings: DailySettings,
    path: string
): string | null {
    if (!path.endsWith(".md")) {
        return null;
    }
    const prefix = settings.folder ? settings.folder + "/" : "";
    if (!path.startsWith(prefix)) {
        return null;
    }
    const name = path.slice(prefix.length, -3);
    // A plain date format has no folders in it; a note deeper than the
    // format describes belongs to something else.
    if (name.split("/").length !== settings.format.split("/").length) {
        return null;
    }
    const m = moment(name, settings.format, true);
    return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

/**
 * What a new daily note starts as: the template's text with Obsidian's
 * template variables filled in — {{date}}, {{date:FORMAT}}, {{time}},
 * {{time:FORMAT}}, {{title}}. `now` is when it is being made; the date is
 * the day the note is for.
 */
export function newDailyContent(
    template: string,
    settings: DailySettings,
    date: string,
    now: Date = new Date()
): string {
    const day = moment(date, "YYYY-MM-DD", true);
    const title = day.format(settings.format).split("/").pop() ?? "";
    return template
        .replace(/{{\s*date\s*(?::\s*(.*?))?\s*}}/gi, (_m, format?: string) =>
            day.format(format || settings.format)
        )
        .replace(/{{\s*time\s*(?::\s*(.*?))?\s*}}/gi, (_m, format?: string) =>
            moment(now).format(format || "HH:mm")
        )
        .replace(/{{\s*title\s*}}/gi, title);
}
