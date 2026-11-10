import { Notice, TFile, normalizePath } from "obsidian";
import type FullCalendarPlugin from "../main";

/*
 * Removing without a "sure?" (docs/ux.md §4): the thing goes at once, and
 * for a few seconds a notice offers to bring it back.
 */

const UNDO_MS = 7000;

/** A notice with one "元に戻す" button. */
export function noticeWithUndo(message: string, undo: () => Promise<void>) {
    const frag = document.createDocumentFragment();
    const wrap = frag.createDiv({ cls: "ofc-undo" });
    wrap.createSpan({ text: message });
    const btn = wrap.createEl("button", {
        cls: "ofc-undo-btn",
        text: "元に戻す",
    });
    const notice = new Notice(frag, UNDO_MS);
    btn.onclick = async (ev) => {
        ev.stopPropagation();
        notice.hide();
        try {
            await undo();
        } catch (e) {
            console.error(e);
            new Notice("元に戻せませんでした。");
        }
    };
}

/**
 * Put back what a delete took out of `path`: the whole note if it is gone,
 * otherwise the lines that went missing — at their old place when the file
 * hasn't been touched since, and without disturbing later edits when it has.
 */
export function restoredText(
    before: string,
    afterDelete: string,
    current: string
): string {
    if (current === afterDelete) {
        return before;
    }
    const was = before.split("\n");
    const left = afterDelete.split("\n");
    // The run of lines the delete removed: skip the common head and tail.
    let head = 0;
    while (
        head < was.length &&
        head < left.length &&
        was[head] === left[head]
    ) {
        head++;
    }
    let tail = 0;
    while (
        tail < was.length - head &&
        tail < left.length - head &&
        was[was.length - 1 - tail] === left[left.length - 1 - tail]
    ) {
        tail++;
    }
    const removed = was.slice(head, was.length - tail);
    const now = current.split("\n");
    const at = Math.min(head, now.length);
    return [...now.slice(0, at), ...removed, ...now.slice(at)].join("\n");
}

/**
 * Delete an event (a line of a daily note, or a whole task note) and offer
 * to undo it. `message` says what happened, e.g. "「…」を消しました。".
 */
export async function deleteWithUndo(
    plugin: FullCalendarPlugin,
    id: string,
    message: string
): Promise<void> {
    const path = plugin.cache.getInfoForEditableEvent(id).location.path;
    const file = plugin.app.vault.getAbstractFileByPath(path);
    const before =
        file instanceof TFile ? await plugin.app.vault.read(file) : null;
    await plugin.cache.deleteEvent(id);
    if (before === null) {
        return;
    }
    const left = plugin.app.vault.getAbstractFileByPath(path);
    const afterDelete =
        left instanceof TFile ? await plugin.app.vault.read(left) : null;
    noticeWithUndo(message, async () => {
        const now = plugin.app.vault.getAbstractFileByPath(path);
        if (!(now instanceof TFile)) {
            await plugin.app.vault.create(normalizePath(path), before);
            return;
        }
        if (afterDelete === null) {
            // The note was deleted and something else took its path since.
            throw new Error("path taken");
        }
        const current = await plugin.app.vault.read(now);
        await plugin.app.vault.modify(
            now,
            restoredText(before, afterDelete, current)
        );
    });
}
