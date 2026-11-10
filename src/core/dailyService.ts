import type { TFile } from "obsidian";
import { DateTime } from "luxon";
import {
    dailyPath,
    DailySettings,
    dateOfDailyPath,
    newDailyContent,
    parseDailySettings,
} from "./dailyNotes";

/*
 * Daily notes for the rest of the code: which note is which day's, today's
 * note, all of them, and making a new one — through the narrow set of file
 * operations any host can provide, and the vault's own daily-notes settings
 * (core/dailyNotes). Nothing here asks Obsidian's daily-notes plugin.
 */

/** The file operations this needs; ObsidianInterface satisfies it. */
export type DailyIO = {
    readConfigFile(name: string): Promise<string | null>;
    getFileByPath(path: string): TFile | null;
    getAbstractFileByPath(path: string): unknown;
    getMarkdownFiles(): TFile[];
    read(file: TFile): Promise<string>;
    create(path: string, contents: string): Promise<TFile>;
    createFolder(path: string): Promise<void>;
};

// Read once at start-up (and again on demand); the answers below are then
// synchronous, which most callers need.
let settings: DailySettings = parseDailySettings(null);
let loaded = false;

export async function loadDailySettings(io: DailyIO): Promise<DailySettings> {
    settings = parseDailySettings(await io.readConfigFile("daily-notes.json"));
    loaded = true;
    return settings;
}

export const getDailySettings = (): DailySettings => settings;
export const dailySettingsLoaded = (): boolean => loaded;

/** For tests: set the settings directly. */
export function setDailySettings(next: DailySettings): void {
    settings = next;
    loaded = true;
}

export const todayISO = (): string => DateTime.now().toISODate();

/** The day ("YYYY-MM-DD") a file is the daily note of, or null. */
export function dateOfFile(file: { path: string }): string | null {
    return dateOfDailyPath(settings, file.path);
}

/** The daily note for a date, if it exists. */
export function dailyFile(io: DailyIO, date: string): TFile | null {
    return io.getFileByPath(dailyPath(settings, date));
}

/** Every daily note in the vault. */
export function allDailyFiles(io: DailyIO): TFile[] {
    return io.getMarkdownFiles().filter((f) => dateOfFile(f) !== null);
}

/** Create the daily note for a date from the configured template. */
export async function createDaily(io: DailyIO, date: string): Promise<TFile> {
    const path = dailyPath(settings, date);
    const existing = io.getFileByPath(path);
    if (existing) {
        return existing;
    }
    let template = "";
    if (settings.template) {
        const file = io.getFileByPath(`${settings.template}.md`);
        if (file) {
            template = await io.read(file);
        }
    }
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder && !io.getAbstractFileByPath(folder)) {
        await io.createFolder(folder);
    }
    return io.create(path, newDailyContent(template, settings, date));
}

/** The daily note for a date, created if it isn't there yet. */
export async function ensureDaily(io: DailyIO, date: string): Promise<TFile> {
    return dailyFile(io, date) ?? (await createDaily(io, date));
}
