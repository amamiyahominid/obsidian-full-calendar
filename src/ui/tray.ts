import { Notice, Platform, setIcon } from "obsidian";
import { DateTime } from "luxon";
import { Draggable } from "@fullcalendar/interaction";
import type FullCalendarPlugin from "../main";
import {
    collectTaskCards,
    moveCardToStatus,
    projectLabel,
    Card,
} from "./kanban";
import { dueBadge, sprintBucket, weekOf } from "./sprint";
import { openFileForEvent } from "./actions";
import { launchEditModal } from "./event_modal";
import { toggleTask } from "./tasks";
import {
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
import { MemoPanel, renderMemoPanel } from "./memoPanel";

/*
 * Task tray: THE work list next to the calendar. Cards live in status
 * groups (stage order, collapsible; late stages start tucked away), and
 * keep a manual order within their group. One drag gesture on the card
 * body does both jobs: moving inside the tray reorders, crossing into the
 * calendar stamps a work-log session at the drop position (the task itself
 * never moves — see core/worklog.ts). Dragging a TODO onto the calendar
 * reschedules the TODO line itself.
 *
 * Above the groups sits "今日": the daily note's TODO lines, which are THE
 * list for today. A line that is just a wikilink to a task note shows as
 * that task's card, and a week card dropped on the section (or sent with
 * its button) adds such a line — the task's own status and sprint are
 * untouched. A one-line memo field under it appends to the note's Memo.
 */

export type TaskTray = { refresh: () => void; destroy: () => void };

/** "[[a|b]] rest" → "b rest": TODO lines read as text, not as markup. */
const plainTitle = (title: string): string =>
    title.replace(
        /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
        (_m, target: string, alias?: string) => alias || target
    );

const shortDate = (iso: string): string => {
    const d = DateTime.fromISO(iso);
    return d.isValid ? `${d.month}/${d.day}` : iso;
};

/** What the mobile "today" bar above the calendar shows. */
export type TodaySummary = { open: number; first: string | null };

/** The task a TODO line stands for, when the line is nothing but a link. */
const soleLinktext = (title: string): string | null => {
    const m = title.trim().match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
    return m ? m[1].trim() : null;
};

function todoCalendarId(plugin: FullCalendarPlugin): string | null {
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (cal instanceof DailyNoteCalendar && cal.todos) {
            return source.id;
        }
    }
    return null;
}

/** Put a task on today's list: one `- [ ] [[task]]` line in the daily
 * note's TODO. A task already listed today is left alone. */
async function addTaskToToday(
    plugin: FullCalendarPlugin,
    linktext: string
): Promise<void> {
    const calendarId = todoCalendarId(plugin);
    if (!calendarId) {
        new Notice(
            'No TODO calendar configured. Add a "Daily Note" calendar with TODOs enabled in the Full Calendar settings.'
        );
        return;
    }
    const today = DateTime.now().toISODate();
    const listed = plugin.cache
        .getAllEvents()
        .filter((s) => s.id === calendarId)
        .flatMap((s) => s.events)
        .some(
            ({ event }) =>
                event.type === "single" &&
                event.date === today &&
                soleLinktext(event.title) === linktext
        );
    if (listed) {
        return;
    }
    try {
        await plugin.cache.addEvent(calendarId, {
            type: "single",
            title: `[[${linktext}]]`,
            date: today,
            endDate: null,
            allDay: true,
            completed: false,
        });
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
    }
}

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
 * One drag gesture, three meanings: while the pointer stays inside the
 * tray the card reorders live — within its group, or across groups (over
 * another group's cards inserts there; over a collapsed group's header
 * highlights it) — and dropping in a different group changes the task's
 * status. Crossing out toward the calendar snaps the card home and
 * FullCalendar's external drag (running in parallel, mirror hidden while
 * we reorder) takes over to stamp a session. Desktop lifts on movement;
 * mobile lifts on a ~350ms long-press so plain swipes keep scrolling the
 * list (there's no calendar handoff there — FC drags are disabled).
 */
function makeBodyDraggable(
    cardEl: HTMLElement,
    trayEl: HTMLElement,
    plugin: FullCalendarPlugin,
    cardId: string,
    ownStage: string | undefined
): void {
    cardEl.addEventListener("pointerdown", (ev) => {
        // Checkbox and ▶ clicks are actions, not drags.
        if ((ev.target as HTMLElement).closest("input, button")) {
            return;
        }
        const startX = ev.clientX;
        const startY = ev.clientY;
        const homeParent = cardEl.parentElement;
        const homeNext = cardEl.nextSibling;
        let lifted = !Platform.isMobile;
        let reordering = false;
        let moved = false;
        let headerTarget: HTMLElement | null = null;
        let todayTarget: HTMLElement | null = null;

        const liftTimer = Platform.isMobile
            ? window.setTimeout(() => {
                  lifted = true;
                  enterReorder();
              }, 350)
            : null;

        // iOS keeps scrolling unless post-lift touchmoves are cancelled,
        // which needs a non-passive listener.
        const onTouchMove = (e: TouchEvent) => {
            if (lifted && reordering) {
                e.preventDefault();
            }
        };
        cardEl.addEventListener("touchmove", onTouchMove, { passive: false });

        const insideTray = (e: PointerEvent) => {
            const r = trayEl.getBoundingClientRect();
            return (
                e.clientX >= r.left &&
                e.clientX <= r.right &&
                e.clientY >= r.top &&
                e.clientY <= r.bottom
            );
        };
        const clearHeaderTarget = () => {
            headerTarget?.removeClass("ofc-tray-group-droptarget");
            headerTarget = null;
            todayTarget?.removeClass("ofc-tray-today-droptarget");
            todayTarget = null;
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
            clearHeaderTarget();
            if (goHome && homeParent) {
                homeParent.insertBefore(cardEl, homeNext);
            }
        };

        // Place the card where the pointer says: inside whichever group
        // section the pointer is over. Expanded groups take the card
        // between their cards; a collapsed group highlights its header.
        const positionCard = (e: PointerEvent) => {
            clearHeaderTarget();
            // Over "今日": the card stays where it lives (adding it to today
            // doesn't move it out of its group) and the section lights up.
            const todayEl = trayEl.querySelector(
                ".ofc-tray-today"
            ) as HTMLElement | null;
            if (todayEl) {
                const r = todayEl.getBoundingClientRect();
                if (e.clientY >= r.top && e.clientY <= r.bottom) {
                    if (homeParent) {
                        homeParent.insertBefore(cardEl, homeNext);
                    }
                    todayTarget = todayEl;
                    todayEl.addClass("ofc-tray-today-droptarget");
                    return;
                }
            }
            type Section = {
                header: HTMLElement;
                body: HTMLElement | null;
            };
            const sections: Section[] = [];
            for (const header of Array.from(
                trayEl.querySelectorAll(".ofc-tray-group")
            ) as HTMLElement[]) {
                const next = header.nextElementSibling;
                sections.push({
                    header,
                    body:
                        next instanceof HTMLElement &&
                        next.classList.contains("ofc-tray-group-body")
                            ? next
                            : null,
                });
            }
            if (sections.length === 0) {
                return;
            }
            let target = sections[0];
            for (const s of sections) {
                if (e.clientY >= s.header.getBoundingClientRect().top) {
                    target = s;
                }
            }
            if (target.body) {
                const siblings = (
                    Array.from(target.body.children) as HTMLElement[]
                ).filter((c) => c !== cardEl);
                let before: HTMLElement | null = null;
                for (const sib of siblings) {
                    const r = sib.getBoundingClientRect();
                    if (e.clientY < r.top + r.height / 2) {
                        before = sib;
                        break;
                    }
                }
                target.body.insertBefore(cardEl, before);
            } else {
                headerTarget = target.header;
                headerTarget.addClass("ofc-tray-group-droptarget");
            }
        };

        const teardown = () => {
            if (liftTimer !== null) {
                window.clearTimeout(liftTimer);
            }
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            cardEl.removeEventListener("touchmove", onTouchMove);
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
                // Mobile: movement before the long-press fires is a scroll.
                if (!lifted) {
                    teardown();
                    return;
                }
            }
            if (!lifted) {
                return;
            }
            if (Platform.isMobile || insideTray(e)) {
                if (!reordering) {
                    enterReorder();
                }
                positionCard(e);
            } else if (reordering) {
                // Crossed out toward the calendar: undo the reorder and let
                // FullCalendar's mirror carry the drag from here.
                leaveReorder(true);
            }
        };
        const onUp = async () => {
            teardown();
            if (!reordering) {
                clearHeaderTarget();
                return;
            }
            if (todayTarget) {
                leaveReorder(true);
                const linktext = cardEl.dataset.linktext;
                if (linktext) {
                    await addTaskToToday(plugin, linktext);
                }
                return;
            }
            const dropStage = headerTarget
                ? headerTarget.dataset.stage
                : (cardEl.closest(".ofc-tray-group-body") as HTMLElement | null)
                      ?.dataset.stage;
            leaveReorder(false);
            // Persist the position first: the status write triggers a tray
            // refresh, which must already see the card's new slot.
            await saveOrderFromTray(plugin, trayEl);
            if (dropStage && dropStage !== ownStage) {
                await moveCardToStatus(plugin, cardId, dropStage);
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

type TrayTodo = {
    id: string;
    title: string;
    date: string;
    done: boolean;
    /** Line in its daily note — today's list reads in written order. */
    line: number;
};

// Sticky keys for TODO rows. Event IDs churn when the daily note is edited,
// so key on what identifies the line to a human instead.
const todoKey = (date: string, title: string) => `${date}::${title}`;

/**
 * Day-scoped TODO lines for the tray. Open ones up to today, oldest (most
 * forgotten) first; then today's checked ones — checking a box shouldn't
 * make the line vanish (mis-taps get unticked, and the list doubles as an
 * at-a-glance "what got done today"). Checked TODOs from PAST days are
 * history and stay hidden, EXCEPT ones `isSticky` vouches for: checking an
 * old TODO must not make it disappear mid-session.
 */
function collectTrayTodos(
    plugin: FullCalendarPlugin,
    isSticky?: (key: string) => boolean
): TrayTodo[] {
    const today = DateTime.now().toISODate();
    const todos: TrayTodo[] = [];
    for (const source of plugin.cache.getAllEvents()) {
        const cal = plugin.cache.getCalendarById(source.id);
        if (!(cal instanceof DailyNoteCalendar) || !cal.todos) {
            continue;
        }
        for (const { id, event } of source.events) {
            // Only checkbox lines carry a completed value; work-log sessions
            // and plain lines don't.
            if (
                event.type !== "single" ||
                event.completed === undefined ||
                event.completed === null
            ) {
                continue;
            }
            if (!event.date || event.date > today) {
                continue;
            }
            const done = event.completed !== false;
            if (
                done &&
                event.date !== today &&
                !(isSticky?.(todoKey(event.date, event.title)) ?? false)
            ) {
                continue;
            }
            let line = 0;
            try {
                line =
                    plugin.cache.getInfoForEditableEvent(id).location
                        ?.lineNumber ?? 0;
            } catch {
                // Not in the store any more; order it first.
            }
            todos.push({
                id,
                title: event.title,
                date: event.date,
                done,
                line,
            });
        }
    }
    // Done sinks last, mirroring the task cards; open ones oldest day
    // first, and within a day in the order they were written — the daily
    // note's order is the order to work in.
    return todos.sort((a, b) =>
        a.done !== b.done
            ? Number(a.done) - Number(b.done)
            : a.date.localeCompare(b.date) || a.line - b.line
    );
}

export function renderTaskTray(
    plugin: FullCalendarPlugin,
    el: HTMLElement,
    opts: {
        draggable?: boolean;
        // Host the memo panel inside the tray, between today and the week.
        memo?: boolean;
        // Shows a button on the 今日 heading that moves the tray into a
        // pane of its own.
        onPopOut?: () => void;
        // The reverse, shown when the tray IS a pane: close it, so the
        // calendar's built-in column comes back.
        onPopIn?: () => void;
        onToday?: (summary: TodaySummary) => void;
    } = {}
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

    // Same idea for TODO lines: an old (pre-today) TODO shown as open must
    // not vanish the moment it's checked. Keyed by date+title.
    const seenOpenTodos = new Set<string>();

    // Three fixed containers, redrawn separately: today's list on top, the
    // week's groups at the bottom, and — when the tray hosts it (mobile; on
    // desktop it's a column of its own) — the memo panel between them. The
    // memo's element is never rebuilt by a tray redraw, so an open editor
    // keeps its caret while cards come and go around it.
    const topEl = el.createDiv({ cls: "ofc-tray-top" });
    let memoPanel: MemoPanel | null = null;
    if (opts.memo) {
        memoPanel = renderMemoPanel(plugin, el.createDiv());
    }
    const weekEl = el.createDiv({ cls: "ofc-tray-week" });

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
        topEl.empty();
        weekEl.empty();

        const running = findRunningSessions(plugin);
        const today = DateTime.now().toISODate();

        // Forgotten stops: a session still running from a previous day.
        // Stopping closes it at 23:59 of its own day; resize to fine-tune.
        for (const stale of running.filter(
            (r) => r.event.date && r.event.date < today
        )) {
            const row = topEl.createDiv({ cls: "ofc-tray-warning" });
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

        const todos = collectTrayTodos(plugin, (key) => seenOpenTodos.has(key));
        for (const todo of todos) {
            if (!todo.done) {
                seenOpenTodos.add(todoKey(todo.date, todo.title));
            }
        }
        // Every task note by linktext — a TODO line may point at a task
        // outside this week's sprint, and it still deserves its card.
        const allCardsByLink = new Map<string, Card>();
        for (const c of collectTaskCards(plugin)) {
            const link = linktextForEvent(plugin, c.id);
            if (link) {
                allCardsByLink.set(link, c);
            }
        }
        // Tasks already on today's list: their week cards drop the
        // "add to today" button.
        const todayLinks = new Set(
            todos
                .filter((t) => t.date === today)
                .map((t) => soleLinktext(t.title))
                .filter((l): l is string => !!l)
        );

        // `todo` set: the card stands for a line on today's list. Its
        // checkbox then ticks that line (done for today), not the task, and
        // it doesn't take part in the groups' reorder drag.
        const renderCard = (
            parent: HTMLElement,
            card: Card,
            linktext: string,
            todo?: TrayTodo
        ) => {
            const session = runningByLink.get(linktext);
            const done = todo ? todo.done : cardDone(card);
            if (!done && !todo) {
                seenUnfinished.add(linktext);
            }
            const cardEl = parent.createDiv({ cls: "ofc-tray-card" });
            if (todo) {
                cardEl.addClass("ofc-tray-card-today");
            }
            if (session) {
                cardEl.addClass("ofc-tray-card-running");
            }
            if (done) {
                cardEl.addClass("ofc-tray-card-done");
            }
            cardEl.dataset.linktext = linktext;
            if (!todo) {
                makeBodyDraggable(
                    cardEl,
                    el,
                    plugin,
                    card.id,
                    card.event.status
                );
            }

            // One colour, one meaning: the bar on the left says which
            // project. Status is what the group heading is for.
            if (card.sourceColor) {
                cardEl.style.setProperty("--ofc-row-color", card.sourceColor);
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
                await plugin.cache.processEvent(todo ? todo.id : card.id, (e) =>
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
            const due = cardDone(card) ? null : dueBadge(card.event.due);
            const metaEl = bodyEl.createDiv({ cls: "ofc-tray-card-meta" });
            // The project's name in words; its colour is already the bar.
            metaEl.createSpan({
                cls: "ofc-tray-card-project",
                text: projectLabel(card.calendarId),
            });
            if (parts.length > 0) {
                metaEl.createSpan({ text: ` · ${parts.join(" · ")}` });
            }
            if (due) {
                const dueEl = metaEl.createSpan({
                    cls: "ofc-tray-card-due",
                    text: ` · ${due.text}`,
                });
                if (due.urgent) {
                    dueEl.addClass("ofc-tray-card-due-urgent");
                }
            }
            if (todo && todo.date < today) {
                metaEl.createSpan({
                    cls: "ofc-tray-todo-date",
                    text: ` · ${shortDate(todo.date)}`,
                });
            }

            // One button per row, by where the row lives: on today's list
            // it starts (or stops) the clock; in the week it sends the task
            // to today — the drag does that too, but phones have no room to
            // drag far. Taking a task off today is the quiet × beside it.
            if (todo) {
                const off = cardEl.createEl("button", {
                    cls: "ofc-tray-card-btn ofc-tray-card-btn-quiet ofc-tray-card-btn-off",
                });
                setIcon(off, "x");
                off.setAttr("aria-label", "今日から外す");
                off.onclick = async (ev) => {
                    ev.stopPropagation();
                    await plugin.cache.deleteEvent(todo.id);
                };
            }
            if (todo || session) {
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
            } else if (!cardDone(card) && !todayLinks.has(linktext)) {
                const add = cardEl.createEl("button", {
                    cls: "ofc-tray-card-btn ofc-tray-card-btn-quiet",
                });
                setIcon(add, "calendar-plus");
                add.setAttr("aria-label", "今日に入れる");
                add.onclick = async (ev) => {
                    ev.stopPropagation();
                    await addTaskToToday(plugin, linktext);
                };
            }

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

        // --- 今日: the daily note's TODO lines, up to today. Rolling forward
        // is manual; forgotten ones stay visible here with their date.
        // Checked ones stay listed too (today's always; older ones for the
        // session). A line that is only a link to a task shows as its card.
        const todayEl = topEl.createDiv({ cls: "ofc-tray-today" });
        const todayHead = todayEl.createDiv({ cls: "ofc-tray-header" });
        todayHead.createSpan({ cls: "ofc-tray-today-title", text: "今日" });
        const todayTools = todayHead.createDiv({ cls: "ofc-tray-tools" });
        const openCount = todos.filter((t) => !t.done).length;
        if (opts.onPopOut) {
            const popBtn = todayTools.createEl("button", {
                cls: "ofc-tray-card-btn ofc-tray-card-btn-quiet",
            });
            setIcon(popBtn, "arrow-up-right");
            popBtn.setAttr("aria-label", "別のペインに出す");
            popBtn.onclick = (ev) => {
                ev.stopPropagation();
                opts.onPopOut?.();
            };
        }
        if (opts.onPopIn) {
            const backBtn = todayTools.createEl("button", {
                cls: "ofc-tray-card-btn ofc-tray-card-btn-quiet",
            });
            setIcon(backBtn, "arrow-down-left");
            backBtn.setAttr("aria-label", "カレンダーに戻す");
            backBtn.onclick = (ev) => {
                ev.stopPropagation();
                opts.onPopIn?.();
            };
        }
        if (todos.length > 0) {
            todayTools.createSpan({
                cls: "ofc-tray-count",
                text: `${todos.length - openCount} / ${todos.length}`,
            });
        }
        for (const todo of todos) {
            const link = soleLinktext(todo.title);
            const card = link ? allCardsByLink.get(link) : undefined;
            if (link && card) {
                renderCard(todayEl, card, link, todo);
                continue;
            }
            const row = todayEl.createDiv({ cls: "ofc-tray-todo" });
            if (todo.done) {
                row.addClass("ofc-tray-todo-done");
            }
            row.dataset.todoId = todo.id;
            row.dataset.todoTitle = todo.title;
            const check = row.createEl("input", {
                type: "checkbox",
                cls: "ofc-tray-todo-check",
            });
            check.checked = todo.done;
            check.setAttr(
                "aria-label",
                todo.done ? "Mark not done" : "Mark done"
            );
            check.onclick = async (ev) => {
                ev.stopPropagation();
                await plugin.cache.processEvent(todo.id, (e) =>
                    toggleTask(e, !todo.done)
                );
            };
            row.createDiv({
                cls: "ofc-tray-todo-body",
                text: plainTitle(todo.title),
            });
            if (todo.date < today) {
                row.createSpan({
                    cls: "ofc-tray-todo-date",
                    text: shortDate(todo.date),
                });
            }
            suppressDragClick(row, () => {
                launchEditModal(plugin, todo.id);
            });
        }
        if (todos.length === 0) {
            todayEl.createDiv({
                cls: "ofc-tray-empty",
                text: "今日やることを、今週のカードから入れる。",
            });
        }
        const firstOpen = todos.find((t) => !t.done);
        opts.onToday?.({
            open: openCount,
            first: firstOpen
                ? plainTitle(
                      (soleLinktext(firstOpen.title) &&
                          allCardsByLink.get(soleLinktext(firstOpen.title)!)
                              ?.event.title) ||
                          firstOpen.title
                  )
                : null,
        });

        weekEl.createDiv({
            cls: "ofc-tray-section",
            text: `今週 · ${weekOf(0)}`,
        });

        // --- Status groups: every stage in kanban order — INCLUDING empty
        // ones, so any stage is always available as a drag-and-drop target —
        // then any off-registry statuses so no card can hide. Within a
        // group, cards follow the manual order. Late stages start collapsed.
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
            const expanded =
                plugin.settings.trayExpanded?.[stage] ??
                !trayCollapsedByDefault(stage);
            const header = weekEl.createDiv({ cls: "ofc-tray-group" });
            header.dataset.stage = stage;
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
                const body = weekEl.createDiv({ cls: "ofc-tray-group-body" });
                body.dataset.stage = stage;
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
            weekEl.createDiv({
                cls: "ofc-tray-empty",
                text: "No unfinished tasks this sprint.",
            });
        }
    };
    refresh();
    return {
        refresh,
        destroy: () => {
            draggables.forEach((d) => d.destroy());
            memoPanel?.destroy();
        },
    };
}
