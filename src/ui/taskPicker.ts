import { FuzzyMatch, FuzzySuggestModal, Notice } from "obsidian";
import type FullCalendarPlugin from "../main";
import { trayCards } from "./tray";
import { linktextForEvent } from "../core/worklog";
import { termBetsFor } from "../core/termBets";

/*
 * Task picker: a fuzzy-searchable modal over the current term's bets and
 * the same cards the tray shows. Used when a session is created from the
 * calendar surface (click or drag-select on an empty range) rather than
 * from the tray itself.
 */

// `title` is what the work-log line gets: a task's wikilink, or a bet as
// the term table names it (see termBets.ts). `group` indexes GROUPS.
type PickableItem = { label: string; title: string; group: number };

// Bets first, then tasks. Each group gets a heading above its first row.
const GROUPS = ["今期の手", "今週のタスク"];

class TrayTaskModal extends FuzzySuggestModal<PickableItem> {
    private items: PickableItem[];
    private resolve: (title: string | null) => void;
    private chosen = false;
    // The rows currently shown, to tell which one opens its group.
    private shown: FuzzyMatch<PickableItem>[] = [];

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

    // Fuzzy matching sorts by score across groups; keep the groups apart
    // (stable sort, so the score order survives within each group).
    getSuggestions(query: string): FuzzyMatch<PickableItem>[] {
        this.shown = super
            .getSuggestions(query)
            .sort((a, b) => a.item.group - b.item.group);
        return this.shown;
    }

    renderSuggestion(match: FuzzyMatch<PickableItem>, el: HTMLElement): void {
        super.renderSuggestion(match, el);
        const i = this.shown.indexOf(match);
        if (
            i < 0 ||
            (i > 0 && this.shown[i - 1].item.group === match.item.group)
        ) {
            return;
        }
        // A sibling before the row, so it isn't part of the selectable row.
        const heading = createDiv({ text: GROUPS[match.item.group] });
        heading.style.cssText =
            "padding: 6px 12px 2px; font-size: var(--font-ui-smaller);" +
            "color: var(--text-muted); pointer-events: none;" +
            (i > 0
                ? "margin-top: 4px; border-top: 1px solid var(--background-modifier-border);"
                : "");
        if (el.parentElement) {
            el.parentElement.insertBefore(heading, el);
        } else {
            el.prepend(heading);
        }
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
 * Let the user pick one of the term's bets (for the term covering `date`,
 * YYYY-MM-DD) or this sprint's tasks. Resolves with the work-log title to
 * write, or null if the modal is dismissed without a choice.
 */
export async function pickTrayTask(
    plugin: FullCalendarPlugin,
    date: string
): Promise<string | null> {
    const bets: PickableItem[] = (
        await termBetsFor(plugin.app, plugin.settings.termFolder || "", date)
    ).map((bet) => ({ label: bet.name, title: bet.title, group: 0 }));
    const tasks: PickableItem[] = [];
    for (const card of trayCards(plugin)) {
        const linktext = linktextForEvent(plugin, card.id);
        if (linktext) {
            tasks.push({
                label: card.event.title,
                title: `[[${linktext}]]`,
                group: 1,
            });
        }
    }
    const items = [...bets, ...tasks];
    if (items.length === 0) {
        new Notice("No term bets or sprint tasks to log a session for.");
        return null;
    }
    return new Promise((resolve) => {
        new TrayTaskModal(plugin, items, resolve).open();
    });
}
