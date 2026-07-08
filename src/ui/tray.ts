import { setIcon } from "obsidian";
import { DateTime } from "luxon";
import { Draggable } from "@fullcalendar/interaction";
import type FullCalendarPlugin from "../main";
import { collectTaskCards, Card } from "./kanban";
import { sprintBucket, weekOf } from "./sprint";
import { openFileForEvent } from "./actions";
import { contrastTextColor, getStatusColor, isDoneStatus } from "./colors";
import {
    actualMinutesByLinktext,
    findRunningSessions,
    firstLinktext,
    linktextForEvent,
    startSession,
    stopSession,
    RunningSession,
} from "../core/worklog";
import { formatHours } from "./sprint";

/*
 * Task tray: a slim column next to the calendar listing this sprint's
 * unfinished tasks. Tasks are "stamps" — dragging one onto the calendar
 * doesn't move the task, it creates a work-log session at the drop position
 * (see core/worklog.ts), so the same task can be worked across many days
 * without ever splitting the note.
 */

export type TaskTray = { refresh: () => void; destroy: () => void };

// Status is the source of truth when present; `completed` only decides for
// legacy notes that never picked a workflow stage.
const cardDone = (c: Card): boolean =>
    c.event.status !== undefined
        ? isDoneStatus(c.event.status)
        : c.event.completed === true;

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

        const running = findRunningSessions(plugin);
        const today = DateTime.now().toISODate();

        // Forgotten stops: a session still running from a previous day.
        // Stopping closes it at 23:59 of its own day; resize to fine-tune.
        for (const stale of running.filter((r) => r.event.date < today)) {
            const row = el.createDiv({ cls: "ofc-tray-warning" });
            row.createSpan({
                text: `⏱ ${stale.event.title} — running since ${stale.event.date}`,
            });
            const btn = row.createEl("button", { text: "Stop" });
            btn.onclick = async () => {
                await stopSession(plugin, stale);
            };
        }

        const runningByLink = new Map<string, RunningSession>();
        for (const r of running) {
            const link = firstLinktext(r.event.title);
            if (link) {
                runningByLink.set(link, r);
            }
        }

        const actuals = actualMinutesByLinktext(plugin);
        const cards = trayCards(plugin);
        if (cards.length === 0) {
            el.createDiv({
                cls: "ofc-tray-empty",
                text: "No unfinished tasks this sprint.",
            });
            return;
        }
        for (const card of cards) {
            const linktext = linktextForEvent(plugin, card.id);
            if (!linktext) {
                continue;
            }
            const session = runningByLink.get(linktext);
            const cardEl = el.createDiv({ cls: "ofc-tray-card" });
            if (session) {
                cardEl.addClass("ofc-tray-card-running");
            }
            cardEl.dataset.linktext = linktext;

            // Match the calendar's event rendering (see toEventInput): fill
            // by workflow status, frame in the source calendar's color.
            const fill =
                (card.event.status && getStatusColor(card.event.status)) ||
                card.sourceColor ||
                null;
            cardEl.style.borderColor =
                card.sourceColor || "var(--interactive-accent)";
            if (fill) {
                cardEl.style.backgroundColor = fill;
                cardEl.style.color = contrastTextColor(fill);
            }

            const bodyEl = cardEl.createDiv({ cls: "ofc-tray-card-body" });
            bodyEl.createDiv({
                cls: "ofc-tray-card-title",
                text: card.event.title,
            });
            const minutes = actuals.get(linktext) ?? 0;
            const parts = [
                session ? `● ${session.event.startTime}–` : card.event.status,
                minutes > 0 ? `⏱ ${formatHours(minutes)}` : null,
            ].filter((p): p is string => !!p);
            if (parts.length > 0) {
                bodyEl.createDiv({
                    cls: "ofc-tray-card-meta",
                    text: parts.join(" · "),
                });
            }

            const btn = cardEl.createEl("button", {
                cls: "ofc-tray-card-btn",
            });
            setIcon(btn, session ? "square" : "play");
            btn.setAttr(
                "aria-label",
                session ? "Stop session" : "Start working now"
            );
            btn.onclick = async (ev) => {
                ev.stopPropagation();
                if (session) {
                    await stopSession(plugin, session);
                } else {
                    await startSession(plugin, `[[${linktext}]]`);
                }
            };

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
