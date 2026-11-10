import type { TFile } from "obsidian";
import { isSetAside } from "../calendars/NoteKindCalendar";

/** The file operations this needs; ObsidianInterface satisfies it. */
export type HandIO = {
    getMarkdownFiles(): TFile[];
    getMetadata(file: TFile): { frontmatter?: Record<string, any> } | null;
};

export type Hand = {
    // Shown in the picker.
    name: string;
    // Written as the work-log line's title.
    title: string;
};

/**
 * The hands: every note whose frontmatter says `kind: hand`, wherever it
 * sits, except archived and template ones (docs/format.md). By name.
 */
export function handNotes(io: HandIO): Hand[] {
    return io
        .getMarkdownFiles()
        .filter(
            (f) =>
                !isSetAside(f.path) &&
                io.getMetadata(f)?.frontmatter?.kind === "hand"
        )
        .map((f) => f.basename)
        .sort((a, b) => a.localeCompare(b, "ja"))
        .map((name) => ({ name, title: `[[${name}]]` }));
}
