import "./overrides.css";
import { ItemView, Menu, Notice, Platform, WorkspaceLeaf } from "obsidian";
import { Calendar, EventInput, EventSourceInput } from "@fullcalendar/core";
import { renderCalendar } from "./calendar";
import FullCalendarPlugin from "../main";
import { FCError, OFCEvent, PLUGIN_SLUG } from "../types";
import { fromEventApi, toEventInput } from "./interop";
import { renderOnboarding } from "./onboard";
import { openFileForEvent } from "./actions";
import { launchEditModal } from "./event_modal";
import { isTask, toggleTask, unmakeTask } from "src/ui/tasks";
import { UpdateViewCallback } from "src/core/EventCache";
import DailyNoteCalendar from "src/calendars/DailyNoteCalendar";
import {
    createSession,
    firstLinktext,
    getWorklogCalendarId,
    linktextForEvent,
} from "src/core/worklog";
import { renderTaskTray, TaskTray } from "./tray";
import { collectTaskCards, FULL_CALENDAR_KANBAN_VIEW_TYPE } from "./kanban";
import { contrastTextColor, getStatusColor } from "./colors";

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
    // onOpen() re-runs on the same view instance (e.g. activateView() calls it
    // on existing leaves), but the header action must only be added once.
    kanbanActionAdded = false;

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
        return this.inSidebar ? "Full Calendar" : "Calendar";
    }

    /**
     * A draggable divider that resizes the task tray. The width persists to
     * settings (light save — no cache reset) so it survives restarts.
     */
    private setupTrayResizer(layoutEl: HTMLElement, trayEl: HTMLElement) {
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
     * Give a work-log session block its linked task's colors — fill by
     * workflow status, frame in the project calendar's color — matching the
     * tray card it was dragged from. Sessions with no resolvable task link
     * keep the work-log calendar's own color.
     */
    private decorateSession(
        input: EventInput,
        looks: Map<string, TaskLook>
    ): EventInput {
        const link = firstLinktext(input.title ?? "");
        const look = link ? looks.get(link) : undefined;
        if (!look) {
            return input;
        }
        const fill =
            (look.status && getStatusColor(look.status)) ||
            look.sourceColor ||
            null;
        if (fill) {
            input.backgroundColor = fill;
            input.textColor = contrastTextColor(fill);
        }
        if (look.sourceColor) {
            input.borderColor = look.sourceColor;
        }
        return input;
    }

    translateSources() {
        const worklogId = getWorklogCalendarId(this.plugin);
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
                        return id === worklogId
                            ? [this.decorateSession(input, looks)]
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
            new Notice("Full Calendar event cache not loaded.");
            return;
        }
        if (!this.plugin.cache.initialized) {
            // Restored views open before the vault index is complete on
            // startup; populating then throws "Cannot get folder" for sources
            // whose folders haven't been indexed yet. onLayoutReady resolves
            // immediately if startup already finished.
            await new Promise<void>((resolve) =>
                this.app.workspace.onLayoutReady(resolve)
            );
            await this.plugin.cache.populate();
        }

        if (!this.kanbanActionAdded) {
            this.kanbanActionAdded = true;
            // Main-tab calendars swap to the kanban board in place, so the
            // two feel like one tool with two axes. The sidebar calendar is
            // too narrow for a board, so it opens the kanban in a main tab.
            this.addAction("columns", "Switch to Kanban board", () => {
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
        // narrow). Desktop: a resizable side column. Mobile: a horizontal
        // card strip above the calendar, since phones have no width to spare.
        const layoutEl = container.createDiv({ cls: "ofc-calendar-layout" });
        if (Platform.isMobile) {
            layoutEl.addClass("ofc-calendar-layout-mobile");
        }
        const trayEl = !this.inSidebar
            ? layoutEl.createDiv({ cls: "ofc-task-tray" })
            : null;
        if (trayEl) {
            if (Platform.isMobile) {
                trayEl.addClass("ofc-task-tray-mobile");
            } else {
                trayEl.style.width = `${this.plugin.settings.trayWidth}px`;
                this.setupTrayResizer(layoutEl, trayEl);
            }
        }
        let calendarEl = layoutEl.createDiv({ cls: "ofc-calendar-main" });

        const sources: EventSourceInput[] = this.translateSources();

        if (this.fullCalendarView) {
            this.fullCalendarView.destroy();
            this.fullCalendarView = null;
        }
        this.fullCalendarView = renderCalendar(calendarEl, sources, {
            forceNarrow: this.inSidebar,
            // Live lookup (not a snapshot) so TODO calendars added while the
            // view is open still get their stale rolled-over copies hidden.
            isTodoSource: (sourceId) => {
                const cal = this.plugin.cache.getCalendarById(sourceId);
                return cal instanceof DailyNoteCalendar && cal.todos;
            },
            onExternalDrop: async (info) => {
                const title = info.event.title;
                const start = info.event.start;
                const allDay = info.event.allDay;
                // Drop FullCalendar's temporary event; persisting through the
                // cache adds the real one back via the update callback.
                info.event.remove();
                if (!title || !start) {
                    return;
                }
                await createSession(this.plugin, title, start, allDay);
            },
            eventClick: async (info) => {
                try {
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
            // No `select` handler: nothing is created from the calendar
            // surface. Tasks come from the kanban's + / quickadd, sessions
            // from the tray (drag or ▶), TODOs from the daily note itself.
            modifyEvent: async (newEvent, oldEvent) => {
                try {
                    const didModify = await this.plugin.cache.updateEventWithId(
                        oldEvent.id,
                        fromEventApi(newEvent)
                    );
                    return !!didModify;
                } catch (e: any) {
                    console.error(e);
                    new Notice(e.message);
                    return false;
                }
            },

            eventMouseEnter: async (info) => {
                try {
                    const location = this.plugin.cache.getInfoForEditableEvent(
                        info.event.id
                    ).location;
                    if (location) {
                        this.app.workspace.trigger("hover-link", {
                            event: info.jsEvent,
                            source: PLUGIN_SLUG,
                            hoverParent: calendarEl,
                            targetEl: info.jsEvent.target,
                            linktext: location.path,
                            sourcePath: location.path,
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
                    if (!isTask(event)) {
                        menu.addItem((item) =>
                            item
                                .setTitle("Turn into task")
                                .onClick(async () => {
                                    await this.plugin.cache.processEvent(
                                        e.id,
                                        (e) => toggleTask(e, false)
                                    );
                                })
                        );
                    } else {
                        menu.addItem((item) =>
                            item
                                .setTitle("Remove checkbox")
                                .onClick(async () => {
                                    await this.plugin.cache.processEvent(
                                        e.id,
                                        unmakeTask
                                    );
                                })
                        );
                    }
                    menu.addSeparator();
                    menu.addItem((item) =>
                        item.setTitle("Go to note").onClick(() => {
                            if (!this.plugin.cache) {
                                return;
                            }
                            openFileForEvent(this.plugin.cache, this.app, e.id);
                        })
                    );
                    menu.addItem((item) =>
                        item.setTitle("Delete").onClick(async () => {
                            if (!this.plugin.cache) {
                                return;
                            }
                            await this.plugin.cache.deleteEvent(e.id);
                            new Notice(`Deleted event "${e.title}".`);
                        })
                    );
                } else {
                    menu.addItem((item) => {
                        item.setTitle(
                            "No actions available on remote events"
                        ).setDisabled(true);
                    });
                }

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
        this.taskTray = trayEl ? renderTaskTray(this.plugin, trayEl) : null;

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
                const worklogId = getWorklogCalendarId(this.plugin);
                const looks = toAdd.some(
                    ({ calendarId }) => calendarId === worklogId
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
                    if (calendarId === worklogId && looks) {
                        eventInput = this.decorateSession(eventInput, looks);
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
                const looks =
                    id === getWorklogCalendarId(this.plugin)
                        ? this.taskLooks()
                        : null;
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
                                ? [this.decorateSession(input, looks)]
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
    }
}
