import { Draggable } from "@fullcalendar/interaction";
import type FullCalendarPlugin from "../main";
import { collectTaskCards, Card } from "./kanban";
import { sprintBucket, weekOf } from "./sprint";
import { openFileForEvent } from "./actions";

/*
 * Task tray: a slim column next to the calendar listing this sprint's
 * unfinished tasks. Tasks are "stamps" — dragging one onto the calendar
 * doesn't move the task, it creates a work-log session at the drop position
 * (see core/worklog.ts), so the same task can be worked across many days
 * without ever splitting the note.
 */

export type TaskTray = { refresh: () => void; destroy: () => void };

const cardDone = (c: Card): boolean =>
    c.event.completed === true || c.event.status === "Done";

/** This sprint's unfinished tasks, carry-overs included. */
export function trayCards(plugin: FullCalendarPlugin): Card[] {
    const currentWeek = weekOf(0);
    return collectTaskCards(plugin).filter((c) => {
        if (cardDone(c)) {
            return false;
        }
        const bucket = sprintBucket(c.event.sprint, false, currentWeek);
        return bucket === currentWeek || bucket === "carryover";
    });
}

/** The wikilink target for a card's task note (basename without .md). */
function cardLinktext(plugin: FullCalendarPlugin, card: Card): string | null {
    try {
        const { location } = plugin.cache.getInfoForEditableEvent(card.id);
        const path = location?.path;
        if (!path) {
            return null;
        }
        return path.split("/").pop()!.replace(/\.md$/, "");
    } catch {
        return null;
    }
}

export function renderTaskTray(
    plugin: FullCalendarPlugin,
    el: HTMLElement
): TaskTray {
    // FullCalendar's external-drag integration: any .ofc-tray-card inside the
    // tray can be dropped on the calendar. The event title carries the task
    // wikilink so the drop handler can write the session line.
    const draggable = new Draggable(el, {
        itemSelector: ".ofc-tray-card",
        eventData: (cardEl) => ({
            title: `[[${(cardEl as HTMLElement).dataset.linktext}]]`,
            duration: "01:00",
        }),
    });

    const refresh = () => {
        el.empty();
        el.createDiv({
            cls: "ofc-tray-header",
            text: `This week · ${weekOf(0)}`,
        });
        const cards = trayCards(plugin);
        if (cards.length === 0) {
            el.createDiv({
                cls: "ofc-tray-empty",
                text: "No unfinished tasks this sprint.",
            });
            return;
        }
        for (const card of cards) {
            const linktext = cardLinktext(plugin, card);
            if (!linktext) {
                continue;
            }
            const cardEl = el.createDiv({ cls: "ofc-tray-card" });
            cardEl.dataset.linktext = linktext;
            cardEl.createDiv({
                cls: "ofc-tray-card-title",
                text: card.event.title,
            });
            if (card.event.status) {
                cardEl.createDiv({
                    cls: "ofc-tray-card-meta",
                    text: card.event.status,
                });
            }
            // Same affordance as calendar events: ctrl/cmd-click opens the
            // task note. A plain click stays free for drag interactions.
            cardEl.addEventListener("click", async (ev) => {
                if (
                    ev.getModifierState("Control") ||
                    ev.getModifierState("Meta")
                ) {
                    await openFileForEvent(plugin.cache, plugin.app, card.id);
                }
            });
        }
    };
    refresh();
    return { refresh, destroy: () => draggable.destroy() };
}
