import { App, MarkdownView, TFile, Vault, Workspace } from "obsidian";
import EventCache from "src/core/EventCache";

export const LINK_EVENT_FRONTMATTER_KEY = "fc-link-event";

/**
 * Find the note that declares itself linked to a calendar event via
 * `fc-link-event` frontmatter (a single title or a list of titles).
 * Only notes that opt in are ever matched — an event with no declaring
 * note resolves to null.
 */
export function resolveLinkedNote(app: App, eventTitle: string): TFile | null {
    const title = eventTitle.trim();
    if (!title) {
        return null;
    }
    for (const file of app.vault.getMarkdownFiles()) {
        const value =
            app.metadataCache.getFileCache(file)?.frontmatter?.[
                LINK_EVENT_FRONTMATTER_KEY
            ];
        if (!value) {
            continue;
        }
        const names = Array.isArray(value) ? value : [value];
        if (names.some((n) => String(n).trim() === title)) {
            return file;
        }
    }
    return null;
}

/**
 * Open a note in the most recent leaf, respecting pinned leaves.
 */
export async function openFileInLeaf(
    { workspace }: { workspace: Workspace },
    file: TFile
) {
    let leaf = workspace.getMostRecentLeaf();
    if (!leaf) {
        return;
    }
    if (leaf.getViewState().pinned) {
        leaf = workspace.getLeaf("tab");
    }
    await leaf.openFile(file);
}

/**
 * Open a file in the editor to a given event.
 * @param cache
 * @param param1 App
 * @param id event ID
 * @returns
 */
export async function openFileForEvent(
    cache: EventCache,
    { workspace, vault }: { workspace: Workspace; vault: Vault },
    id: string
) {
    const details = cache.getInfoForEditableEvent(id);
    if (!details) {
        throw new Error("Event does not have local representation.");
    }
    const {
        location: { path, lineNumber },
    } = details;
    let leaf = workspace.getMostRecentLeaf();
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
        return;
    }
    if (!leaf) {
        return;
    }
    if (leaf.getViewState().pinned) {
        leaf = workspace.getLeaf("tab");
    }
    await leaf.openFile(file);
    if (lineNumber && leaf.view instanceof MarkdownView) {
        leaf.view.editor.setCursor({ line: lineNumber, ch: 0 });
    }
}
