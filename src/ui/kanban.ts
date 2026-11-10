import { dueMeta, metaPart, renderRow, RowButton, timeLabel } from "./row";
import { addTaskToToday, collectTodayRows, soleLinktext } from "../core/today";
import { applyFx, elapsedPart, markFx, Tracker } from "./fx";
import { deleteWithUndo } from "./undo";
import { Card, collectTaskCards, projectLabel } from "../core/cards";
import {
    ItemView,
    Menu,
    Notice,
    Platform,
    setIcon,
    WorkspaceLeaf,
} from "obsidian";
import { DateTime } from "luxon";
import FullCalendarPlugin from "../main";
import { OFCEvent, PLUGIN_SLUG } from "../types";
import { UpdateViewCallback } from "../core/EventCache";
import { isDoneStatus, workflowStages } from "./colors";
import { openFileForEvent } from "./actions";
import {
    actualMinutesByLinktext,
    findRunningSessions,
    firstLinktext,
    linktextForEvent,
    RunningSession,
    stopSession,
} from "../core/worklog";
import { launchCreateModal, launchEditModal } from "./event_modal";
import { FULL_CALENDAR_VIEW_TYPE } from "./view";
import {
    dueBadge,
    formatHours,
    isWeekString,
    sprintBucket,
    weekOf,
    weekStartDate,
} from "./sprint";

export const FULL_CALENDAR_KANBAN_VIEW_TYPE = "full-calendar-kanban-view";

// How many weeks past the current one get a planning column on the sprint
// axis. Everything further out only appears if a card is already assigned
// to it.
const PLANNING_WEEKS_AHEAD = 3;

// The board's axis.
type GroupBy = "status" | "sprint";

/**
 * Set a workflow task's status — the single source of truth for done-ness.
 * Any legacy `completed` key is dropped rather than kept in sync. Shared by
 * the kanban's column drop and the tray's cross-group drag.
 */
export async function moveCardToStatus(
    plugin: FullCalendarPlugin,
    id: string,
    status: string
): Promise<void> {
    const current = plugin.cache.getEventById(id);
    if (
        !current ||
        current.type !== "single" ||
        (current.status ?? workflowStages()[0]) === status
    ) {
        return;
    }
    try {
        await plugin.cache.processEvent(id, (e) => {
            if (e.type !== "single") {
                return e;
            }
            const next: OFCEvent = { ...e, status, completed: null };
            return next;
        });
    } catch (e) {
        if (e instanceof Error) {
            console.error(e);
            new Notice(e.message);
        }
    }
}

type Column = {
    key: string;
    label: string;
    dotColor: string | null;
    cards: Card[];
    // null makes the column display-only (carry-over can't be a drop target:
    // assigning work into the past makes no sense).
    onDrop: ((cardId: string) => Promise<void>) | null;
    highlight?: boolean;
    // Total scheduled hours, shown next to the count on sprint columns.
    hoursLabel?: string | null;
    // Show each card's own week badge (used in carry-over, where the column
    // label doesn't tell you which week the card slipped from).
    showWeekBadge?: boolean;
    // Opens the create modal seeded for this column; columns without it
    // (carry-over, malformed sprint values) get no + button.
    onAdd?: (() => void) | null;
};

// The board shows single events that opted into the workflow (status set),
// plus tasks that haven't picked a stage yet — those surface in Backlog so
// they can be dragged onto the board without editing frontmatter by hand.
const cardStatus = (e: Card["event"]): string =>
    e.status ?? workflowStages()[0];

const cardDone = (e: Card["event"]): boolean => isDoneStatus(e.status);

/** A week as people say it: this one and the next by name, others as is. */
export const weekLabel = (week: string): string =>
    week === weekOf(0) ? "今週" : week === weekOf(1) ? "来週" : week;

export class KanbanView extends ItemView {
    plugin: FullCalendarPlugin;
    callback: UpdateViewCallback | null = null;
    toolbarEl: HTMLElement | null = null;
    boardEl: HTMLElement | null = null;
    // Guards against duplicate header actions if onOpen() ever re-runs on
    // the same view instance.
    calendarActionAdded = false;

    constructor(leaf: WorkspaceLeaf, plugin: FullCalendarPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getIcon(): string {
        return "columns";
    }

    getViewType(): string {
        return FULL_CALENDAR_KANBAN_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "kanban";
    }

    // What changed since the last draw, so the changed cards can answer
    // (docs/ux.md §3).
    private cardsSeen = new Tracker();
    private cardsDone = new Tracker();
    private runningSeen = new Tracker();
    // Refreshed once per render.
    private runningByLink: Map<string, RunningSession> = new Map();
    private todayLinks: Set<string> = new Set();

    private get filters() {
        return this.plugin.settings.kanbanFilters;
    }

    private get groupBy(): GroupBy {
        // "issue" is a legacy value from when the board had three flat tabs;
        // it now means scope=issue and says nothing about the Projects axis.
        return this.filters.groupBy === "sprint" ? "sprint" : "status";
    }

    private async setFilters(
        changes: Partial<typeof this.plugin.settings.kanbanFilters>
    ) {
        this.plugin.settings.kanbanFilters = { ...this.filters, ...changes };
        await this.plugin.saveKanbanFilters();
        this.render();
    }

    /** All cards on the board, before filters. */
    private collectCards(): Card[] {
        return collectTaskCards(this.plugin);
    }

    private applyFilters(cards: Card[]): Card[] {
        const { project, sprint, hideDone } = this.filters;
        // The sprint dropdown only applies on the status axis — on the sprint
        // axis the columns already partition by sprint.
        const applySprint = this.groupBy === "status";
        return cards.filter((c) => {
            // A saved filter may name a calendar that no longer exists (a
            // project renamed or archived); that filters nothing.
            if (
                project &&
                this.plugin.cache.calendars.has(project) &&
                c.calendarId !== project
            ) {
                return false;
            }
            if (hideDone && isDoneStatus(cardStatus(c.event))) {
                return false;
            }
            if (!applySprint) {
                return true;
            }
            if (sprint === "current") {
                return c.event.sprint === weekOf(0);
            } else if (sprint === "none") {
                return !c.event.sprint;
            } else if (sprint !== "all") {
                return c.event.sprint === sprint;
            }
            return true;
        });
    }

    private buildStatusColumns(cards: Card[]): Column[] {
        // Canonical column order for the status axis. Unknown statuses found
        // in events are appended after these so free-form stages still get a
        // column instead of vanishing.
        const statuses = workflowStages().filter(
            (s) => !(this.filters.hideDone && isDoneStatus(s))
        );
        for (const card of cards) {
            const status = cardStatus(card.event);
            if (!statuses.includes(status)) {
                statuses.push(status);
            }
        }
        return statuses.map((status) => ({
            key: status,
            label: status,
            // Status isn't painted (docs/ux.md §1).
            dotColor: null,
            cards: cards.filter((c) => cardStatus(c.event) === status),
            onDrop: (id: string) => this.moveCard(id, status),
            onAdd: () =>
                this.launchCreate({
                    status,
                }),
        }));
    }

    private buildSprintColumns(cards: Card[]): Column[] {
        const currentWeek = weekOf(0);
        const buckets = new Map<string, Card[]>();
        for (const card of cards) {
            const bucket = sprintBucket(
                card.event.sprint,
                cardDone(card.event),
                currentWeek
            );
            if (bucket === null) {
                continue; // finished work from past sprints — history, not planning
            }
            buckets.get(bucket)?.push(card) ?? buckets.set(bucket, [card]);
        }

        const windowWeeks = Array.from(
            { length: PLANNING_WEEKS_AHEAD + 1 },
            (_, i) => weekOf(i)
        );
        const columns: Column[] = [
            {
                key: "none",
                label: "週は未定",
                dotColor: null,
                cards: buckets.get("none") ?? [],
                onDrop: (id: string) => this.setSprint(id, null),
                onAdd: () => this.launchCreate({}),
            },
            {
                key: "carryover",
                label: "持ち越し",
                dotColor: "var(--ofc-late)",
                cards: buckets.get("carryover") ?? [],
                onDrop: null,
                showWeekBadge: true,
            },
            ...windowWeeks.map((week, i) => ({
                key: week,
                label:
                    i === 0
                        ? `今週（${week}）`
                        : i === 1
                        ? `来週（${week}）`
                        : week,
                dotColor: null,
                cards: buckets.get(week) ?? [],
                onDrop: (id: string) => this.setSprint(id, week),
                highlight: i === 0,
                // New tasks default to today within the current week, and to
                // the week's Monday for future weeks.
                onAdd: () =>
                    this.launchCreate({
                        sprint: week,
                        date:
                            i === 0
                                ? undefined
                                : weekStartDate(week) ?? undefined,
                    }),
            })),
        ];

        // Weeks beyond the planning window (and malformed sprint values) that
        // already have cards get their own trailing columns — never hide data.
        const known = new Set(columns.map((c) => c.key));
        const extras = [...buckets.keys()].filter((b) => !known.has(b)).sort();
        for (const bucket of extras) {
            columns.push({
                key: bucket,
                label: bucket,
                dotColor: null,
                cards: buckets.get(bucket) ?? [],
                onDrop: (id: string) => this.setSprint(id, bucket),
                // Only offer creation into real weeks — a + on a malformed
                // sprint column would just mint more malformed values.
                onAdd: isWeekString(bucket)
                    ? () =>
                          this.launchCreate({
                              sprint: bucket,
                              date: weekStartDate(bucket) ?? undefined,
                          })
                    : null,
            });
        }

        for (const column of columns) {
            if (column.key === "none") {
                continue;
            }
            // Planned load per sprint = sum of task estimates. (Tasks used to
            // carry startTime/endTime for this, but those fields moved to
            // work-log sessions.)
            const minutes = column.cards.reduce(
                (total, c) => total + (c.event.estimate ?? 0),
                0
            );
            // Spent against planned, like a card's own small print.
            const spent = column.cards.reduce((total, c) => {
                const link = linktextForEvent(this.plugin, c.id);
                return total + (link ? this.actuals.get(link) ?? 0 : 0);
            }, 0);
            column.hoursLabel =
                minutes > 0
                    ? `${formatHours(spent)} / ${formatHours(minutes)}`
                    : spent > 0
                    ? formatHours(spent)
                    : null;
        }
        return columns;
    }

    private renderToolbar(allCards: Card[]) {
        const toolbar = this.toolbarEl;
        if (!toolbar) {
            return;
        }
        toolbar.empty();
        const { project, sprint, hideDone } = this.filters;

        // Axis toggle: status columns (workflow) vs sprint
        // columns (planning).
        const toggle = toolbar.createDiv({ cls: "ofc-kanban-groupby" });
        const axes: [GroupBy, string][] = [
            ["status", "状態"],
            ["sprint", "週"],
        ];
        for (const [axis, label] of axes) {
            const button = toggle.createEl("button", { text: label });
            if (this.groupBy === axis) {
                button.addClass("ofc-kanban-groupby-active");
            }
            this.registerDomEvent(button, "click", () => {
                if (this.groupBy !== axis) {
                    this.setFilters({ groupBy: axis });
                }
            });
        }

        // Project filter: one entry per editable source that has cards.
        const projectIds = [...new Set(allCards.map((c) => c.calendarId))];
        const projectSelect = toolbar.createEl("select", { cls: "dropdown" });
        projectSelect.createEl("option", {
            value: "",
            text: "すべてのプロジェクト",
        });
        for (const id of projectIds) {
            projectSelect.createEl("option", {
                value: id,
                text: projectLabel(id),
            });
        }
        // A remembered project whose source no longer exists falls back to
        // "All projects" visually; picking anything else overwrites it.
        projectSelect.value =
            project && projectIds.includes(project) ? project : "";
        this.registerDomEvent(projectSelect, "change", () => {
            this.setFilters({ project: projectSelect.value || null });
        });

        // Sprint filter: only meaningful on the status axis — the sprint axis
        // already lays sprints out as columns.
        // Always there, so nothing after it shifts when the axis changes
        // (docs/ux.md §2); on the week axis it has nothing to say — the
        // columns already are the weeks — and is switched off.
        {
            const weeks = [
                ...new Set(
                    allCards
                        .map((c) => c.event.sprint)
                        .filter((s): s is string => !!s)
                ),
            ].sort((a, b) => b.localeCompare(a));
            const sprintSelect = toolbar.createEl("select", {
                cls: "dropdown",
            });
            sprintSelect.createEl("option", {
                value: "all",
                text: "すべての週",
            });
            sprintSelect.createEl("option", {
                value: "current",
                text: `今週（${weekOf(0)}）`,
            });
            sprintSelect.createEl("option", {
                value: "none",
                text: "週は未定",
            });
            for (const week of weeks) {
                sprintSelect.createEl("option", { value: week, text: week });
            }
            sprintSelect.value =
                sprint === "all" ||
                sprint === "current" ||
                sprint === "none" ||
                weeks.includes(sprint)
                    ? sprint
                    : "all";
            this.registerDomEvent(sprintSelect, "change", () => {
                this.setFilters({ sprint: sprintSelect.value });
            });
            sprintSelect.disabled = this.groupBy !== "status";
        }

        this.appendHideDone(toolbar);
    }

    private appendHideDone(toolbar: HTMLElement) {
        const hideDoneLabel = toolbar.createEl("label", {
            cls: "ofc-kanban-hide-done",
        });
        const hideDoneBox = hideDoneLabel.createEl("input", {
            type: "checkbox",
        });
        hideDoneBox.checked = this.filters.hideDone;
        hideDoneLabel.appendText(" Done を隠す");
        this.registerDomEvent(hideDoneBox, "change", () => {
            this.setFilters({ hideDone: hideDoneBox.checked });
        });
    }

    // Logged session minutes per task linktext, refreshed once per render.
    private actuals: Map<string, number> = new Map();

    private render() {
        const board = this.boardEl;
        if (!board) {
            return;
        }
        // A redraw must not throw the reader back to the top of a column.
        const scrolled = new Map<string, number>();
        board.findAll(".ofc-kanban-column").forEach((el) => {
            const body = el.querySelector(".ofc-kanban-cards");
            if (el.dataset.key && body) {
                scrolled.set(el.dataset.key, body.scrollTop);
            }
        });
        board.empty();

        this.actuals = actualMinutesByLinktext(this.plugin);
        const allCards = this.collectCards();
        this.renderToolbar(allCards);
        const cards = this.applyFilters(allCards);

        // The same states the tray shows (docs/ux.md §1): what is running,
        // and what is on today's list.
        const running = findRunningSessions(this.plugin);
        this.runningByLink = new Map();
        for (const r of running) {
            const link = firstLinktext(r.event.title);
            if (link) {
                this.runningByLink.set(link, r);
            }
        }
        const today = DateTime.now().toISODate();
        this.todayLinks = new Set(
            collectTodayRows(this.plugin)
                .filter((t) => t.date === today && !t.done)
                .map((t) => soleLinktext(t.title))
                .filter((l): l is string => !!l)
        );
        const runDiff = this.runningSeen.update(this.runningByLink.keys());
        for (const link of [...runDiff.added, ...runDiff.removed]) {
            markFx(`run:${link}`, "touch");
        }
        const linkOf = (c: Card) => linktextForEvent(this.plugin, c.id) ?? c.id;
        for (const key of this.cardsSeen.update(allCards.map(linkOf)).added) {
            markFx(`card:${key}`, "arrive");
        }
        for (const key of this.cardsDone.update(
            allCards.filter((c) => cardDone(c.event)).map(linkOf)
        ).added) {
            markFx(`card:${key}`, "done");
        }

        // This week's bar counts what the board is showing: with a project
        // picked, that project's week.
        const { project } = this.filters;
        this.renderWeekProgress(
            project && this.plugin.cache.calendars.has(project)
                ? allCards.filter((c) => c.calendarId === project)
                : allCards
        );

        const columns =
            this.groupBy === "sprint"
                ? this.buildSprintColumns(cards)
                : this.buildStatusColumns(cards);

        // Cap the toolbar at the same width as the column group so its left
        // edge lines up with the first column when the board is centered.
        this.toolbarEl?.style.setProperty(
            "--ofc-kanban-cols",
            `${columns.length}`
        );
        this.progressEl?.style.setProperty(
            "--ofc-kanban-cols",
            `${columns.length}`
        );

        for (const column of columns) {
            const columnEl = board.createDiv({ cls: "ofc-kanban-column" });
            columnEl.dataset.key = column.key;
            if (column.highlight) {
                columnEl.addClass("ofc-kanban-column-current");
            }
            if (!column.onDrop) {
                columnEl.addClass("ofc-kanban-column-nodrop");
            }

            const headerEl = columnEl.createDiv({
                cls: "ofc-kanban-column-header",
            });
            // Only "late" has a colour of its own.
            if (column.dotColor) {
                const dot = headerEl.createSpan({ cls: "ofc-kanban-dot" });
                dot.style.backgroundColor = column.dotColor;
            }
            headerEl.createSpan({
                cls: "ofc-kanban-column-title",
                text: column.label,
            });
            if (column.hoursLabel) {
                headerEl.createSpan({
                    cls: "ofc-kanban-hours",
                    text: column.hoursLabel,
                });
            }
            headerEl.createSpan({
                cls: "ofc-kanban-count",
                text: `${column.cards.length}`,
            });
            const onAdd = column.onAdd;
            if (onAdd) {
                const addButton = headerEl.createEl("button", {
                    cls: "clickable-icon ofc-kanban-add",
                    attr: { "aria-label": `${column.label} にタスクを作る` },
                });
                setIcon(addButton, "plus");
                this.registerDomEvent(addButton, "click", onAdd);
            }

            const bodyEl = columnEl.createDiv({ cls: "ofc-kanban-cards" });
            const onDrop = column.onDrop;
            if (onDrop) {
                // The whole column takes the drop — heading and empty space
                // included — and lights once, not once per card crossed.
                this.registerDomEvent(columnEl, "dragover", (ev) => {
                    ev.preventDefault();
                    columnEl.addClass("ofc-kanban-dragover");
                });
                this.registerDomEvent(columnEl, "dragleave", (ev) => {
                    if (!columnEl.contains(ev.relatedTarget as Node | null)) {
                        columnEl.removeClass("ofc-kanban-dragover");
                    }
                });
                this.registerDomEvent(columnEl, "drop", async (ev) => {
                    ev.preventDefault();
                    columnEl.removeClass("ofc-kanban-dragover");
                    const id = ev.dataTransfer?.getData("text/plain");
                    if (id) {
                        await onDrop(id);
                    }
                });
                this.dropTargets.set(columnEl, onDrop);
            }

            // Done from before this week is history: folded under one
            // line, so the column shows what was finished lately.
            const week = weekOf(0);
            const isOld = (c: Card) =>
                this.groupBy === "status" &&
                cardDone(c.event) &&
                !!c.event.sprint &&
                c.event.sprint < week;
            const old = column.cards.filter(isOld);
            for (const card of column.cards) {
                if (!isOld(card) || this.showOldDone) {
                    this.renderCard(bodyEl, card, column);
                }
            }
            if (old.length > 0) {
                const fold = bodyEl.createEl("button", {
                    cls: "ofc-kanban-fold",
                    text: this.showOldDone
                        ? "前の週の Done を畳む"
                        : `前の週の Done　${old.length}件`,
                });
                this.registerDomEvent(fold, "click", () => {
                    this.showOldDone = !this.showOldDone;
                    this.render();
                });
            }
            bodyEl.scrollTop = scrolled.get(column.key) ?? 0;
        }

        if (cards.length === 0) {
            board.createDiv({
                cls: "ofc-kanban-empty",
                text:
                    allCards.length === 0
                        ? "タスクはまだない。列の「＋」で作る。"
                        : "絞り込みに合うタスクはない。",
            });
        }
    }

    private renderCard(parent: HTMLElement, card: Card, column: Column) {
        const { id, event } = card;
        const done = cardDone(event);
        const linktext = linktextForEvent(this.plugin, id);
        const session = linktext ? this.runningByLink.get(linktext) : undefined;
        const onToday = !!linktext && this.todayLinks.has(linktext);
        // The same row as the tray's week card, with the same one button:
        // stop while its clock runs, otherwise "onto today" (docs/ux.md §2).
        const buttons: RowButton[] = [];
        if (session) {
            buttons.push({
                icon: "square",
                label: "止める",
                onClick: () => stopSession(this.plugin, session),
            });
        } else if (linktext && !done && !onToday) {
            buttons.push({
                icon: "calendar-plus",
                label: "今日に入れる",
                quiet: true,
                onClick: () => addTaskToToday(this.plugin, linktext),
            });
        }
        // The same row as the tray's. What differs is only the small print:
        // a column can't say everything the tray's headings do, so the card
        // names its project, and whichever of status / sprint the columns
        // aren't already grouped by.
        const { el: cardEl } = renderRow(parent, {
            cls: ["ofc-kanban-card"],
            title: event.title,
            color: card.sourceColor,
            done,
            running: !!session,
            buttons,
            meta: (metaEl) => {
                if (onToday) {
                    metaPart(metaEl, "今日", "ofc-row-today");
                }
                if (
                    session &&
                    session.event.type === "single" &&
                    !session.event.allDay
                ) {
                    elapsedPart(
                        metaEl,
                        `${session.event.date}T${session.event.startTime}`
                    );
                }
                metaPart(metaEl, projectLabel(card.calendarId));
                if (this.groupBy === "sprint") {
                    metaPart(metaEl, cardStatus(event));
                    // In carry-over: which week the card slipped from.
                    if (column.showWeekBadge && event.sprint) {
                        metaPart(metaEl, event.sprint);
                    }
                } else if (event.sprint) {
                    metaPart(metaEl, weekLabel(event.sprint)).toggleClass(
                        "ofc-row-current",
                        event.sprint === weekOf(0)
                    );
                }
                // Logged time from work-log sessions vs. the estimate.
                const time = timeLabel(
                    linktext ? this.actuals.get(linktext) ?? 0 : 0,
                    event.estimate ?? 0
                );
                if (time) {
                    metaPart(metaEl, time);
                }
                // Tasks' own `date` is retired; the date worth showing is
                // the deadline.
                dueMeta(metaEl, done ? null : dueBadge(event.due));
            },
        });
        const fxKey = linktext ?? id;
        applyFx(cardEl, `card:${fxKey}`);
        applyFx(cardEl, `run:${fxKey}`);

        if (Platform.isMobile) {
            // The browser's own drag doesn't exist for fingers.
            this.makeTouchDraggable(cardEl, id);
        } else {
            cardEl.setAttr("draggable", "true");
            this.registerDomEvent(cardEl, "dragstart", (ev) => {
                ev.dataTransfer?.setData("text/plain", id);
                ev.dataTransfer!.effectAllowed = "move";
                cardEl.addClass("ofc-kanban-dragging");
                // While a card is held, columns that can't take it step back.
                this.boardEl?.addClass("ofc-kanban-holding");
            });
            this.registerDomEvent(cardEl, "dragend", () => {
                cardEl.removeClass("ofc-kanban-dragging");
                this.boardEl?.removeClass("ofc-kanban-holding");
                this.boardEl
                    ?.findAll(".ofc-kanban-dragover")
                    .forEach((el) => el.removeClass("ofc-kanban-dragover"));
            });
        }

        this.registerDomEvent(cardEl, "click", async (ev) => {
            if (Date.now() < this.suppressClickUntil) {
                return;
            }
            try {
                if (
                    ev.getModifierState("Control") ||
                    ev.getModifierState("Meta")
                ) {
                    await openFileForEvent(this.plugin.cache, this.app, id);
                } else {
                    launchEditModal(this.plugin, id);
                }
            } catch (e) {
                if (e instanceof Error) {
                    console.warn(e);
                    new Notice(e.message);
                }
            }
        });

        this.registerDomEvent(cardEl, "mouseenter", (ev) => {
            try {
                const location =
                    this.plugin.cache.getInfoForEditableEvent(id).location;
                if (location) {
                    this.app.workspace.trigger("hover-link", {
                        event: ev,
                        source: PLUGIN_SLUG,
                        hoverParent: cardEl,
                        targetEl: cardEl,
                        linktext: location.path,
                        sourcePath: location.path,
                    });
                }
            } catch (e) {}
        });

        this.registerDomEvent(cardEl, "contextmenu", (ev) => {
            const menu = new Menu();
            {
                const week = weekOf(0);
                if (event.sprint !== week) {
                    menu.addItem((item) =>
                        item
                            .setTitle("今週に入れる")
                            .onClick(() => this.setSprint(id, week))
                    );
                }
                if (event.sprint) {
                    menu.addItem((item) =>
                        item
                            .setTitle("週から外す")
                            .onClick(() => this.setSprint(id, null))
                    );
                }
                menu.addSeparator();
            }
            // Seen on the board, decided for today: onto today's list
            // without going back to the tray. (Issues aren't things to do
            // today; tasks are.)
            if (linktext && !done && !onToday) {
                menu.addItem((item) =>
                    item
                        .setTitle("今日に入れる")
                        .setIcon("calendar-plus")
                        .onClick(() => addTaskToToday(this.plugin, linktext))
                );
                menu.addSeparator();
            }
            menu.addItem((item) =>
                item
                    .setTitle("ノートを開く")
                    .setIcon("file-text")
                    .onClick(() => {
                        openFileForEvent(this.plugin.cache, this.app, id);
                    })
            );
            menu.addItem((item) =>
                item
                    .setTitle("消す")
                    .setIcon("trash-2")
                    .onClick(() =>
                        deleteWithUndo(
                            this.plugin,
                            id,
                            `「${event.title}」を消しました。`
                        )
                    )
            );
            menu.showAtMouseEvent(ev);
        });
    }

    // Columns that take a drop, for the touch drag to find under a finger.
    private dropTargets = new WeakMap<
        HTMLElement,
        (cardId: string) => Promise<void>
    >();

    /**
     * Moving a card with a finger: hold to lift, then a copy follows the
     * finger and the column under it lights, exactly as with the mouse.
     */
    private makeTouchDraggable(cardEl: HTMLElement, id: string) {
        this.registerDomEvent(cardEl, "pointerdown", (down) => {
            const board = this.boardEl;
            if (!board || (down.target as HTMLElement).closest("button")) {
                return;
            }
            let ghost: HTMLElement | null = null;
            let over: HTMLElement | null = null;
            const lift = window.setTimeout(() => {
                const r = cardEl.getBoundingClientRect();
                ghost = cardEl.cloneNode(true) as HTMLElement;
                ghost.addClass("ofc-kanban-ghost");
                ghost.style.width = `${r.width}px`;
                ghost.style.left = `${r.left}px`;
                ghost.style.top = `${r.top}px`;
                document.body.appendChild(ghost);
                cardEl.addClass("ofc-kanban-dragging");
                board.addClass("ofc-kanban-holding");
            }, 350);
            const columnAt = (x: number, y: number) =>
                (document
                    .elementsFromPoint(x, y)
                    .find(
                        (el) =>
                            el instanceof HTMLElement &&
                            this.dropTargets.has(el)
                    ) as HTMLElement | undefined) ?? null;
            const onMove = (ev: PointerEvent) => {
                if (!ghost) {
                    // Moved before the hold: that is a scroll, not a drag.
                    if (
                        Math.abs(ev.clientX - down.clientX) > 5 ||
                        Math.abs(ev.clientY - down.clientY) > 5
                    ) {
                        end();
                    }
                    return;
                }
                ghost.style.transform = `translate(${
                    ev.clientX - down.clientX
                }px, ${ev.clientY - down.clientY}px)`;
                const next = columnAt(ev.clientX, ev.clientY);
                if (next !== over) {
                    over?.removeClass("ofc-kanban-dragover");
                    next?.addClass("ofc-kanban-dragover");
                    over = next;
                }
            };
            const onTouchMove = (ev: TouchEvent) => {
                if (ghost) {
                    ev.preventDefault();
                }
            };
            const end = () => {
                window.clearTimeout(lift);
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                document.removeEventListener("pointercancel", end);
                cardEl.removeEventListener("touchmove", onTouchMove);
                ghost?.remove();
                ghost = null;
                over?.removeClass("ofc-kanban-dragover");
                cardEl.removeClass("ofc-kanban-dragging");
                board.removeClass("ofc-kanban-holding");
            };
            const onUp = async () => {
                const onDrop =
                    ghost && over ? this.dropTargets.get(over) : undefined;
                const lifted = !!ghost;
                end();
                if (lifted) {
                    // The lift was a drag; don't let it open the card too.
                    this.suppressClickUntil = Date.now() + 400;
                }
                if (onDrop) {
                    await onDrop(id);
                }
            };
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
            document.addEventListener("pointercancel", end);
            cardEl.addEventListener("touchmove", onTouchMove, {
                passive: false,
            });
        });
    }
    private suppressClickUntil = 0;

    /**
     * This week's progress, the same thin bar as the tray's "今日": tasks of
     * this week that are Done, out of all of this week's tasks.
     */
    private renderWeekProgress(allCards: Card[]) {
        this.progressEl?.empty();
        if (!this.progressEl) {
            return;
        }
        const week = weekOf(0);
        const mine = allCards.filter((c) => c.event.sprint === week);
        if (mine.length === 0) {
            return;
        }
        const done = mine.filter((c) => cardDone(c.event)).length;
        const ratio = done / mine.length;
        const head = this.progressEl.createDiv({ cls: "ofc-kanban-progress" });
        head.createSpan({ text: "今週" });
        const count = head.createSpan({
            cls: "ofc-tray-count",
            text: `${done} / ${mine.length}`,
        });
        count.toggleClass("ofc-tray-count-full", done === mine.length);
        const bar = this.progressEl.createDiv({ cls: "ofc-tray-progress" });
        const fill = bar.createDiv({ cls: "ofc-tray-progress-fill" });
        // Opening the board is not an event: the first draw just shows the
        // bar; later ones grow it from where it stood.
        if (this.ratioShown === null || this.ratioShown === ratio) {
            fill.style.width = `${ratio * 100}%`;
        } else {
            fill.style.width = `${this.ratioShown * 100}%`;
            window.requestAnimationFrame(() => {
                fill.style.width = `${ratio * 100}%`;
            });
        }
        this.ratioShown = ratio;
    }
    private progressEl: HTMLElement | null = null;
    // Whether Done cards from past weeks are unfolded. Not saved: the board
    // opens with them folded.
    private showOldDone = false;
    private ratioShown: number | null = null;

    /**
     * Open the create modal seeded for a column. New cards default to an
     * all-day task dated today; an active project filter preselects that
     * calendar as the destination.
     */
    private launchCreate(seed: {
        status?: string;
        sprint?: string;
        date?: string;
        completed?: boolean;
    }) {
        launchCreateModal(
            this.plugin,
            {
                type: "single",
                allDay: true,
                date: seed.date ?? DateTime.now().toISODate() ?? undefined,
                completed: seed.completed ?? false,
                status: seed.status,
                sprint: seed.sprint,
            },
            this.filters.project ?? undefined
        );
    }

    /**
     * Assign a card to a sprint week, or remove it with `null` — null is the
     * frontmatter deletion marker understood by modifyFrontmatterString.
     */
    private async setSprint(id: string, sprint: string | null) {
        const current = this.plugin.cache.getEventById(id);
        if (
            !current ||
            current.type !== "single" ||
            (current.sprint ?? null) === sprint
        ) {
            return;
        }
        try {
            await this.plugin.cache.processEvent(id, (e) =>
                e.type === "single" ? { ...e, sprint } : e
            );
        } catch (e) {
            if (e instanceof Error) {
                console.error(e);
                new Notice(e.message);
            }
        }
    }

    private async moveCard(id: string, status: string) {
        await moveCardToStatus(this.plugin, id, status);
    }

    async onOpen() {
        await this.plugin.loadSettings();
        if (!this.plugin.cache) {
            new Notice("カレンダーの読み込みが終わっていません。");
            return;
        }
        if (!this.plugin.cache.initialized) {
            // Same startup guard as the calendar view: only populate once
            // the vault index is ready — and never AWAIT layout-ready inside
            // onOpen(), which deadlocks mobile's workspace load.
            if (!this.app.workspace.layoutReady) {
                this.app.workspace.onLayoutReady(() => this.onOpen());
                return;
            }
            await this.plugin.cache.populate();
        }

        if (!this.calendarActionAdded) {
            this.calendarActionAdded = true;
            // Mirror of the calendar view's header action: swap this tab
            // back to the calendar in place.
            this.addAction("calendar-glyph", "カレンダーに切り替える", () => {
                this.leaf.setViewState({
                    type: FULL_CALENDAR_VIEW_TYPE,
                    active: true,
                });
            });
        }

        const container = this.containerEl.children[1];
        container.empty();
        const wrapper = container.createDiv({ cls: "ofc-kanban" });
        this.toolbarEl = wrapper.createDiv({ cls: "ofc-kanban-toolbar" });
        this.progressEl = wrapper.createDiv({ cls: "ofc-kanban-progress-row" });
        // The board opens on this week, like the tray beside the calendar.
        // Looking further is a choice made while it is open.
        this.plugin.settings.kanbanFilters = {
            ...this.filters,
            sprint: "current",
        };
        this.boardEl = wrapper.createDiv({ cls: "ofc-kanban-board" });
        this.render();

        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
        // Every update payload can change card membership or ordering, and the
        // board is tiny compared to the calendar, so just rebuild wholesale.
        this.callback = this.plugin.cache.on("update", () => {
            this.render();
        });
    }

    async onunload() {
        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
    }
}
