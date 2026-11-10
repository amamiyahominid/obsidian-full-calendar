import { Notice, TFile } from "obsidian";
import { DateTime } from "luxon";
import type FullCalendarPlugin from "../main";
import {
    createDaily,
    dailyFile,
    dateOfFile,
    getDailySettings,
    todayISO,
} from "../core/dailyService";
import { confirmPlan, fillPlan, routineFor } from "../core/plan";

/*
 * Plan, from the host's side: finding the daily note and the routine note,
 * and writing what core/plan works out.
 */

// The routine lives beside the daily notes, under this name.
const ROUTINE_NOTE = "routine";

const dateOf = (file: TFile): string | null => dateOfFile(file);

function routineFile(plugin: FullCalendarPlugin): TFile | null {
    const folder = getDailySettings().folder;
    const path = `${folder ? folder + "/" : ""}${ROUTINE_NOTE}.md`;
    const file = plugin.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
}

/**
 * Fill a daily note's empty Plan from the routine for its weekday. Does
 * nothing when the note has a plan already, has no Plan heading, or there
 * is no routine note. Returns how many blocks were written.
 */
export async function fillPlanFor(
    plugin: FullCalendarPlugin,
    file: TFile
): Promise<number> {
    const date = dateOf(file);
    const routine = routineFile(plugin);
    if (!date || !routine) {
        return 0;
    }
    const blocks = routineFor(
        await plugin.app.vault.cachedRead(routine),
        // Luxon: Monday = 1 … Sunday = 7; the routine counts Sunday as 0.
        DateTime.fromISO(date).weekday % 7
    );
    const page = await plugin.app.vault.read(file);
    const next = fillPlan(page, blocks);
    if (next === page) {
        return 0;
    }
    await plugin.app.vault.modify(file, next);
    return blocks.length;
}

/** The daily note a command should act on: the open one if a daily note is
 * open, otherwise today's. */
export function targetDailyNote(plugin: FullCalendarPlugin): TFile | null {
    const active = plugin.app.workspace.getActiveFile();
    if (active && dateOf(active)) {
        return active;
    }
    return dailyFile(plugin.io, todayISO());
}

/**
 * Confirm the plan of a daily note into its log: for a past day every
 * block, for today the ones that have ended by now. A future day has
 * nothing to confirm.
 */
export async function confirmPlanFor(
    plugin: FullCalendarPlugin,
    file: TFile
): Promise<void> {
    const date = dateOf(file);
    if (!date) {
        return;
    }
    const now = DateTime.now();
    const today = now.toISODate();
    if (date > today) {
        new Notice("まだ先の日なので、確定する枠はありません。");
        return;
    }
    const page = await plugin.app.vault.read(file);
    const { page: next, moved } = confirmPlan(
        page,
        date < today ? null : now.toFormat("HH:mm")
    );
    if (moved === 0) {
        new Notice("Log に写す枠はありません。");
        return;
    }
    await plugin.app.vault.modify(file, next);
    new Notice(`${date}：Plan の枠を ${moved} 本、Log に写しました。`);
}

/**
 * Make sure today has a daily note, creating it from the daily-notes
 * template when it doesn't. The note is not opened. Its Plan is then filled
 * by the same "a daily note was created" path as any other new note.
 * Returns true when a note was created.
 */
export async function ensureTodayNote(
    plugin: FullCalendarPlugin
): Promise<boolean> {
    const today = todayISO();
    if (dailyFile(plugin.io, today)) {
        return false;
    }
    try {
        await createDaily(plugin.io, today);
        return true;
    } catch (e) {
        console.error("Full Calendar: could not create today's note.", e);
        return false;
    }
}

export { dateOf as dailyDateOf };
