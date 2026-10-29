import { FuzzySuggestModal, Notice } from "obsidian";
import type FullCalendarPlugin from "../main";
import { trayCards } from "./tray";
import { linktextForEvent } from "../core/worklog";
import { termHandsFor } from "../core/termHands";

/*
 * Task picker: a fuzzy-searchable modal over the current term's hands and
 * the same cards the tray shows. Used when a session is created from the
 * calendar surface (click or drag-select on an empty range) rather than
 * from the tray itself.
 */

// `title` is what the work-log line gets: a task's wikilink, or a hand as
// the term table names it (see termHands.ts).
type PickableItem = { label: string; title: string };

class TrayTaskModal extends FuzzySuggestModal<PickableItem> {
    private items: PickableItem[];
    private resolve: (title: string | null) => void;
    private chosen = false;

    constructor(
        plugin: FullCalendarPlugin,
        items: PickableItem[],
        resolve: (title: string | null) => void
    ) {
        super(plugin.app);
        this.items = items;
        this.resolve = resolve;
        this.setPlaceholder("Log a session for…");
    }

    getItems(): PickableItem[] {
        return this.items;
    }

    getItemText(item: PickableItem): string {
        return item.label;
    }

    onChooseItem(item: PickableItem): void {
        this.chosen = true;
        this.resolve(item.title);
    }

    onClose(): void {
        super.onClose();
        // selectSuggestion closes the modal BEFORE onChooseItem runs, so
        // deciding "dismissed" synchronously here would always win the
        // promise race. Defer one tick: by then a choice has been recorded.
        window.setTimeout(() => {
            if (!this.chosen) {
                this.resolve(null);
            }
        }, 0);
    }
}

/**
 * Let the user pick one of the term's hands (for the term covering `date`,
 * YYYY-MM-DD) or this sprint's tasks. Resolves with the work-log title to
 * write, or null if the modal is dismissed without a choice.
 */
export async function pickTrayTask(
    plugin: FullCalendarPlugin,
    date: string
): Promise<string | null> {
    const hands: PickableItem[] = (
        await termHandsFor(plugin.app, plugin.settings.termFolder || "", date)
    ).map((hand) => ({ label: hand.name, title: hand.title }));
    const tasks: PickableItem[] = [];
    for (const card of trayCards(plugin)) {
        const linktext = linktextForEvent(plugin, card.id);
        if (linktext) {
            tasks.push({ label: card.event.title, title: `[[${linktext}]]` });
        }
    }
    const items = [...hands, ...tasks];
    if (items.length === 0) {
        new Notice("No term hands or sprint tasks to log a session for.");
        return null;
    }
    return new Promise((resolve) => {
        new TrayTaskModal(plugin, items, resolve).open();
    });
}
