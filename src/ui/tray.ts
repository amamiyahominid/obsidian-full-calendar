import { setIcon } from "obsidian";
import { DateTime } from "luxon";
import { Draggable } from "@fullcalendar/interaction";
import type FullCalendarPlugin from "../main";
import { collectTaskCards, Card } from "./kanban";
import { dueBadge, sprintBucket, weekOf } from "./sprint";
import { openFileForEvent } from "./actions";
import { launchEditModal } from "./event_modal";
import { toggleTask } from "./tasks";
import { contrastTextColor, getStatusColor, isDoneStatus } from "./colors";
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
 * Task tray: THE work list next to the calendar. Sprint tasks in a manually
 * draggable order (with free-label divider rows for grouping), then the open
 * TODOs from daily notes. Tasks are "stamps" — dragging one onto the calendar
 * doesn't move the task, it creates a work-log session at the drop position
 * (see core/worklog.ts); dragging a TODO onto the calendar reschedules the
 * TODO line itself.
 */

export type TaskTray = { refresh: () => void; destroy: () => void };

const cardDone = (c: Card): boolean => isDoneStatus(c.event.status);

// Manual-order entries are task linktexts; divider rows are stored as
// ":label" — ":" can't appear in a note filename, so the two never collide.
const DIVIDER_PREFIX = ":";

type TrayItem =
    | { kind: "card"; card: Card; linktext: string }
    | { kind: "divider"; label: string };

/**
 * Interleave the saved manual order with this refresh's unfinished cards.
 * Entries whose card is gone are dropped; cards the order doesn't know yet
 * (created since the last drag) append at the end.
 */
function arrangeItems(
    entries: string[],
    cardsByLink: Map<string, Card>
): TrayItem[] {
    const pending = new Map(cardsByLink);
    const items: TrayItem[] = [];
    for (const entry of entries) {
        if (entry.startsWith(DIVIDER_PREFIX)) {
            items.push({ kind: "divider", label: entry.slice(1) });
            continue;
        }
        const card = pending.get(entry);
        if (card) {
            items.push({ kind: "card", card, linktext: entry });
            pending.delete(entry);
        }
    }
    for (const [linktext, card] of pending) {
        items.push({ kind: "card", card, linktext });
    }
    return items;
}

/**
 * Persist whatever sequence the sortable list currently shows. Only the
 * current week's key is kept — the order is a per-sprint artifact.
 */
async function saveOrderFromDom(
    plugin: FullCalendarPlugin,
    listEl: HTMLElement
): Promise<void> {
    const entries: string[] = [];
    for (const child of Array.from(listEl.children) as HTMLElement[]) {
        if (child.dataset.divider !== undefined) {
            entries.push(DIVIDER_PREFIX + child.dataset.divider);
        } else if (child.dataset.linktext) {
            entries.push(child.dataset.linktext);
        }
    }
    plugin.settings.trayOrder = { [weekOf(0)]: entries };
    await plugin.saveTrayOrder();
}

/**
 * Make `itemEl` vertically draggable within `listEl` by its handle. The
 * handle swallows pointerdown so FullCalendar's external-drag (attached to
 * the whole card) never sees it — grab the handle to reorder, grab the card
 * body to drag onto the calendar. preventDefault also suppresses the
 * compatibility mouse events, so the card's click handler stays quiet.
 */
function makeReorderable(
    handle: HTMLElement,
    itemEl: HTMLElement,
    listEl: HTMLElement,
    onDrop: () => Promise<void>
): void {
    handle.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const startY = ev.clientY;
        let dragging = false;
        const onMove = (e: PointerEvent) => {
            if (!dragging) {
                if (Math.abs(e.clientY - startY) < 4) {
                    return;
                }
                dragging = true;
                itemEl.addClass("ofc-tray-reordering");
            }
            const siblings = (
                Array.from(listEl.children) as HTMLElement[]
            ).filter((c) => c !== itemEl);
            let before: HTMLElement | null = null;
            for (const sib of siblings) {
                const r = sib.getBoundingClientRect();
                if (e.clientY < r.top + r.height / 2) {
                    before = sib;
                    break;
                }
            }
            listEl.insertBefore(itemEl, before);
        };
        const onUp = async () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            if (dragging) {
                itemEl.removeClass("ofc-tray-reordering");
                await onDrop();
            }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    });
    // FullCalendar's Draggable may bind mouse/touch events directly on
    // platforms without pointer events; keep those away from the handle too.
    for (const type of ["mousedown", "touchstart"]) {
        handle.addEventListener(type, (ev) => ev.stopPropagation());
    }
}

/**
 * A free-label divider row: reorderable like a card, label edits in place,
 * ✕ removes it. Returns the element and an "edit now" hook so a freshly
 * added divider can open straight into naming.
 */
function renderDivider(
    plugin: FullCalendarPlugin,
    listEl: HTMLElement,
    label: string
): { el: HTMLElement; beginEdit: () => void } {
    const el = listEl.createDiv({ cls: "ofc-tray-divider" });
    el.dataset.divider = label;
    const handle = el.createDiv({ cls: "ofc-tray-handle" });
    setIcon(handle, "grip-vertical");
    makeReorderable(handle, el, listEl, () => saveOrderFromDom(plugin, listEl));

    const labelEl = el.createSpan({
        cls: "ofc-tray-divider-label",
        text: label || "———",
    });
    el.createDiv({ cls: "ofc-tray-divider-rule" });

    const beginEdit = () => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "ofc-tray-divider-input";
        input.value = el.dataset.divider ?? "";
        labelEl.replaceWith(input);
        input.focus();
        input.select();
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                input.blur();
            } else if (e.key === "Escape") {
                input.value = el.dataset.divider ?? "";
                input.blur();
            }
        });
        input.addEventListener("blur", async () => {
            const v = input.value.trim();
            el.dataset.divider = v;
            labelEl.setText(v || "———");
            input.replaceWith(labelEl);
            await saveOrderFromDom(plugin, listEl);
        });
    };
    labelEl.addEventListener("click", beginEdit);

    const del = el.createEl("button", { cls: "ofc-tray-divider-x" });
    setIcon(del, "x");
    del.setAttr("aria-label", "Remove divider");
    del.onclick = async () => {
        el.remove();
        await saveOrderFromDom(plugin, listEl);
    };
    return { el, beginEdit };
}

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
        const addDividerBtn = headerEl.createEl("button", {
            cls: "ofc-tray-add-divider",
        });
        setIcon(addDividerBtn, "separator-horizontal");
        addDividerBtn.setAttr("aria-label", "Add divider");

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
            linktext: string,
            reorderable: boolean
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

            if (reorderable) {
                const handle = cardEl.createDiv({ cls: "ofc-tray-handle" });
                setIcon(handle, "grip-vertical");
                makeReorderable(handle, cardEl, parent, () =>
                    saveOrderFromDom(plugin, parent)
                );
            }

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

        // --- Tasks: unfinished in manual order (dividers included), done
        // sunk below, outside the sortable region.
        const byLink = new Map<string, Card>();
        for (const c of cards) {
            if (cardDone(c)) {
                continue;
            }
            const link = linktextForEvent(plugin, c.id);
            if (link) {
                byLink.set(link, c);
            }
        }
        const entries = plugin.settings.trayOrder?.[weekOf(0)] ?? [];
        const items = arrangeItems(entries, byLink);

        const listEl = el.createDiv({ cls: "ofc-tray-list" });
        for (const item of items) {
            if (item.kind === "divider") {
                renderDivider(plugin, listEl, item.label);
            } else {
                renderCard(listEl, item.card, item.linktext, true);
            }
        }
        addDividerBtn.onclick = () => {
            const { el: divEl, beginEdit } = renderDivider(plugin, listEl, "");
            listEl.insertBefore(divEl, listEl.firstChild);
            beginEdit();
        };

        for (const card of cards.filter(cardDone)) {
            const linktext = linktextForEvent(plugin, card.id);
            if (linktext) {
                renderCard(el, card, linktext, false);
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
