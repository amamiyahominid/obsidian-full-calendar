import { modifyFrontmatterString } from "../calendars/FullNoteCalendar";
import type { OFCEvent } from "../types";

/*
 * A task's name is written twice: in the note's file name
 * ("2026-11-10 Fix the thing.md") and in its `title`. Renaming the note in
 * the file explorer changes only the first, and every surface that shows
 * the task by its title — today's list, the week, the board — would go on
 * showing the old name. This keeps the second in step with the first.
 */

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}\s+/;

/** "dir/2026-11-10 Fix it.md" → "Fix it". */
export function titleFromPath(path: string): string {
    const base = (path.split("/").pop() ?? "").replace(/\.md$/, "");
    return base.replace(DATE_PREFIX, "");
}

/** The `title` a note's frontmatter holds, or null when it has none. */
export function frontmatterTitle(page: string): string | null {
    const fm = page.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    const line = fm?.[1].match(/^title:[ \t]*(.*)$/m);
    if (!line) {
        return null;
    }
    return line[1].trim().replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The note's text after a rename from `oldPath` to `newPath`, with `title`
 * following the file name — but only when the title was the old file name's
 * to begin with. A title someone chose to differ from the file name is
 * theirs and is left alone. Returns the page unchanged when there is
 * nothing to do.
 */
export function retitleAfterRename(
    page: string,
    oldPath: string,
    newPath: string
): string {
    const oldTitle = titleFromPath(oldPath);
    const newTitle = titleFromPath(newPath);
    if (!newTitle || newTitle === oldTitle) {
        return page;
    }
    if (frontmatterTitle(page) !== oldTitle) {
        return page;
    }
    return modifyFrontmatterString(page, {
        title: newTitle,
    } as Partial<OFCEvent>);
}
