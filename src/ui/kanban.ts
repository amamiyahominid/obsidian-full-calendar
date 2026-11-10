import { dueMeta, metaPart, renderRow, timeLabel } from "./row";
import {
    Card,
    collectIssueCards,
    collectTaskCards,
    projectLabel,
} from "../core/cards";
import { ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { DateTime } from "luxon";
import FullCalendarPlugin from "../main";
import { OFCEvent, PLUGIN_SLUG } from "../types";
import { UpdateViewCallback } from "../core/EventCache";
import { getStatusColor, isDoneStatus, workflowStages } from "./colors";
import { openFileForEvent } from "./actions";
import { actualMinutesByLinktext, linktextForEvent } from "../core/worklog";
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

// Top-level board tab: the issues folder or project tasks.
type BoardScope = "issue" | "projects";
// Axis within the Projects tab.
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

// Projects an issue is tied to, from its `project:` frontmatter. Tasks take
// their project from the folder they live in, so this is issues-only.
const cardProjects = (e: Card["event"]): string[] => e.project ?? [];

// Sentinel for the Issues project dropdown: show only issues that aren't on
// any project — questions with no year-scale container to answer them.
const NO_PROJECT = "__none__";

/**
 * The colour a project reads as everywhere: its own calendar source's.
 * Tasks already carry it on the card (`sourceColor`), but an issue names its
 * project in frontmatter and has to look it up, so that one project is one
 * colour on every surface.
 */
export const projectColor = (
    plugin: FullCalendarPlugin,
    name: string
): string | null => {
    for (const source of plugin.cache.getAllEvents()) {
        if (projectLabel(source.id) === name) {
            return source.color ?? null;
        }
    }
    return null;
};

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
        return "Kanban";
    }

    private get filters() {
        return this.plugin.settings.kanbanFilters;
    }

    private get groupBy(): GroupBy {
        // "issue" is a legacy value from when the board had three flat tabs;
        // it now means scope=issue and says nothing about the Projects axis.
        return this.filters.groupBy === "sprint" ? "sprint" : "status";
    }

    /**
     * NEVER name this `scope`. Obsidian's workspace scope delegates every
     * keystroke to `activeLeaf.view.scope` and calls `handleKey()` on it, so
     * a `View.scope` holding anything but an obsidian `Scope` throws inside
     * the global keydown handler — killing EVERY hotkey (Cmd+T, Cmd+P, ...)
     * while this view is active.
     */
    private get boardScope(): BoardScope {
        // No issues folder — the Issues tab doesn't exist to be selected.
        if (this.plugin.issuesSourceId() === null) {
            return "projects";
        }
        if (this.filters.scope) {
            return this.filters.scope;
        }
        return this.filters.groupBy === "issue" ? "issue" : "projects";
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
        return this.boardScope === "issue"
            ? collectIssueCards(this.plugin)
            : collectTaskCards(this.plugin);
    }

    private applyFilters(cards: Card[]): Card[] {
        const { project, sprint, hideDone } = this.filters;
        // Issues have no sprint, and their project comes from frontmatter
        // rather than from the folder they live in — one issue can feed
        // several projects, or none.
        if (this.boardScope === "issue") {
            const issueProject = this.filters.issueProject ?? null;
            return cards.filter((c) => {
                if (hideDone && isDoneStatus(cardStatus(c.event))) {
                    return false;
                }
                const projects = cardProjects(c.event);
                if (issueProject === NO_PROJECT) {
                    return projects.length === 0;
                }
                return !issueProject || projects.includes(issueProject);
            });
        }
        // The sprint dropdown only applies on the status axis — on the sprint
        // axis the columns already partition by sprint.
        const applySprint = this.groupBy === "status";
        return cards.filter((c) => {
            if (project && c.calendarId !== project) {
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
            dotColor: getStatusColor(status) ?? null,
            cards: cards.filter((c) => cardStatus(c.event) === status),
            onDrop: (id: string) => this.moveCard(id, status),
            onAdd: () =>
                this.launchCreate({
                    status,
                }),
        }));
    }

    /**
     * Columns for the Issue axis: the same full stage set as the status
     * axis. Only the + button is dropped — issues are born from their
     * template note, not from the create-event modal.
     */
    private buildIssueColumns(cards: Card[]): Column[] {
        return this.buildStatusColumns(cards).map((column) => ({
            ...column,
            onAdd: null,
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
                label: "No sprint",
                dotColor: null,
                cards: buckets.get("none") ?? [],
                onDrop: (id: string) => this.setSprint(id, null),
                onAdd: () => this.launchCreate({}),
            },
            {
                key: "carryover",
                label: "Carry-over",
                dotColor: "var(--text-error)",
                cards: buckets.get("carryover") ?? [],
                onDrop: null,
                showWeekBadge: true,
            },
            ...windowWeeks.map((week, i) => ({
                key: week,
                label: i === 0 ? `${week} · this week` : week,
                dotColor: i === 0 ? "var(--interactive-accent)" : null,
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
            column.hoursLabel = minutes > 0 ? formatHours(minutes) : null;
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

        // Top-level tabs: the issues folder vs project tasks. Only offered
        // when an issues folder is configured — otherwise the board is
        // projects-only and the tab row would be a single button.
        if (this.plugin.issuesSourceId() !== null) {
            const scopeToggle = toolbar.createDiv({
                cls: "ofc-kanban-groupby",
            });
            const scopes: [BoardScope, string][] = [
                ["issue", "Issues"],
                ["projects", "Projects"],
            ];
            for (const [scope, label] of scopes) {
                const button = scopeToggle.createEl("button", { text: label });
                if (this.boardScope === scope) {
                    button.addClass("ofc-kanban-groupby-active");
                }
                this.registerDomEvent(button, "click", () => {
                    if (this.boardScope !== scope) {
                        // Writing groupBy too normalizes the legacy "issue"
                        // axis value out of saved filters.
                        this.setFilters({ scope, groupBy: this.groupBy });
                    }
                });
            }
        }

        // Issues all live in one folder, so the source-based project filter
        // below can't tell them apart; they filter by their `project:`
        // frontmatter instead. Sprint stays meaningless here.
        if (this.boardScope === "issue") {
            const names = [
                ...new Set(allCards.flatMap((c) => cardProjects(c.event))),
            ].sort();
            const select = toolbar.createEl("select", { cls: "dropdown" });
            select.createEl("option", { value: "", text: "All projects" });
            select.createEl("option", {
                value: NO_PROJECT,
                text: "No project",
            });
            for (const name of names) {
                select.createEl("option", { value: name, text: name });
            }
            // A remembered project that no issue names any more falls back to
            // "All projects" visually; picking anything else overwrites it.
            const current = this.filters.issueProject ?? "";
            select.value =
                current === NO_PROJECT || names.includes(current)
                    ? current
                    : "";
            this.registerDomEvent(select, "change", () => {
                this.setFilters({ issueProject: select.value || null });
            });
            this.appendHideDone(toolbar);
            return;
        }

        // Axis toggle within Projects: status columns (workflow) vs sprint
        // columns (planning).
        const toggle = toolbar.createDiv({ cls: "ofc-kanban-groupby" });
        const axes: [GroupBy, string][] = [
            ["status", "Status"],
            ["sprint", "Sprint"],
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
            text: "All projects",
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
        if (this.groupBy === "status") {
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
                text: "All sprints",
            });
            sprintSelect.createEl("option", {
                value: "current",
                text: `Current sprint (${weekOf(0)})`,
            });
            sprintSelect.createEl("option", {
                value: "none",
                text: "No sprint",
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
        hideDoneLabel.appendText(" Hide Done");
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
        board.empty();

        this.actuals = actualMinutesByLinktext(this.plugin);
        const allCards = this.collectCards();
        this.renderToolbar(allCards);
        const cards = this.applyFilters(allCards);

        const columns =
            this.boardScope === "issue"
                ? this.buildIssueColumns(cards)
                : this.groupBy === "sprint"
                ? this.buildSprintColumns(cards)
                : this.buildStatusColumns(cards);

        // Cap the toolbar at the same width as the column group so its left
        // edge lines up with the first column when the board is centered.
        this.toolbarEl?.style.setProperty(
            "--ofc-kanban-cols",
            `${columns.length}`
        );

        for (const column of columns) {
            const columnEl = board.createDiv({ cls: "ofc-kanban-column" });
            if (column.highlight) {
                columnEl.addClass("ofc-kanban-column-current");
            }
            if (!column.onDrop) {
                columnEl.addClass("ofc-kanban-column-nodrop");
            }

            const headerEl = columnEl.createDiv({
                cls: "ofc-kanban-column-header",
            });
            const dot = headerEl.createSpan({ cls: "ofc-kanban-dot" });
            dot.style.backgroundColor = column.dotColor ?? "var(--text-muted)";
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
                    attr: { "aria-label": `New task in ${column.label}` },
                });
                setIcon(addButton, "plus");
                this.registerDomEvent(addButton, "click", onAdd);
            }

            const bodyEl = columnEl.createDiv({ cls: "ofc-kanban-cards" });
            const onDrop = column.onDrop;
            if (onDrop) {
                this.registerDomEvent(bodyEl, "dragover", (ev) => {
                    ev.preventDefault();
                    columnEl.addClass("ofc-kanban-dragover");
                });
                this.registerDomEvent(bodyEl, "dragleave", () => {
                    columnEl.removeClass("ofc-kanban-dragover");
                });
                this.registerDomEvent(bodyEl, "drop", async (ev) => {
                    ev.preventDefault();
                    columnEl.removeClass("ofc-kanban-dragover");
                    const id = ev.dataTransfer?.getData("text/plain");
                    if (id) {
                        await onDrop(id);
                    }
                });
            }

            for (const card of column.cards) {
                this.renderCard(bodyEl, card, column);
            }
        }

        if (cards.length === 0) {
            board.createDiv({
                cls: "ofc-kanban-empty",
                text:
                    this.boardScope === "issue"
                        ? allCards.length === 0
                            ? "No issues yet. Notes in the issues folder with a status will show up here."
                            : "No issues match the current filters."
                        : allCards.length === 0
                        ? "No tasks yet. Give an event a status (or a checkbox) and it will show up here."
                        : "No tasks match the current filters.",
            });
        }
    }

    private renderCard(parent: HTMLElement, card: Card, column: Column) {
        const { id, event } = card;
        const done = cardDone(event);
        const linktext = linktextForEvent(this.plugin, id);
        const issue = this.boardScope === "issue";
        // The same row as the tray's. What differs is only the small print:
        // a column can't say everything the tray's headings do, so the card
        // names its project, and whichever of status / sprint the columns
        // aren't already grouped by.
        const { el: cardEl } = renderRow(parent, {
            cls: ["ofc-kanban-card"],
            title: event.title,
            // An issue can sit on several projects; its bar takes the first.
            color: issue
                ? projectColor(this.plugin, cardProjects(event)[0] ?? "")
                : card.sourceColor,
            done,
            meta: (metaEl) => {
                const projects = issue
                    ? cardProjects(event)
                    : [projectLabel(card.calendarId)];
                if (projects.length > 0) {
                    metaPart(metaEl, projects.join("、"));
                }
                if (!issue && this.groupBy === "sprint") {
                    metaPart(metaEl, cardStatus(event));
                    // In carry-over: which week the card slipped from.
                    if (column.showWeekBadge && event.sprint) {
                        metaPart(metaEl, event.sprint);
                    }
                } else if (event.sprint) {
                    metaPart(metaEl, event.sprint).toggleClass(
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
        cardEl.setAttr("draggable", "true");

        this.registerDomEvent(cardEl, "dragstart", (ev) => {
            ev.dataTransfer?.setData("text/plain", id);
            ev.dataTransfer!.effectAllowed = "move";
            cardEl.addClass("ofc-kanban-dragging");
        });
        this.registerDomEvent(cardEl, "dragend", () => {
            cardEl.removeClass("ofc-kanban-dragging");
            this.boardEl
                ?.findAll(".ofc-kanban-dragover")
                .forEach((el) => el.removeClass("ofc-kanban-dragover"));
        });

        this.registerDomEvent(cardEl, "click", async (ev) => {
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
            // Issues stay out of sprint planning, so no sprint items there.
            if (this.boardScope !== "issue") {
                const week = weekOf(0);
                if (event.sprint !== week) {
                    menu.addItem((item) =>
                        item
                            .setTitle(`Assign to current sprint (${week})`)
                            .onClick(() => this.setSprint(id, week))
                    );
                }
                if (event.sprint) {
                    menu.addItem((item) =>
                        item
                            .setTitle("Remove from sprint")
                            .onClick(() => this.setSprint(id, null))
                    );
                }
                menu.addSeparator();
            }
            menu.addItem((item) =>
                item.setTitle("Go to note").onClick(() => {
                    openFileForEvent(this.plugin.cache, this.app, id);
                })
            );
            menu.addItem((item) =>
                item.setTitle("Delete").onClick(async () => {
                    await this.plugin.cache.deleteEvent(id);
                    new Notice(`Deleted event "${event.title}".`);
                })
            );
            menu.showAtMouseEvent(ev);
        });
    }

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
            new Notice("Full Calendar event cache not loaded.");
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
            this.addAction("calendar-glyph", "Switch to Calendar", () => {
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
