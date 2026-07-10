import { FuzzySuggestModal, Notice } from "obsidian";
import type FullCalendarPlugin from "../main";
import { Card } from "./kanban";
import { trayCards } from "./tray";
import { linktextForEvent } from "../core/worklog";

/*
 * Task picker: a fuzzy-searchable modal over the same cards the tray shows.
 * Used when a session is created from the calendar surface (click or
 * drag-select on an empty range) rather than from the tray itself.
 */

type PickableCard = { card: Card; linktext: string };

class TrayTaskModal extends FuzzySuggestModal<PickableCard> {
    private items: PickableCard[];
    private resolve: (linktext: string | null) => void;
    private chosen = false;

    constructor(
        plugin: FullCalendarPlugin,
        items: PickableCard[],
        resolve: (linktext: string | null) => void
    ) {
        super(plugin.app);
        this.items = items;
        this.resolve = resolve;
        this.setPlaceholder("Log a session for…");
    }

    getItems(): PickableCard[] {
        return this.items;
    }

    getItemText(item: PickableCard): string {
        return item.card.event.title;
    }

    onChooseItem(item: PickableCard): void {
        this.chosen = true;
        this.resolve(item.linktext);
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
 * Let the user pick one of this sprint's tasks. Resolves with the task's
 * linktext, or null if the modal is dismissed without a choice.
 */
export function pickTrayTask(
    plugin: FullCalendarPlugin
): Promise<string | null> {
    const items = trayCards(plugin)
        .map((card) => ({
            card,
            linktext: linktextForEvent(plugin, card.id),
        }))
        .filter((item): item is PickableCard => !!item.linktext);
    if (items.length === 0) {
        new Notice("No tasks this sprint to log a session for.");
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        new TrayTaskModal(plugin, items, resolve).open();
    });
}
