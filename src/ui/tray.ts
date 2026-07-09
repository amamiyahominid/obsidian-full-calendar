import { setIcon } from "obsidian";
import { DateTime } from "luxon";
import { Draggable } from "@fullcalendar/interaction";
import type FullCalendarPlugin from "../main";
import { collectTaskCards, Card } from "./kanban";
import { sprintBucket, weekOf } from "./sprint";
import { openFileForEvent } from "./actions";
import { launchEditModal } from "./event_modal";
import { toggleTask } from "./tasks";
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

const cardDone = (c: Card): boolean => isDoneStatus(c.event.status);

/**
 * This sprint's tasks, carry-overs included. Done tasks stay visible — the
 * tray doubles as an at-a-glance retrospective, and a mis-tapped checkbox
 * can be unticked — but sink below the unfinished ones. Done tasks from
 * PAST weeks are normally hidden, EXCEPT ones `isSticky` vouches for:
 * finishing a carryover must not make its card vanish mid-session.
 */
export function trayCards(
    plugin: FullCalendarPlugin,
    isSticky?: (c: Card) => boolean
): Card[] {
    const currentWeek = weekOf(0);
    const cards = collectTaskCards(plugin).filter((c) => {
        const done = cardDone(c);
        const bucket = sprintBucket(c.event.sprint, done, currentWeek);
        if (bucket === currentWeek || bucket === "carryover") {
            return true;
        }
        return done && bucket === null && (isSticky?.(c) ?? false);
    });
    return cards.sort((a, b) => Number(cardDone(a)) - Number(cardDone(b)));
}

export function renderTaskTray(
    plugin: FullCalendarPlugin,
    el: HTMLElement,
    opts: { draggable?: boolean } = {}
): TaskTray {
    // FullCalendar's external-drag integration: any .ofc-tray-card inside the
    // tray can be dropped on the calendar. The event title carries the task
    // wikilink so the drop handler can write the session line. Mobile opts
    // out — sessions are started with the ▶ button there.
    const draggable =
        opts.draggable === false
            ? null
            : new Draggable(el, {
                  itemSelector: ".ofc-tray-card",
                  eventData: (cardEl) => ({
                      title: `[[${(cardEl as HTMLElement).dataset.linktext}]]`,
                      duration: "01:00",
                  }),
              });

    // Carryovers (past-week sprints) that this tray has shown as unfinished:
    // when one gets checked it would otherwise fall out of the sprint filter
    // instantly. Keyed by linktext — event IDs churn on file edits.
    const seenUnfinished = new Set<string>();

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
        const cards = trayCards(plugin, (c) => {
            const link = linktextForEvent(plugin, c.id);
            return !!link && seenUnfinished.has(link);
        });
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
            const done = cardDone(card);
            if (!done) {
                seenUnfinished.add(linktext);
            }
            const cardEl = el.createDiv({ cls: "ofc-tray-card" });
            if (session) {
                cardEl.addClass("ofc-tray-card-running");
            }
            if (done) {
                cardEl.addClass("ofc-tray-card-done");
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

            // Finish (or un-finish a mis-tap) right from the tray.
            const check = cardEl.createEl("input", {
                type: "checkbox",
                cls: "ofc-tray-card-check",
            });
            check.checked = done;
            check.setAttr("aria-label", done ? "Reopen" : "Mark done");
            check.onclick = async (ev) => {
                ev.stopPropagation();
                await plugin.cache.processEvent(card.id, (e) =>
                    toggleTask(e, !done)
                );
            };

            const bodyEl = cardEl.createDiv({ cls: "ofc-tray-card-body" });
            bodyEl.createDiv({
                cls: "ofc-tray-card-title",
                text: card.event.title,
            });
            const actual = actuals.get(linktext) ?? 0;
            const estimate = card.event.estimate ?? 0;
            const parts = [
                session ? `● ${session.event.startTime} -` : card.event.status,
                actual > 0 || estimate > 0
                    ? `⏱ ${formatHours(actual)}${
                          estimate > 0 ? ` / ${formatHours(estimate)}` : ""
                      }`
                    : null,
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

            // Click opens the edit modal; ctrl/cmd-click opens the task note
            // (same affordance as calendar events). Suppress the click that
            // browsers fire after a drag by checking how far the pointer
            // moved since mousedown.
            let downAt: { x: number; y: number } | null = null;
            cardEl.addEventListener("mousedown", (ev) => {
                downAt = { x: ev.clientX, y: ev.clientY };
            });
            cardEl.addEventListener("click", async (ev) => {
                if (
                    downAt &&
                    (Math.abs(ev.clientX - downAt.x) > 5 ||
                        Math.abs(ev.clientY - downAt.y) > 5)
                ) {
                    return;
                }
                if (
                    ev.getModifierState("Control") ||
                    ev.getModifierState("Meta")
                ) {
                    await openFileForEvent(plugin.cache, plugin.app, card.id);
                } else {
                    launchEditModal(plugin, card.id);
                }
            });
        }
    };
    refresh();
    return { refresh, destroy: () => draggable?.destroy() };
}
