import { Platform, setIcon } from "obsidian";
import { DateTime } from "luxon";
import { Draggable } from "@fullcalendar/interaction";
import type FullCalendarPlugin from "../main";
import { collectTaskCards, Card } from "./kanban";
import { dueBadge, sprintBucket, weekOf } from "./sprint";
import { openFileForEvent } from "./actions";
import { launchEditModal } from "./event_modal";
import { toggleTask } from "./tasks";
import {
    contrastTextColor,
    getStatusColor,
    isDoneStatus,
    trayCollapsedByDefault,
    workflowStages,
} from "./colors";
import DailyNoteCalendar from "../calendars/DailyNoteCalendar";
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
 * Task tray: THE work list next to the calendar. Cards live in status
 * groups (stage order, collapsible; late stages start tucked away), and
 * keep a manual order within their group. One drag gesture on the card
 * body does both jobs: moving inside the tray reorders, crossing into the
 * calendar stamps a work-log session at the drop position (the task itself
 * never moves — see core/worklog.ts). Dragging a TODO onto the calendar
 * reschedules the TODO line itself.
 */

export type TaskTray = { refresh: () => void; destroy: () => void };

const cardDone = (c: Card): boolean => isDoneStatus(c.event.status);

/**
 * Arrange a group's cards by the saved manual order; cards the order
 * doesn't know yet append at the end. ":"-prefixed entries are leftovers
 * from the retired divider feature and are skipped.
 */
function arrangeCards(
    entries: string[],
    cardsByLink: Map<string, Card>
): { card: Card; linktext: string }[] {
    const pending = new Map(cardsByLink);
    const items: { card: Card; linktext: string }[] = [];
    for (const entry of entries) {
        if (entry.startsWith(":")) {
            continue;
        }
        const card = pending.get(entry);
        if (card) {
            items.push({ card, linktext: entry });
            pending.delete(entry);
        }
    }
    for (const [linktext, card] of pending) {
        items.push({ card, linktext });
    }
    return items;
}

/**
 * Persist the manual order: every card currently visible in a group body,
 * in DOM order, then the previously saved entries that aren't visible right
 * now (cards inside collapsed groups keep their relative order). One flat
 * list per sprint week — groups filter it down to their own members.
 */
async function saveOrderFromTray(
    plugin: FullCalendarPlugin,
    trayEl: HTMLElement
): Promise<void> {
    const entries: string[] = [];
    for (const cardEl of Array.from(
        trayEl.querySelectorAll(".ofc-tray-group-body .ofc-tray-card")
    ) as HTMLElement[]) {
        if (cardEl.dataset.linktext) {
            entries.push(cardEl.dataset.linktext);
        }
    }
    const week = weekOf(0);
    const seen = new Set(entries);
    for (const old of plugin.settings.trayOrder?.[week] ?? []) {
        if (!old.startsWith(":") && !seen.has(old)) {
            entries.push(old);
        }
    }
    plugin.settings.trayOrder = { [week]: entries };
    await plugin.saveTrayOrder();
}

/**
 * One drag gesture, two meanings: while the pointer stays inside the tray
 * the card reorders live within its group; once it crosses out toward the
 * calendar the card snaps back home and FullCalendar's external drag (which
 * has been running in parallel the whole time, its mirror hidden while we
 * reorder) takes over to stamp a session. Desktop only — on mobile a drag
 * on the card body must keep scrolling the list.
 */
function makeBodyReorderable(
    cardEl: HTMLElement,
    groupBody: HTMLElement,
    trayEl: HTMLElement,
    onDrop: () => Promise<void>
): void {
    if (Platform.isMobile) {
        return;
    }
    cardEl.addEventListener("pointerdown", (ev) => {
        // Checkbox and ▶ clicks are actions, not drags.
        if ((ev.target as HTMLElement).closest("input, button")) {
            return;
        }
        const startX = ev.clientX;
        const startY = ev.clientY;
        const homeNext = cardEl.nextSibling;
        let reordering = false;
        let moved = false;

        const insideTray = (e: PointerEvent) => {
            const r = trayEl.getBoundingClientRect();
            return (
                e.clientX >= r.left &&
                e.clientX <= r.right &&
                e.clientY >= r.top &&
                e.clientY <= r.bottom
            );
        };
        const enterReorder = () => {
            reordering = true;
            cardEl.addClass("ofc-tray-reordering");
            document.body.addClass("ofc-tray-reorder-active");
        };
        const leaveReorder = (goHome: boolean) => {
            reordering = false;
            cardEl.removeClass("ofc-tray-reordering");
            document.body.removeClass("ofc-tray-reorder-active");
            if (goHome) {
                groupBody.insertBefore(cardEl, homeNext);
            }
        };

        const onMove = (e: PointerEvent) => {
            if (!moved) {
                if (
                    Math.abs(e.clientX - startX) < 5 &&
                    Math.abs(e.clientY - startY) < 5
                ) {
                    return;
                }
                moved = true;
            }
            if (insideTray(e)) {
                if (!reordering) {
                    enterReorder();
                }
                const siblings = (
                    Array.from(groupBody.children) as HTMLElement[]
                ).filter((c) => c !== cardEl);
                let before: HTMLElement | null = null;
                for (const sib of siblings) {
                    const r = sib.getBoundingClientRect();
                    if (e.clientY < r.top + r.height / 2) {
                        before = sib;
                        break;
                    }
                }
                groupBody.insertBefore(cardEl, before);
            } else if (reordering) {
                // Crossed out toward the calendar: undo the reorder and let
                // FullCalendar's mirror carry the drag from here.
                leaveReorder(true);
            }
        };
        const onUp = async () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            if (reordering) {
                leaveReorder(false);
                await onDrop();
            }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    });
}

/**
 * This sprint's tasks, carry-overs included. Done tasks stay visible — the
 * tray doubles as an at-a-glance retrospective, and a mis-tapped checkbox
 * can be unticked — but collapse into their status group. Done tasks from
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
    // Done sinks last — the task picker (and any other consumer) reads this
    // order directly; the tray itself re-arranges by groups + manual order.
    return cards.sort((a, b) => Number(cardDone(a)) - Number(cardDone(b)));
}

/** Open, day-scoped TODO lines up to today, oldest (most forgotten) first. */
function collectTrayTodos(
    plugin: FullCalendarPlugin
): { id: string; title: string; date: string }[] {
    const today = DateTime.now().toISODate();
    const todos: { id: string; title: string; date: string }[] = [];
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (!(cal instanceof DailyNoteCalendar) || !cal.todos) {
            continue;
        }
        for (const { id, event } of source.events) {
            if (event.type !== "single" || event.completed !== false) {
                continue;
            }
            if (event.date > today) {
                continue;
            }
            todos.push({ id, title: event.title, date: event.date });
        }
    }
    return todos.sort((a, b) => a.date.localeCompare(b.date));
}

export function renderTaskTray(
    plugin: FullCalendarPlugin,
    el: HTMLElement,
    opts: { draggable?: boolean } = {}
): TaskTray {
    // FullCalendar's external-drag integration. Task cards drop as new
    // work-log sessions; TODO rows carry their event id so the drop handler
    // reschedules the existing line instead. Mobile opts out — sessions are
    // started with the ▶ button there.
    const draggables =
        opts.draggable === false
            ? []
            : [
                  new Draggable(el, {
                      itemSelector: ".ofc-tray-card",
                      eventData: (cardEl) => ({
                          title: `[[${
                              (cardEl as HTMLElement).dataset.linktext
                          }]]`,
                          duration: "01:00",
                      }),
                  }),
                  new Draggable(el, {
                      itemSelector: ".ofc-tray-todo",
                      eventData: (rowEl) => ({
                          title: (rowEl as HTMLElement).dataset.todoTitle,
                          duration: "00:30",
                          extendedProps: {
                              trayTodoId: (rowEl as HTMLElement).dataset.todoId,
                          },
                      }),
                  }),
              ];

    // Carryovers (past-week sprints) that this tray has shown as unfinished:
    // when one gets checked it would otherwise fall out of the sprint filter
    // instantly. Keyed by linktext — event IDs churn on file edits.
    const seenUnfinished = new Set<string>();

    // Click-vs-drag suppression shared by cards and TODO rows: browsers fire
    // a click after a drag; ignore it when the pointer travelled.
    const suppressDragClick = (
        itemEl: HTMLElement,
        onClick: (ev: MouseEvent) => void
    ) => {
        let downAt: { x: number; y: number } | null = null;
        itemEl.addEventListener("mousedown", (ev) => {
            downAt = { x: ev.clientX, y: ev.clientY };
        });
        itemEl.addEventListener("click", (ev) => {
            if (
                downAt &&
                (Math.abs(ev.clientX - downAt.x) > 5 ||
                    Math.abs(ev.clientY - downAt.y) > 5)
            ) {
                return;
            }
            onClick(ev);
        });
    };

    const refresh = () => {
        el.empty();
        const headerEl = el.createDiv({ cls: "ofc-tray-header" });
        headerEl.createSpan({ text: `This week · ${weekOf(0)}` });

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

        const renderCard = (
            parent: HTMLElement,
            card: Card,
            linktext: string
        ) => {
            const session = runningByLink.get(linktext);
            const done = cardDone(card);
            if (!done) {
                seenUnfinished.add(linktext);
            }
            const cardEl = parent.createDiv({ cls: "ofc-tray-card" });
            if (session) {
                cardEl.addClass("ofc-tray-card-running");
            }
            if (done) {
                cardEl.addClass("ofc-tray-card-done");
            }
            cardEl.dataset.linktext = linktext;
            makeBodyReorderable(cardEl, parent, el, () =>
                saveOrderFromTray(plugin, el)
            );

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
                session ? `● ${session.event.startTime} -` : null,
                actual > 0 || estimate > 0
                    ? `⏱ ${formatHours(actual)}${
                          estimate > 0 ? ` / ${formatHours(estimate)}` : ""
                      }`
                    : null,
            ].filter((p): p is string => !!p);
            const due = done ? null : dueBadge(card.event.due);
            if (parts.length > 0 || due) {
                const metaEl = bodyEl.createDiv({
                    cls: "ofc-tray-card-meta",
                });
                metaEl.setText(parts.join(" · "));
                if (due) {
                    const dueEl = metaEl.createSpan({
                        cls: "ofc-tray-card-due",
                        text: (parts.length > 0 ? " · " : "") + due.text,
                    });
                    if (due.urgent) {
                        dueEl.addClass("ofc-tray-card-due-urgent");
                    }
                }
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
            // (same affordance as calendar events).
            suppressDragClick(cardEl, async (ev) => {
                if (
                    ev.getModifierState("Control") ||
                    ev.getModifierState("Meta")
                ) {
                    await openFileForEvent(plugin.cache, plugin.app, card.id);
                } else {
                    launchEditModal(plugin, card.id);
                }
            });
        };

        // --- Status groups: every stage in kanban order, then any
        // off-registry statuses so no card can hide. Within a group, cards
        // follow the manual order. Late stages start collapsed.
        const stages = workflowStages();
        const extras = [
            ...new Set(
                cards
                    .map((c) => c.event.status)
                    .filter(
                        (s): s is string =>
                            s !== undefined && !stages.includes(s)
                    )
            ),
        ].sort();
        const entries = plugin.settings.trayOrder?.[weekOf(0)] ?? [];

        for (const stage of [...stages, ...extras]) {
            const groupCards = cards.filter((c) => c.event.status === stage);
            if (groupCards.length === 0) {
                continue;
            }
            const expanded =
                plugin.settings.trayExpanded?.[stage] ??
                !trayCollapsedByDefault(stage);
            const header = el.createDiv({ cls: "ofc-tray-group" });
            const chevron = header.createSpan({
                cls: "ofc-tray-group-chevron",
            });
            setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
            header.createSpan({
                cls: "ofc-tray-group-name",
                text: stage,
            });
            const swatch = getStatusColor(stage);
            if (swatch) {
                header.style.setProperty("--ofc-group-color", swatch);
            }
            header.createSpan({
                cls: "ofc-tray-group-count",
                text: String(groupCards.length),
            });
            header.onclick = async () => {
                plugin.settings.trayExpanded = {
                    ...plugin.settings.trayExpanded,
                    [stage]: !expanded,
                };
                await plugin.saveTrayOrder();
                refresh();
            };
            if (expanded) {
                const body = el.createDiv({ cls: "ofc-tray-group-body" });
                const byLink = new Map<string, Card>();
                for (const c of groupCards) {
                    const link = linktextForEvent(plugin, c.id);
                    if (link) {
                        byLink.set(link, c);
                    }
                }
                for (const item of arrangeCards(entries, byLink)) {
                    renderCard(body, item.card, item.linktext);
                }
            }
        }

        if (cards.length === 0) {
            el.createDiv({
                cls: "ofc-tray-empty",
                text: "No unfinished tasks this sprint.",
            });
        }

        // --- Open TODOs from daily notes, up to today. Rolling forward is
        // manual; this list is where forgotten ones stay visible.
        const todos = collectTrayTodos(plugin);
        if (todos.length > 0) {
            el.createDiv({ cls: "ofc-tray-section", text: "TODO" });
            for (const todo of todos) {
                const row = el.createDiv({ cls: "ofc-tray-todo" });
                row.dataset.todoId = todo.id;
                row.dataset.todoTitle = todo.title;
                const check = row.createEl("input", {
                    type: "checkbox",
                    cls: "ofc-tray-todo-check",
                });
                check.setAttr("aria-label", "Mark done");
                check.onclick = async (ev) => {
                    ev.stopPropagation();
                    await plugin.cache.processEvent(todo.id, (e) =>
                        toggleTask(e, true)
                    );
                };
                row.createDiv({
                    cls: "ofc-tray-todo-body",
                    text: todo.title,
                });
                if (todo.date < today) {
                    const d = DateTime.fromISO(todo.date);
                    row.createSpan({
                        cls: "ofc-tray-todo-date",
                        text: d.isValid ? `${d.month}/${d.day}` : todo.date,
                    });
                }
                suppressDragClick(row, () => {
                    launchEditModal(plugin, todo.id);
                });
            }
        }
    };
    refresh();
    return {
        refresh,
        destroy: () => draggables.forEach((d) => d.destroy()),
    };
}
