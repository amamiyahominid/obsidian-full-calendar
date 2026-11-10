import "./overrides.css";
import { ItemView, Menu, Notice, Platform, WorkspaceLeaf } from "obsidian";
import { DateTime } from "luxon";
import {
    Calendar,
    EventApi,
    EventInput,
    EventSourceInput,
} from "@fullcalendar/core";
import { deleteWithUndo } from "./undo";
import { confirmPlanFor } from "./planActions";
import { dailyFile, todayISO } from "../core/dailyService";
import { plainTitle, sessionOfRow, TodayRow } from "../core/today";
import { renderCalendar } from "./calendar";
import FullCalendarPlugin from "../main";
import { FCError, OFCEvent, PLUGIN_SLUG } from "../types";
import { fromEventApi, toEventInput } from "./interop";
import { renderOnboarding } from "./onboard";
import { openFileForEvent, openFileInLeaf, resolveLinkedNote } from "./actions";
import { launchEditModal } from "./event_modal";
import { toggleTask } from "src/ui/tasks";
import { UpdateViewCallback } from "src/core/EventCache";
import {
    createSession,
    findRunningSessions,
    firstLinktext,
    getPlanCalendarId,
    getWorklogCalendarId,
    linktextForEvent,
    startSessionFromBlock,
    stopSession,
} from "src/core/worklog";
import { renderTaskTray, TaskTray } from "./tray";
import { MemoPanel, renderMemoPanel } from "./memoPanel";
import {
    FULL_CALENDAR_MEMO_VIEW_TYPE,
    FULL_CALENDAR_TRAY_VIEW_TYPE,
} from "./panes";
import { pickTrayTask } from "./taskPicker";
import { FULL_CALENDAR_KANBAN_VIEW_TYPE } from "./kanban";
import { collectTaskCards } from "../core/cards";

export const FULL_CALENDAR_VIEW_TYPE = "full-calendar-view";
export const FULL_CALENDAR_SIDEBAR_VIEW_TYPE = "full-calendar-sidebar-view";

// Workflow tasks (status-bearing notes) stay off the calendar entirely: the
// tray/kanban own them, and the calendar shows their work sessions instead.
// Rendering them would duplicate the tray AND make a drag rewrite the task's
// `date` — the old timeblocking behavior sessions replaced.
const isWorkflowTask = (event: OFCEvent) =>
    event.type === "single" && event.status !== undefined;

// What a session block should look like: its linked task's colors.
type TaskLook = { sourceColor: string | null | undefined; status?: string };

function getCalendarColors(color: string | null | undefined): {
    color: string;
    textColor: string;
} {
    let textVar = getComputedStyle(document.body).getPropertyValue(
        "--text-on-accent"
    );
    if (color) {
        const m = color
            .slice(1)
            .match(color.length == 7 ? /(\S{2})/g : /(\S{1})/g);
        if (m) {
            const r = parseInt(m[0], 16),
                g = parseInt(m[1], 16),
                b = parseInt(m[2], 16);
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            if (brightness > 150) {
                textVar = "black";
            }
        }
    }

    return {
        color:
            color ||
            getComputedStyle(document.body).getPropertyValue(
                "--interactive-accent"
            ),
        textColor: textVar,
    };
}

export class CalendarView extends ItemView {
    plugin: FullCalendarPlugin;
    inSidebar: boolean;
    fullCalendarView: Calendar | null = null;
    callback: UpdateViewCallback | null = null;
    taskTray: TaskTray | null = null;
    // Desktop: the memo column on the calendar's right. (On mobile the
    // memo lives inside the tray list instead.)
    memoPanel: MemoPanel | null = null;
    // The built-in columns (each with its divider). Hidden while the same
    // thing is open as a pane of its own somewhere in the workspace.
    private trayColumn: HTMLElement[] = [];
    private memoColumn: HTMLElement[] = [];
    private layoutWatchAdded = false;

    /** Show each built-in column only while no standalone pane of its kind
     * exists. Desktop only: mobile keeps its own calendar/list toggle. */
    syncPoppedPanels() {
        if (Platform.isMobile) {
            return;
        }
        const popped = (type: string) =>
            this.app.workspace.getLeavesOfType(type).length > 0;
        let changed = false;
        const apply = (els: HTMLElement[], hide: boolean) => {
            for (const el of els) {
                if (el.hasClass("is-popped") !== hide) {
                    el.toggleClass("is-popped", hide);
                    changed = true;
                }
            }
        };
        apply(this.trayColumn, popped(FULL_CALENDAR_TRAY_VIEW_TYPE));
        apply(this.memoColumn, popped(FULL_CALENDAR_MEMO_VIEW_TYPE));
        if (changed) {
            this.fullCalendarView?.updateSize();
        }
    }
    // Mobile-only: the header action toggles between the calendar and the
    // task list; these track the current elements across onOpen() re-runs.
    mobileTrayEl: HTMLElement | null = null;
    mobileCalendarEl: HTMLElement | null = null;
    // Mobile-only: one line above the calendar saying what's left on
    // today's list; tapping it opens the list.
    mobileTodayBarEl: HTMLElement | null = null;
    toggleMobileTray: (() => void) | null = null;
    trayActionAdded = false;
    // onOpen() re-runs on the same view instance (e.g. activateView() calls it
    // on existing leaves), but the header action must only be added once.
    kanbanActionAdded = false;
    growIntervalAdded = false;

    constructor(
        leaf: WorkspaceLeaf,
        plugin: FullCalendarPlugin,
        inSidebar = false
    ) {
        super(leaf);
        this.plugin = plugin;
        this.inSidebar = inSidebar;
    }

    getIcon(): string {
        return "calendar-glyph";
    }

    getViewType() {
        return this.inSidebar
            ? FULL_CALENDAR_SIDEBAR_VIEW_TYPE
            : FULL_CALENDAR_VIEW_TYPE;
    }

    getDisplayText() {
        return "カレンダー";
    }

    /**
     * A draggable divider that resizes the task tray. The width persists to
     * settings (light save — no cache reset) so it survives restarts.
     */
    private setupTrayResizer(
        layoutEl: HTMLElement,
        trayEl: HTMLElement
    ): HTMLElement {
        const resizerEl = layoutEl.createDiv({ cls: "ofc-tray-resizer" });
        this.registerDomEvent(resizerEl, "mousedown", (e: MouseEvent) => {
            e.preventDefault();
            resizerEl.addClass("is-dragging");
            const startX = e.clientX;
            const startWidth = trayEl.getBoundingClientRect().width;
            const onMove = (ev: MouseEvent) => {
                const width = Math.max(
                    140,
                    Math.min(480, startWidth + ev.clientX - startX)
                );
                trayEl.style.width = `${width}px`;
                this.fullCalendarView?.updateSize();
            };
            const onUp = async () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                resizerEl.removeClass("is-dragging");
                this.plugin.settings.trayWidth = Math.round(
                    trayEl.getBoundingClientRect().width
                );
                await this.plugin.saveTrayWidth();
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
        return resizerEl;
    }

    /** The memo column's divider: it sits on the column's LEFT edge, so
     * dragging left widens it. */
    private setupMemoResizer(
        layoutEl: HTMLElement,
        memoEl: HTMLElement
    ): HTMLElement {
        const resizerEl = layoutEl.createDiv({ cls: "ofc-tray-resizer" });
        this.registerDomEvent(resizerEl, "mousedown", (e: MouseEvent) => {
            e.preventDefault();
            resizerEl.addClass("is-dragging");
            const startX = e.clientX;
            const startWidth = memoEl.getBoundingClientRect().width;
            const onMove = (ev: MouseEvent) => {
                const width = Math.max(
                    160,
                    Math.min(640, startWidth - (ev.clientX - startX))
                );
                memoEl.style.width = `${width}px`;
                this.fullCalendarView?.updateSize();
            };
            const onUp = async () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                resizerEl.removeClass("is-dragging");
                this.plugin.settings.memoWidth = Math.round(
                    memoEl.getBoundingClientRect().width
                );
                await this.plugin.saveTrayWidth();
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
        return resizerEl;
    }

    /**
     * Move a daily-note TODO line to where it was dropped: a time slot gives
     * it that start (keeping its previous duration, or 30 minutes), the
     * all-day lane just changes its day. Unlike task cards, dropping a TODO
     * moves the line itself — no session is created.
     */
    private async rescheduleTodo(id: string, start: Date, allDay: boolean) {
        const cached = this.plugin.cache.getEventById(id);
        if (!cached || cached.type !== "single") {
            return;
        }
        const dt = DateTime.fromJSDate(start);
        const date = dt.toISODate();
        let updated;
        if (allDay) {
            const { startTime: _s, endTime: _e, ...rest } = cached as any;
            updated = { ...rest, date, endDate: null, allDay: true };
        } else {
            let minutes = 30;
            if (!cached.allDay && cached.startTime && cached.endTime) {
                const s = DateTime.fromISO(
                    `${cached.date}T${cached.startTime}`
                );
                const e = DateTime.fromISO(`${cached.date}T${cached.endTime}`);
                if (s.isValid && e.isValid && e > s) {
                    minutes = e.diff(s, "minutes").minutes;
                }
            }
            const end = dt.plus({ minutes });
            updated = {
                ...cached,
                date,
                endDate: null,
                allDay: false,
                startTime: dt.toFormat("HH:mm"),
                endTime:
                    end.toISODate() === date ? end.toFormat("HH:mm") : "23:59",
            };
        }
        try {
            await this.plugin.cache.updateEventWithId(id, updated as OFCEvent);
        } catch (e) {
            if (e instanceof Error) {
                console.error(e);
                new Notice(e.message);
            }
        }
    }

    /** Task linktext → colors, for painting session blocks like the tray. */
    private taskLooks(): Map<string, TaskLook> {
        const looks = new Map<string, TaskLook>();
        for (const card of collectTaskCards(this.plugin)) {
            const link = linktextForEvent(this.plugin, card.id);
            if (link) {
                looks.set(link, {
                    sourceColor: card.sourceColor,
                    status: card.event.status,
                });
            }
        }
        return looks;
    }

    /**
     * Give a block the look of what it stands for (docs/ux.md §1): its
     * task's project colour, or the one colour of hands when it links to
     * no task; paler when it is from Plan; a green edge while it runs.
     * Status isn't painted.
     */
    private decorateSession(
        input: EventInput,
        looks: Map<string, TaskLook>,
        event: OFCEvent,
        plan = false
    ): EventInput {
        // A block from Plan is still an intention: paler, dashed edge.
        if (plan) {
            input.classNames = [
                ...(Array.isArray(input.classNames) ? input.classNames : []),
                "ofc-event-plan",
            ];
        }
        // Running session (no endTime yet): a green edge, and the block
        // is stretched to
        // "now" so it mirrors elapsed time instead of FullCalendar's fake
        // one-hour default. A view interval keeps growing it (see onOpen).
        if (
            event.type === "single" &&
            !event.allDay &&
            event.startTime &&
            !event.endTime
        ) {
            input.classNames = [
                ...(Array.isArray(input.classNames) ? input.classNames : []),
                "ofc-session-running",
            ];
            const start = DateTime.fromISO(`${event.date}T${event.startTime}`);
            const now = DateTime.now();
            if (start.isValid && now > start) {
                input.end = now.toISO({
                    includeOffset: false,
                    suppressMilliseconds: true,
                });
            }
        }
        const link = firstLinktext(input.title ?? "");
        const look = link ? looks.get(link) : undefined;
        if (!look || !look.sourceColor) {
            // Not a task: a hand (or free text). All of these share one
            // strong colour — the hand teal (--ofc-hand) — whatever colour
            // the work-log calendar itself is set to.
            input.classNames = [
                ...(Array.isArray(input.classNames) ? input.classNames : []),
                "ofc-event-hand",
            ];
            return input;
        }
        // The project's colour, and only that: the event mount hook turns
        // it into a tint and a bar (see calendar.ts). Status isn't painted.
        input.backgroundColor = look.sourceColor;
        input.borderColor = look.sourceColor;
        return input;
    }

    /** Log or Plan: the two calendars whose events are blocks of time for
     * a task or a hand, drawn in that task's (or the hands') colour. */
    /**
     * What a block can do where it stands: a running one stops, one of
     * today's Plan starts. Anything else has no action. The block's button
     * and its menu both ask here.
     */
    private blockAction(e: EventApi): {
        icon: string;
        label: string;
        onClick: () => unknown;
    } | null {
        if (!this.isBlockSource(e.source?.id)) {
            return null;
        }
        const event = this.plugin.cache.getEventById(e.id);
        if (!event || event.type !== "single" || event.allDay) {
            return null;
        }
        if (event.startTime && !event.endTime) {
            return {
                icon: "square",
                label: "止める",
                onClick: () => stopSession(this.plugin, { id: e.id, event }),
            };
        }
        if (
            e.classNames.includes("ofc-event-plan") &&
            event.date === DateTime.now().toISODate()
        ) {
            return {
                icon: "play",
                label: "始める",
                onClick: () => startSessionFromBlock(this.plugin, e.id, event),
            };
        }
        return null;
    }

    /** A read-only event has no actions; its menu says what and when. */
    private addRemoteInfo(menu: Menu, e: EventApi) {
        const hm = (d: Date | null) =>
            d ? DateTime.fromJSDate(d).toFormat("H:mm") : "";
        menu.addItem((item) => item.setTitle(e.title).setDisabled(true));
        menu.addItem((item) =>
            item
                .setTitle(e.allDay ? "終日" : `${hm(e.start)} - ${hm(e.end)}`)
                .setDisabled(true)
        );
        const source = e.source?.id
            ? this.plugin.cache.getCalendarById(e.source.id)
            : null;
        if (source?.name) {
            menu.addItem((item) =>
                item.setTitle(source.name).setDisabled(true)
            );
        }
    }

    private isBlockSource(id: string | undefined): boolean {
        return (
            !!id &&
            (id === getWorklogCalendarId(this.plugin) ||
                id === getPlanCalendarId(this.plugin))
        );
    }

    translateSources() {
        const planId = getPlanCalendarId(this.plugin);
        const looks = this.taskLooks();
        return this.plugin.cache.getAllEvents().map(
            ({ events, editable, color, id }): EventSourceInput => ({
                id,
                events: events
                    .filter(({ event }) => !isWorkflowTask(event))
                    .flatMap((e) => {
                        const input = toEventInput(e.id, e.event);
                        if (!input) {
                            return [];
                        }
                        return this.isBlockSource(id)
                            ? [
                                  this.decorateSession(
                                      input,
                                      looks,
                                      e.event,
                                      id === planId
                                  ),
                              ]
                            : [input];
                    }),
                editable,
                ...getCalendarColors(color),
            })
        );
    }

    async onOpen() {
        await this.plugin.loadSettings();
        if (!this.plugin.cache) {
            new Notice("カレンダーの読み込みが終わっていません。");
            return;
        }
        if (!this.plugin.cache.initialized) {
            // Restored views open before the vault index is complete on
            // startup; populating then throws "Cannot get folder" for sources
            // whose folders haven't been indexed yet. Don't AWAIT layout-
            // ready here — mobile's workspace load awaits each view's
            // onOpen(), so blocking on it deadlocks the "reloading
            // workspace" screen. Bail out and re-open once ready instead.
            if (!this.app.workspace.layoutReady) {
                this.app.workspace.onLayoutReady(() => this.onOpen());
                return;
            }
            await this.plugin.cache.populate();
        }

        if (!this.kanbanActionAdded) {
            this.kanbanActionAdded = true;
            // Main-tab calendars swap to the kanban board in place, so the
            // two feel like one tool with two axes. The sidebar calendar is
            // too narrow for a board, so it opens the kanban in a main tab.
            this.addAction(
                "check-check",
                "過ぎた予定を Log に写す",
                async () => {
                    const file = dailyFile(this.plugin.io, todayISO());
                    if (file) {
                        await confirmPlanFor(this.plugin, file);
                    }
                }
            );
            this.addAction("columns", "kanban に切り替える", () => {
                if (this.inSidebar) {
                    this.plugin.activateKanbanView();
                } else {
                    this.leaf.setViewState({
                        type: FULL_CALENDAR_KANBAN_VIEW_TYPE,
                        active: true,
                    });
                }
            });
        }

        const container = this.containerEl.children[1];
        container.empty();

        if (
            this.plugin.settings.calendarSources.filter(
                (s) => s.type !== "FOR_TEST_ONLY"
            ).length === 0
        ) {
            renderOnboarding(this.app, this.plugin, container.createEl("div"));
            return;
        }

        // Task tray next to the calendar (main tab only — the sidebar is too
        // narrow). Desktop: a resizable side column. Mobile: an on-demand
        // full-width vertical list toggled from the view header — sessions
        // start with ▶ there, so it doesn't need to be visible all the time.
        const layoutEl = container.createDiv({ cls: "ofc-calendar-layout" });
        if (Platform.isMobile) {
            layoutEl.addClass("ofc-calendar-layout-mobile");
        }
        this.trayColumn = [];
        this.memoColumn = [];
        const trayEl = !this.inSidebar
            ? layoutEl.createDiv({ cls: "ofc-task-tray" })
            : null;
        if (trayEl) {
            if (Platform.isMobile) {
                trayEl.addClass("ofc-task-tray-mobile-list", "is-hidden");
            } else {
                trayEl.style.width = `${this.plugin.settings.trayWidth}px`;
                this.trayColumn = [
                    trayEl,
                    this.setupTrayResizer(layoutEl, trayEl),
                ];
            }
        }
        const todayBarEl =
            trayEl && Platform.isMobile
                ? layoutEl.createDiv({ cls: "ofc-today-bar" })
                : null;
        let calendarEl = layoutEl.createDiv({ cls: "ofc-calendar-main" });
        // Memo column, right of the calendar. A long memo scrolls on its
        // own there instead of pushing the week's tasks out of the tray.
        this.memoPanel?.destroy();
        this.memoPanel = null;
        if (trayEl && !Platform.isMobile) {
            const memoEl = createDiv({ cls: "ofc-memo-pane" });
            memoEl.style.width = `${this.plugin.settings.memoWidth ?? 300}px`;
            this.memoColumn = [this.setupMemoResizer(layoutEl, memoEl), memoEl];
            layoutEl.appendChild(memoEl);
            this.memoPanel = renderMemoPanel(this.plugin, memoEl, {
                onPopOut: () =>
                    this.plugin.openPane(FULL_CALENDAR_MEMO_VIEW_TYPE),
            });
        }
        if (!this.layoutWatchAdded) {
            this.layoutWatchAdded = true;
            this.registerEvent(
                this.app.workspace.on("layout-change", () =>
                    this.syncPoppedPanels()
                )
            );
        }
        this.mobileTrayEl = Platform.isMobile ? trayEl : null;
        this.mobileCalendarEl = Platform.isMobile ? calendarEl : null;
        this.mobileTodayBarEl = todayBarEl;
        const toggleMobileTray = () => {
            const tray = this.mobileTrayEl;
            const cal = this.mobileCalendarEl;
            if (!tray || !cal) {
                return;
            }
            const show = tray.hasClass("is-hidden");
            tray.toggleClass("is-hidden", !show);
            cal.toggleClass("is-hidden", show);
            this.mobileTodayBarEl?.toggleClass("is-hidden", show);
            if (!show) {
                this.fullCalendarView?.updateSize();
            }
        };
        this.toggleMobileTray = toggleMobileTray;
        if (todayBarEl) {
            todayBarEl.onclick = toggleMobileTray;
        }

        if (!this.trayActionAdded && trayEl && Platform.isMobile) {
            this.trayActionAdded = true;
            // Through `this`: the action outlives re-renders, the elements
            // (and the closure above) don't.
            this.addAction("list-checks", "今日と今週", () =>
                this.toggleMobileTray?.()
            );
        }

        const sources: EventSourceInput[] = this.translateSources();

        if (this.fullCalendarView) {
            this.fullCalendarView.destroy();
            this.fullCalendarView = null;
        }
        this.fullCalendarView = renderCalendar(calendarEl, sources, {
            forceNarrow: this.inSidebar,
            onExternalDrop: async (info) => {
                const title = info.event.title;
                const start = info.event.start;
                const allDay = info.event.allDay;
                const todoId = info.event.extendedProps?.trayTodoId;
                // Drop FullCalendar's temporary event; persisting through the
                // cache adds the real one back via the update callback.
                info.event.remove();
                if (!start) {
                    return;
                }
                // A TODO row from the tray reschedules the existing line;
                // a task card stamps a new work-log session.
                if (todoId) {
                    await this.rescheduleTodo(todoId, start, allDay);
                    return;
                }
                if (!title) {
                    return;
                }
                await createSession(this.plugin, title, start, allDay);
            },
            eventClick: async (info) => {
                try {
                    // Read-only (remote/ICS) events have no local file and no
                    // edit modal. Instead, a note can opt in to being their
                    // landing page via fc-link-event frontmatter; events with
                    // no declaring note do nothing.
                    if (!this.plugin.cache.isEventEditable(info.event.id)) {
                        const file = resolveLinkedNote(
                            this.app,
                            info.event.title
                        );
                        if (file) {
                            await openFileInLeaf(this.app, file);
                        } else {
                            // Nothing to open: at least say what it is.
                            const menu = new Menu();
                            this.addRemoteInfo(menu, info.event);
                            menu.showAtMouseEvent(info.jsEvent);
                        }
                        return;
                    }
                    if (
                        info.jsEvent.getModifierState("Control") ||
                        info.jsEvent.getModifierState("Meta")
                    ) {
                        await openFileForEvent(
                            this.plugin.cache,
                            this.app,
                            info.event.id
                        );
                    } else {
                        launchEditModal(this.plugin, info.event.id);
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        console.warn(e);
                        new Notice(e.message);
                    }
                }
            },
            // Selecting an empty range creates a session: pick a tray task,
            // log it over the selected span. Tasks themselves still come from
            // the kanban's + / quickadd, TODOs from the daily note itself.
            select: async (start, end, allDay) => {
                const title = await pickTrayTask(
                    this.plugin,
                    DateTime.fromJSDate(start).toISODate()
                );
                if (!title) {
                    return;
                }
                // A plain click selects a single slot (30 min); treat it as
                // "start here" and keep createSession's default hour. Only a
                // real drag pins the end to the selection.
                const isClick =
                    !allDay &&
                    end.getTime() - start.getTime() <= 30 * 60 * 1000;
                await createSession(
                    this.plugin,
                    title,
                    start,
                    allDay,
                    isClick ? undefined : end
                );
            },
            modifyEvent: async (newEvent, oldEvent) => {
                try {
                    const didModify = await this.plugin.cache.updateEventWithId(
                        oldEvent.id,
                        fromEventApi(newEvent)
                    );
                    return !!didModify;
                } catch (e: any) {
                    console.error(e);
                    new Notice(`動かせませんでした。${e.message}`);
                    return false;
                }
            },
            // A block of today's can be started where it stands, and a
            // running one stopped — no menu in between.
            eventButton: (e) => this.blockAction(e),

            eventMouseEnter: async (info) => {
                try {
                    let linkpath: string | null = null;
                    if (this.plugin.cache.isEventEditable(info.event.id)) {
                        linkpath =
                            this.plugin.cache.getInfoForEditableEvent(
                                info.event.id
                            ).location?.path ?? null;
                    } else {
                        // Read-only events preview their declaring note
                        // (fc-link-event frontmatter), if one exists.
                        linkpath =
                            resolveLinkedNote(this.app, info.event.title)
                                ?.path ?? null;
                    }
                    if (linkpath) {
                        this.app.workspace.trigger("hover-link", {
                            event: info.jsEvent,
                            source: PLUGIN_SLUG,
                            hoverParent: calendarEl,
                            targetEl: info.jsEvent.target,
                            linktext: linkpath,
                            sourcePath: linkpath,
                        });
                    }
                } catch (e) {}
            },
            firstDay: this.plugin.settings.firstDay,
            initialView: this.plugin.settings.initialView,
            timeFormat24h: this.plugin.settings.timeFormat24h,
            openContextMenuForEvent: async (e, mouseEvent) => {
                const menu = new Menu();
                if (!this.plugin.cache) {
                    return;
                }
                const event = this.plugin.cache.getEventById(e.id);
                if (!event) {
                    return;
                }

                if (this.plugin.cache.isEventEditable(e.id)) {
                    // No "Turn into task"/"Remove checkbox" here: checkbox-ness
                    // is structural. A checkbox on a session line would get
                    // copied forward by the daily template's rollover, and
                    // TODO completion is the checkbox on the event itself.
                    // The same one action the block's own button offers,
                    // under the same condition (docs/ux.md §2).
                    const action = this.blockAction(e);
                    if (action) {
                        menu.addItem((item) =>
                            item
                                .setTitle(action.label)
                                .setIcon(action.icon)
                                .onClick(action.onClick)
                        );
                        menu.addSeparator();
                    }
                    menu.addItem((item) =>
                        item
                            .setTitle("ノートを開く")
                            .setIcon("file-text")
                            .onClick(() => {
                                if (!this.plugin.cache) {
                                    return;
                                }
                                openFileForEvent(
                                    this.plugin.cache,
                                    this.app,
                                    e.id
                                );
                            })
                    );
                    menu.addItem((item) =>
                        item
                            .setTitle("消す")
                            .setIcon("trash-2")
                            .onClick(async () => {
                                if (!this.plugin.cache) {
                                    return;
                                }
                                await deleteWithUndo(
                                    this.plugin,
                                    e.id,
                                    `「${plainTitle(e.title)}」を消しました。`
                                );
                            })
                    );
                } else {
                    this.addRemoteInfo(menu, e);
                }

                // The right-click focuses the event element, and FullCalendar
                // paints focused events with a dark overlay. Obsidian's Menu
                // never takes focus, so without this the block would stay
                // dark after the menu closes.
                const focused = document.activeElement;
                menu.onHide(() => {
                    if (focused instanceof HTMLElement) {
                        focused.blur();
                    }
                });
                menu.showAtMouseEvent(mouseEvent);
            },
            toggleTask: async (e, isDone) => {
                const event = this.plugin.cache.getEventById(e.id);
                if (!event) {
                    return false;
                }
                if (event.type !== "single") {
                    return false;
                }

                try {
                    // Ticking what is being worked on also stops its
                    // clock, as in the tray: finishing is one act.
                    const session = isDone
                        ? sessionOfRow(
                              { title: event.title } as TodayRow,
                              findRunningSessions(this.plugin)
                          )
                        : undefined;
                    if (session) {
                        await stopSession(this.plugin, session);
                    }
                    await this.plugin.cache.updateEventWithId(
                        e.id,
                        toggleTask(event, isDone)
                    );
                } catch (e) {
                    if (e instanceof FCError) {
                        new Notice(e.message);
                    }
                    return false;
                }
                return true;
            },
        });
        // @ts-ignore
        window.fc = this.fullCalendarView;

        this.taskTray?.destroy();
        this.taskTray = trayEl
            ? renderTaskTray(this.plugin, trayEl, {
                  draggable: !Platform.isMobile,
                  memo: Platform.isMobile,
                  onPopOut: Platform.isMobile
                      ? undefined
                      : () =>
                            this.plugin.openPane(FULL_CALENDAR_TRAY_VIEW_TYPE),
                  onToday: ({ open, first }) => {
                      const bar = this.mobileTodayBarEl;
                      if (!bar) {
                          return;
                      }
                      bar.empty();
                      bar.createSpan({
                          cls: "ofc-today-bar-title",
                          text: "今日",
                      });
                      bar.createSpan({
                          cls: "ofc-today-bar-text",
                          text:
                              open === 0 || !first
                                  ? "残りなし"
                                  : open === 1
                                  ? `残り1件：${first}`
                                  : `残り${open}件：${first} ほか`,
                      });
                  },
              })
            : null;

        this.syncPoppedPanels();

        if (!this.growIntervalAdded) {
            this.growIntervalAdded = true;
            // Stretch running session blocks toward "now" once a minute so
            // their height tracks elapsed time.
            this.registerInterval(
                window.setInterval(() => {
                    const now = new Date();
                    for (const session of findRunningSessions(this.plugin)) {
                        const api = this.fullCalendarView?.getEventById(
                            session.id
                        );
                        if (api && api.start && api.start < now) {
                            api.setEnd(now);
                        }
                    }
                }, 60 * 1000)
            );
        }

        this.registerDomEvent(this.containerEl, "mouseenter", () => {
            this.plugin.cache.revalidateRemoteCalendars();
        });

        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
        this.callback = this.plugin.cache.on("update", (payload) => {
            // Any cache change can affect which tasks belong in the tray
            // (status flips, sprint moves, new tasks); re-render it wholesale,
            // it's cheap.
            this.taskTray?.refresh();
            if (payload.type === "resync") {
                this.fullCalendarView?.removeAllEventSources();
                const sources = this.translateSources();
                sources.forEach((source) =>
                    this.fullCalendarView?.addEventSource(source)
                );
                return;
            } else if (payload.type === "events") {
                const { toRemove, toAdd } = payload;
                console.debug("updating view from cache...", {
                    toRemove,
                    toAdd,
                });
                toRemove.forEach((id) => {
                    const event = this.fullCalendarView?.getEventById(id);
                    if (event) {
                        console.debug("removing event", event.toPlainObject());
                        event.remove();
                    } else {
                        console.warn(
                            `Event with id=${id} was slated to be removed but does not exist in the calendar.`
                        );
                    }
                });
                const planId = getPlanCalendarId(this.plugin);
                const looks = toAdd.some(({ calendarId }) =>
                    this.isBlockSource(calendarId)
                )
                    ? this.taskLooks()
                    : null;
                toAdd.forEach(({ id, event, calendarId }) => {
                    if (isWorkflowTask(event)) {
                        return;
                    }
                    let eventInput = toEventInput(id, event);
                    if (!eventInput) {
                        return;
                    }
                    if (this.isBlockSource(calendarId) && looks) {
                        eventInput = this.decorateSession(
                            eventInput,
                            looks,
                            event,
                            calendarId === planId
                        );
                    }
                    console.debug("adding event", {
                        id,
                        event,
                        eventInput,
                        calendarId,
                    });
                    const addedEvent = this.fullCalendarView?.addEvent(
                        eventInput,
                        calendarId
                    );
                    console.debug("event that was added", addedEvent);
                });
            } else if (payload.type == "calendar") {
                const {
                    calendar: { id, events, editable, color },
                } = payload;
                console.debug("replacing calendar with id", payload.calendar);
                // Same treatment as translateSources: workflow tasks stay off
                // the calendar, session blocks get their task's colors. This
                // path serves remote revalidation AND startup load retries of
                // local sources.
                const looks = this.isBlockSource(id) ? this.taskLooks() : null;
                const isPlan = id === getPlanCalendarId(this.plugin);
                this.fullCalendarView?.getEventSourceById(id)?.remove();
                this.fullCalendarView?.addEventSource({
                    id,
                    events: events
                        .filter(({ event }) => !isWorkflowTask(event))
                        .flatMap(({ id: eventId, event }) => {
                            const input = toEventInput(eventId, event);
                            if (!input) {
                                return [];
                            }
                            return looks
                                ? [
                                      this.decorateSession(
                                          input,
                                          looks,
                                          event,
                                          isPlan
                                      ),
                                  ]
                                : [input];
                        }),
                    editable,
                    ...getCalendarColors(color),
                });
            }
        });
    }

    onResize(): void {
        if (this.fullCalendarView) {
            this.fullCalendarView.render();
        }
    }

    async onunload() {
        if (this.fullCalendarView) {
            this.fullCalendarView.destroy();
            this.fullCalendarView = null;
        }
        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
        this.taskTray?.destroy();
        this.taskTray = null;
        this.memoPanel?.destroy();
        this.memoPanel = null;
    }
}
