import { MarkdownView, Notice, Plugin, TFile, TFolder } from "obsidian";
import {
    CalendarView,
    FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
    FULL_CALENDAR_VIEW_TYPE,
} from "./ui/view";
import { KanbanView, FULL_CALENDAR_KANBAN_VIEW_TYPE } from "./ui/kanban";
import { renderCalendar } from "./ui/calendar";
import { toEventInput } from "./ui/interop";
import {
    DEFAULT_SETTINGS,
    FullCalendarSettings,
    FullCalendarSettingTab,
} from "./ui/settings";
import { PLUGIN_SLUG } from "./types";
import EventCache, { UpdateViewCallback } from "./core/EventCache";
import { rollTodosForward } from "./core/todoRollover";
import { reconcileActuals, scheduleActualsSync } from "./core/actualsSync";
import ReminderService from "./core/ReminderService";
import { ObsidianIO } from "./ObsidianAdapter";
import {
    configureStatuses,
    migrateSourceColor,
    nextSourceColor,
} from "./ui/colors";
import FullNoteCalendar from "./calendars/FullNoteCalendar";
import DailyNoteCalendar from "./calendars/DailyNoteCalendar";
import ICSCalendar from "./calendars/ICSCalendar";
import CalDAVCalendar from "./calendars/CalDAVCalendar";

export default class FullCalendarPlugin extends Plugin {
    settings: FullCalendarSettings = DEFAULT_SETTINGS;
    cache: EventCache = new EventCache({
        local: (info) =>
            info.type === "local"
                ? new FullNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.directory
                  )
                : null,
        dailynote: (info) =>
            info.type === "dailynote"
                ? new DailyNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.heading,
                      info.todos
                  )
                : null,
        ical: (info) =>
            info.type === "ical" ? new ICSCalendar(info.color, info.url) : null,
        caldav: (info) =>
            info.type === "caldav"
                ? new CalDAVCalendar(
                      info.color,
                      info.name,
                      {
                          type: "basic",
                          username: info.username,
                          password: info.password,
                      },
                      info.url,
                      info.homeUrl
                  )
                : null,
        FOR_TEST_ONLY: () => null,
    });

    reminderService = new ReminderService(this);

    renderCalendar = renderCalendar;
    processFrontmatter = toEventInput;

    // Keeps task `actual` fields in sync with work-log sessions.
    private actualsCallback: UpdateViewCallback | null = null;

    async rollTodos() {
        try {
            await this.cache.populate();
            const moved = await rollTodosForward(this);
            new Notice(
                `Full Calendar: rolled ${moved} unfinished TODO(s) forward to today.`
            );
            await reconcileActuals(this);
        } catch (e) {
            console.error("Full Calendar: TODO rollover failed.", e);
        }
    }

    async activateView() {
        const leaves = this.app.workspace
            .getLeavesOfType(FULL_CALENDAR_VIEW_TYPE)
            .filter((l) => (l.view as CalendarView).inSidebar === false);
        if (leaves.length === 0) {
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({
                type: FULL_CALENDAR_VIEW_TYPE,
                active: true,
            });
        } else {
            await Promise.all(
                leaves.map((l) => (l.view as CalendarView).onOpen())
            );
        }
    }
    async activateKanbanView() {
        const leaves = this.app.workspace.getLeavesOfType(
            FULL_CALENDAR_KANBAN_VIEW_TYPE
        );
        if (leaves.length === 0) {
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({
                type: FULL_CALENDAR_KANBAN_VIEW_TYPE,
                active: true,
            });
        } else {
            this.app.workspace.revealLeaf(leaves[0]);
        }
    }

    async onload() {
        await this.loadSettings();

        // Migrate existing sources to the current color palette and register
        // the auto-task folder before the first cache build, so both land on
        // the very first open. Persist with saveData (not saveSettings) to
        // avoid the cache-reset Notice during startup.
        const migrated = this.migrateSourceColors();
        const addedAutoFolder = this.syncAutoTaskFolder();
        if (migrated || addedAutoFolder) {
            await this.saveData(this.settings);
        }

        this.cache.reset(this.settings.calendarSources);

        // TODO rollover is MANUAL-ONLY (the "Roll unfinished TODOs forward"
        // command). Running it automatically made unrelated edits look like
        // lines vanishing — unchecked TODOs now stay on their own day until
        // the user asks. Only the task-`actual` reconcile runs at startup.
        this.app.workspace.onLayoutReady(async () => {
            try {
                await this.cache.populate();
                await reconcileActuals(this);
            } catch (e) {
                console.error("Full Calendar: actuals reconcile failed.", e);
            }
        });

        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                this.cache.fileUpdated(file);
            })
        );

        // Any cached change (session created/resized/deleted, hand edits…)
        // debounces a reconcile of task `actual` fields. Writes re-fire this
        // event, find no diffs, and settle.
        this.actualsCallback = this.cache.on("update", () =>
            scheduleActualsSync(this)
        );

        // Auto-register the task folder when it is (re-)created after launch.
        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (
                    file instanceof TFolder &&
                    file.path === this.settings.autoTaskFolder?.trim() &&
                    this.syncAutoTaskFolder()
                ) {
                    this.saveSettings();
                }
            })
        );

        // Drop the auto source when its folder is deleted (a transient
        // removal, not a user dismissal — re-creating the folder re-adds it).
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFolder) {
                    const before = this.settings.calendarSources.length;
                    this.settings.calendarSources =
                        this.settings.calendarSources.filter(
                            (s) =>
                                !(
                                    s.type === "local" &&
                                    s.directory === file.path
                                )
                        );
                    if (this.settings.calendarSources.length !== before) {
                        this.saveSettings();
                    }
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile) {
                    console.debug("FILE RENAMED", file.path);
                    this.cache.deleteEventsAtPath(oldPath);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile) {
                    console.debug("FILE DELETED", file.path);
                    this.cache.deleteEventsAtPath(file.path);
                }
            })
        );

        // @ts-ignore
        window.cache = this.cache;

        this.registerView(
            FULL_CALENDAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf, this, false)
        );

        this.registerView(
            FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf, this, true)
        );

        this.registerView(
            FULL_CALENDAR_KANBAN_VIEW_TYPE,
            (leaf) => new KanbanView(leaf, this)
        );

        this.addRibbonIcon(
            "calendar-glyph",
            "Open Full Calendar",
            async (_: MouseEvent) => {
                await this.activateView();
            }
        );

        this.addRibbonIcon(
            "columns",
            "Open Kanban board",
            async (_: MouseEvent) => {
                await this.activateKanbanView();
            }
        );

        this.addSettingTab(new FullCalendarSettingTab(this.app, this));

        this.addCommand({
            id: "full-calendar-reset",
            name: "Reset Event Cache",
            callback: () => {
                this.cache.reset(this.settings.calendarSources);
                this.app.workspace.detachLeavesOfType(FULL_CALENDAR_VIEW_TYPE);
                this.app.workspace.detachLeavesOfType(
                    FULL_CALENDAR_SIDEBAR_VIEW_TYPE
                );
                new Notice("Full Calendar has been reset.");
            },
        });

        this.addCommand({
            id: "full-calendar-revalidate",
            name: "Revalidate remote calendars",
            callback: () => {
                this.cache.revalidateRemoteCalendars(true);
            },
        });

        this.addCommand({
            id: "full-calendar-recompute-actuals",
            name: "Recompute task actuals from work-log sessions",
            callback: async () => {
                const written = await reconcileActuals(this);
                new Notice(
                    `Full Calendar: updated \`actual\` on ${written} task note(s).`
                );
            },
        });

        this.addCommand({
            id: "full-calendar-roll-todos",
            name: "Roll unfinished TODOs forward to today",
            callback: async () => {
                await this.rollTodos();
            },
        });

        this.addCommand({
            id: "full-calendar-open-kanban",
            name: "Open Kanban board",
            callback: () => {
                this.activateKanbanView();
            },
        });

        this.addCommand({
            id: "full-calendar-open",
            name: "Open Calendar",
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: "full-calendar-open-sidebar",
            name: "Open in sidebar",
            callback: () => {
                if (
                    this.app.workspace.getLeavesOfType(
                        FULL_CALENDAR_SIDEBAR_VIEW_TYPE
                    ).length
                ) {
                    return;
                }
                this.app.workspace.getRightLeaf(false).setViewState({
                    type: FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
                });
            },
        });

        (this.app.workspace as any).registerHoverLinkSource(PLUGIN_SLUG, {
            display: "Full Calendar",
            defaultMod: true,
        });

        // Start firing pre-event notifications (desktop-only; no-ops otherwise).
        this.reminderService.start();
    }

    onunload() {
        if (this.actualsCallback) {
            this.cache.off("update", this.actualsCallback);
            this.actualsCallback = null;
        }
        this.reminderService.stop();
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_SIDEBAR_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_KANBAN_VIEW_TYPE);
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
        // Status lookups (colors, done detection, kanban columns) live in a
        // module registry so pure helpers can read them without a plugin
        // handle; keep it in sync with settings.
        configureStatuses(this.settings.statuses, this.settings.uncheckStatus);
    }

    async saveSettings() {
        new Notice("Resetting the event cache with new settings...");
        await this.saveData(this.settings);
        this.cache.reset(this.settings.calendarSources);
        await this.cache.populate();
        this.cache.resync();
    }

    /**
     * Persist reminder-related settings without the heavy cache reset (and its
     * "Resetting..." Notice) that saveSettings() performs — reminders read the
     * live cache, so only the polling loop needs to pick up the change.
     */
    async saveReminderSettings() {
        await this.saveData(this.settings);
        this.reminderService.restart();
    }

    /**
     * Persist kanban filter selections without the cache reset that
     * saveSettings() performs — filters only affect what the board renders.
     */
    async saveKanbanFilters() {
        await this.saveData(this.settings);
    }

    /**
     * Persist the dragged tray width. Pure layout state — no cache reset.
     */
    async saveTrayWidth() {
        await this.saveData(this.settings);
    }

    /**
     * Persist the tray's manual card order. Pure layout state — no cache
     * reset.
     */
    async saveTrayOrder() {
        await this.saveData(this.settings);
    }

    /**
     * Bring existing source colors onto the current palette (legacy palette
     * entries are remapped; custom colors are left alone). Mutates settings in
     * place and returns whether anything changed.
     */
    migrateSourceColors(): boolean {
        let changed = false;
        for (const source of this.settings.calendarSources) {
            const next = migrateSourceColor(source.color);
            if (next !== source.color) {
                source.color = next;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Reconcile the configured auto-task folder against the calendar sources.
     * Adds a "local" source for the folder when it exists, isn't already
     * registered, and hasn't been dismissed by the user. Mutates settings in
     * place and returns whether anything changed (caller persists).
     */
    syncAutoTaskFolder(): boolean {
        const folder = this.settings.autoTaskFolder?.trim();
        if (!folder) {
            return false;
        }
        if (this.settings.dismissedAutoFolders?.includes(folder)) {
            return false;
        }
        const exists =
            this.app.vault.getAbstractFileByPath(folder) instanceof TFolder;
        if (!exists) {
            return false;
        }
        const alreadyRegistered = this.settings.calendarSources.some(
            (s) => s.type === "local" && s.directory === folder
        );
        if (alreadyRegistered) {
            return false;
        }
        this.settings.calendarSources.push({
            type: "local",
            directory: folder,
            color: nextSourceColor(
                this.settings.calendarSources.map((s) => s.color)
            ),
        });
        return true;
    }
}
