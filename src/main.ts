import {
    MarkdownView,
    Notice,
    Platform,
    Plugin,
    TFile,
    TFolder,
} from "obsidian";
import {
    CalendarView,
    FULL_CALENDAR_SIDEBAR_VIEW_TYPE,
    FULL_CALENDAR_VIEW_TYPE,
} from "./ui/view";
import { KanbanView, FULL_CALENDAR_KANBAN_VIEW_TYPE } from "./ui/kanban";
import {
    FULL_CALENDAR_MEMO_VIEW_TYPE,
    FULL_CALENDAR_TRAY_VIEW_TYPE,
    MemoView,
    TrayView,
} from "./ui/panes";
import { renderCalendar } from "./ui/calendar";
import { toEventInput } from "./ui/interop";
import {
    DEFAULT_SETTINGS,
    FullCalendarSettings,
    FullCalendarSettingTab,
} from "./ui/settings";
import { CalendarInfo, PLUGIN_SLUG } from "./types";
import {
    findRunningSessions,
    linktextForEvent,
    LOG_HEADING,
    PLAN_HEADING,
    startSession,
} from "./core/worklog";
import {
    addTaskToToday,
    collectTodayRows,
    doneAndNext,
    nextRow,
    plainTitle,
    soleLinktext,
    startOrStop,
} from "./core/today";
import { pickTrayTask } from "./ui/taskPicker";
import { loadDailySettings } from "./core/dailyService";
import { setNotifier } from "./core/notify";
import NoteKindCalendar, { isSetAside } from "./calendars/NoteKindCalendar";

// The issues calendar's id (see NoteKindCalendar.identifier).
const ISSUES_SOURCE_ID = "local::kind/issue";
const ISSUES_COLOR = "#d06f2a";
import { collectTaskCards } from "./core/cards";
import { DateTime } from "luxon";
import {
    confirmPlanFor,
    dailyDateOf,
    ensureTodayNote,
    fillPlanFor,
    targetDailyNote,
} from "./ui/planActions";
import EventCache, { UpdateViewCallback } from "./core/EventCache";
import { rollTodosForward } from "./core/todoRollover";
import ReminderService from "./ui/ReminderService";
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

/**
 * The Plan heading is part of the format, not a setting: wherever a daily
 * note's Log is a calendar, its Plan is one too, in the same colour. It is
 * added in memory only — the saved sources keep listing what the user set.
 */
function withPlanSource(sources: CalendarInfo[]): CalendarInfo[] {
    const isBlocks = (s: CalendarInfo, heading: string) =>
        s.type === "dailynote" && !s.todos && s.heading === heading;
    const log = sources.find((s) => isBlocks(s, LOG_HEADING));
    if (!log || sources.some((s) => isBlocks(s, PLAN_HEADING))) {
        return sources;
    }
    return [...sources, { ...log, heading: PLAN_HEADING } as CalendarInfo];
}

export default class FullCalendarPlugin extends Plugin {
    settings: FullCalendarSettings = DEFAULT_SETTINGS;
    // The vault, as the narrow set of file operations the core is written
    // against (see ObsidianInterface).
    io: ObsidianIO = new ObsidianIO(this.app);

    cache: EventCache = new EventCache({
        local: (info) =>
            info.type === "local"
                ? new FullNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.directory
                  )
                : null,
        notes: (info) =>
            info.type === "notes"
                ? new NoteKindCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.kind,
                      info.project && info.projectPath
                          ? { name: info.project, path: info.projectPath }
                          : null
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

    async rollTodos() {
        try {
            await this.cache.populate();
            const moved = await rollTodosForward(this);
            new Notice(
                `Full Calendar: rolled ${moved} unfinished TODO(s) forward to today.`
            );
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
    /**
     * Open the tray or the memo as a pane of its own (or reveal the one
     * already open). It starts in a sidebar — tray left, memo right — and
     * can be dragged anywhere from there.
     */
    async openPane(
        type:
            | typeof FULL_CALENDAR_TRAY_VIEW_TYPE
            | typeof FULL_CALENDAR_MEMO_VIEW_TYPE
    ) {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(type);
        if (existing.length > 0) {
            workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf =
            type === FULL_CALENDAR_TRAY_VIEW_TYPE
                ? workspace.getLeftLeaf(false)
                : workspace.getRightLeaf(false);
        await leaf.setViewState({ type, active: true });
        workspace.revealLeaf(leaf);
    }

    /**
     * What is being worked on, where it can always be seen: the running
     * line and how long it has run, or — with nothing running — the line
     * the start key would start. Clicking it is that key. Desktop only
     * (phones have no status bar).
     */
    private statusCallback: UpdateViewCallback | null = null;

    private setupStatusBar() {
        if (Platform.isMobile) {
            return;
        }
        const el = this.addStatusBarItem();
        el.addClass("ofc-status", "mod-clickable");
        el.onclick = () => startOrStop(this);
        // A task's line is just its link; show the task's title instead.
        const label = (title: string) => {
            const link = soleLinktext(title);
            const task = link
                ? collectTaskCards(this).find(
                      (c) => linktextForEvent(this, c.id) === link
                  )
                : undefined;
            const text = plainTitle(task?.event.title || title);
            return text.length > 32 ? text.slice(0, 31) + "…" : text;
        };
        const paint = () => {
            try {
                const running = findRunningSessions(this);
                const session = running[0];
                el.toggleClass("ofc-status-running", !!session);
                if (
                    session &&
                    session.event.type === "single" &&
                    !session.event.allDay
                ) {
                    const start = DateTime.fromISO(
                        `${session.event.date}T${session.event.startTime}`
                    );
                    const minutes = Math.max(
                        0,
                        Math.floor(
                            DateTime.now().diff(start, "minutes").minutes
                        )
                    );
                    const elapsed =
                        minutes >= 60
                            ? `${Math.floor(minutes / 60)}:${String(
                                  minutes % 60
                              ).padStart(2, "0")}`
                            : `${minutes}分`;
                    el.setText(`● ${label(session.event.title)}  ${elapsed}`);
                    el.setAttr("aria-label", "押すと止まる");
                    return;
                }
                const next = nextRow(collectTodayRows(this), running);
                el.setText(next ? `次：${label(next.title)}` : "");
                el.setAttr("aria-label", next ? "押すと始まる" : "");
            } catch (e) {
                // Painted again on the next tick; a status line must never
                // be what breaks the plugin.
                console.debug(e);
            }
        };
        this.statusCallback = this.cache.on("update", paint);
        this.registerInterval(window.setInterval(paint, 30 * 1000));
        paint();
    }

    /**
     * Close the tray or memo pane so the calendar shows its built-in column
     * again. The calendar also notices on its own (layout-change), but that
     * event isn't guaranteed to follow a detach right away — tell it.
     */
    returnPane(
        type:
            | typeof FULL_CALENDAR_TRAY_VIEW_TYPE
            | typeof FULL_CALENDAR_MEMO_VIEW_TYPE
    ) {
        const { workspace } = this.app;
        workspace.detachLeavesOfType(type);
        for (const leaf of workspace.getLeavesOfType(FULL_CALENDAR_VIEW_TYPE)) {
            (leaf.view as CalendarView).syncPoppedPanels?.();
        }
    }

    /**
     * One key between the two surfaces: on the board, back to the calendar;
     * anywhere else, to the board. The board is for deciding and the
     * calendar for doing, so going there and coming back should cost
     * nothing.
     */
    async toggleKanban() {
        const { workspace } = this.app;
        if (workspace.getActiveViewOfType(KanbanView)) {
            const calendar = workspace.getLeavesOfType(
                FULL_CALENDAR_VIEW_TYPE
            )[0];
            if (calendar) {
                workspace.revealLeaf(calendar);
                workspace.setActiveLeaf(calendar, { focus: true });
            } else {
                await this.activateView();
            }
            return;
        }
        await this.activateKanbanView();
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
        // What the core has to say is shown as Obsidian's toasts.
        setNotifier((message) => new Notice(message));
        await this.loadSettings();
        // Where daily notes live comes from the vault's own daily-notes
        // settings; everything that reads a daily note needs it first.
        await loadDailySettings(this.io);

        // Migrate existing sources to the current color palette before the
        // first cache build. Persist with saveData (not saveSettings) to
        // avoid the cache-reset Notice during startup.
        if (this.migrateSourceColors()) {
            await this.saveData(this.settings);
        }

        this.resetCache();

        // TODO rollover is MANUAL-ONLY (the "Roll unfinished TODOs forward"
        // command). Running it automatically made unrelated edits look like
        // lines vanishing — unchecked TODOs now stay on their own day until
        // the user asks. Only the task-`actual` reconcile runs at startup.
        this.app.workspace.onLayoutReady(async () => {
            try {
                // A new daily note starts with the routine's blocks in its
                // Plan. Waits a moment so whatever created the note (the
                // daily-notes template, a sync) has finished writing it;
                // fillPlan then only acts on a Plan that is still empty, so
                // a note that arrives already planned is left alone.
                this.registerEvent(
                    this.app.vault.on("create", (file) => {
                        if (!(file instanceof TFile) || !dailyDateOf(file)) {
                            return;
                        }
                        window.setTimeout(() => {
                            fillPlanFor(this, file).catch((e) =>
                                console.error(e)
                            );
                        }, 1500);
                    })
                );
                this.setupStatusBar();
                this.rebuildIfProjectsChanged();
                // Today always has its note: created a little after start-up
                // and, for an app left open overnight, soon after midnight.
                // Desktop only — a phone opened in the morning hasn't synced
                // yet, and creating the same day's note on two devices
                // leaves a conflict copy. The wait gives sync a head start
                // here too.
                if (!Platform.isMobile) {
                    window.setTimeout(() => ensureTodayNote(this), 10 * 1000);
                    this.registerInterval(
                        window.setInterval(
                            () => ensureTodayNote(this),
                            5 * 60 * 1000
                        )
                    );
                }
                await this.cache.populate();
            } catch (e) {
                console.error("Full Calendar: start-up failed.", e);
            }
        });

        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                this.cache.fileUpdated(file);
                // A project note appearing, changing colour, or ceasing to
                // be one changes which calendars exist.
                this.rebuildIfProjectsChanged();
            })
        );
        // Once the vault's metadata is fully read (start-up), the project
        // notes can all be seen.
        this.registerEvent(
            this.app.metadataCache.on("resolved", () =>
                this.rebuildIfProjectsChanged()
            )
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
                    // The note is still there under its new path: read it
                    // again rather than dropping it until the next restart.
                    this.cache.fileUpdated(file);
                    this.rebuildIfProjectsChanged();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile) {
                    console.debug("FILE DELETED", file.path);
                    this.rebuildIfProjectsChanged();
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

        this.registerView(
            FULL_CALENDAR_TRAY_VIEW_TYPE,
            (leaf) => new TrayView(leaf, this)
        );

        this.registerView(
            FULL_CALENDAR_MEMO_VIEW_TYPE,
            (leaf) => new MemoView(leaf, this)
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
                this.resetCache();
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

        // Start and stop without aiming: the list says what comes next.
        this.addCommand({
            id: "full-calendar-start-or-stop",
            name: "Start the next line / stop the running one",
            callback: async () => {
                const result = await startOrStop(this);
                if (result === "nothing") {
                    new Notice("今日のリストに、始める行がありません。");
                }
            },
        });

        this.addCommand({
            id: "full-calendar-done-and-next",
            name: "Finish the running line and start the next",
            callback: async () => {
                const result = await doneAndNext(this);
                if (result === "finished") {
                    new Notice("今日のリストは、これで全部です。");
                } else if (result === "nothing") {
                    new Notice("今日のリストに、始める行がありません。");
                }
            },
        });

        this.addCommand({
            id: "full-calendar-pick-and-start",
            name: "Pick something and start it",
            callback: async () => {
                const title = await pickTrayTask(
                    this,
                    DateTime.now().toISODate()
                );
                if (!title) {
                    return;
                }
                // A task picked to work on now IS on today's list; say so
                // in the note. (A hand is time, not a thing to do — it gets
                // no line, only its session.)
                const link = soleLinktext(title);
                if (
                    link &&
                    collectTaskCards(this).some(
                        (c) => linktextForEvent(this, c.id) === link
                    )
                ) {
                    await addTaskToToday(this, link);
                }
                await startSession(this, title);
            },
        });

        this.addCommand({
            id: "full-calendar-confirm-plan",
            name: "Confirm past plan blocks into the log",
            callback: async () => {
                const file = targetDailyNote(this);
                if (!file) {
                    new Notice("今日の daily がまだありません。");
                    return;
                }
                await confirmPlanFor(this, file);
            },
        });

        this.addCommand({
            id: "full-calendar-fill-plan",
            name: "Fill the plan from the routine",
            callback: async () => {
                const file = targetDailyNote(this);
                if (!file) {
                    new Notice("今日の daily がまだありません。");
                    return;
                }
                const n = await fillPlanFor(this, file);
                new Notice(
                    n > 0
                        ? `Plan に決まった枠を ${n} 本入れました。`
                        : "入れる枠はありません（Plan がもう埋まっているか、routine のノートがありません）。"
                );
            },
        });

        this.addCommand({
            id: "full-calendar-toggle-kanban",
            name: "Go to the kanban board / back to the calendar",
            callback: () => this.toggleKanban(),
        });

        this.addCommand({
            id: "full-calendar-open-tray-pane",
            name: "Open today and this week as a pane",
            callback: () => this.openPane(FULL_CALENDAR_TRAY_VIEW_TYPE),
        });

        this.addCommand({
            id: "full-calendar-open-memo-pane",
            name: "Open memo as a pane",
            callback: () => this.openPane(FULL_CALENDAR_MEMO_VIEW_TYPE),
        });

        this.addCommand({
            id: "full-calendar-return-tray-pane",
            name: "Return today and this week to the calendar",
            callback: () => this.returnPane(FULL_CALENDAR_TRAY_VIEW_TYPE),
        });

        this.addCommand({
            id: "full-calendar-return-memo-pane",
            name: "Return memo to the calendar",
            callback: () => this.returnPane(FULL_CALENDAR_MEMO_VIEW_TYPE),
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
        if (this.statusCallback) {
            this.cache.off("update", this.statusCallback);
            this.statusCallback = null;
        }
        this.reminderService.stop();
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_SIDEBAR_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_KANBAN_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_TRAY_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FULL_CALENDAR_MEMO_VIEW_TYPE);
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
        if (this.retireFolderSettings()) {
            await this.saveData(this.settings);
        }
    }

    /**
     * Settings from before tasks and issues were found by `kind`: the
     * per-project task folders and the issues folder saved as calendar
     * sources, and the keys that managed them. Dropped once, on load;
     * returns whether anything was (so the caller saves).
     */
    private retireFolderSettings(): boolean {
        const old = this.settings as unknown as Record<string, unknown>;
        const issuesFolder =
            typeof old.issuesFolder === "string" ? old.issuesFolder.trim() : "";
        const before = this.settings.calendarSources.length;
        this.settings.calendarSources = this.settings.calendarSources.filter(
            (s) =>
                !(
                    s.type === "local" &&
                    (s.directory.endsWith("/tasks") ||
                        (issuesFolder !== "" && s.directory === issuesFolder))
                )
        );
        let changed = this.settings.calendarSources.length !== before;
        for (const key of [
            "autoTaskFolder",
            "issuesFolder",
            "dismissedAutoFolders",
            "trayOrder",
        ]) {
            if (key in old) {
                delete old[key];
                changed = true;
            }
        }
        return changed;
    }

    async saveSettings() {
        new Notice("Resetting the event cache with new settings...");
        await this.saveData(this.settings);
        this.resetCache();
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
    async saveTrayState() {
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
     * The calendar source id the issues folder registers under, or null when
     * the feature is off. Card collectors use this to keep issues off the
     * task board/tray and on the kanban's Issue axis.
     */
    issuesSourceId(): string | null {
        return ISSUES_SOURCE_ID;
    }

    /**
     * The calendars that come from the vault itself rather than from
     * settings: one per project note (`kind: project`) for that project's
     * tasks, in the project's own colour, and one for the issues. Projects
     * are found wherever they are; archived and template notes are skipped.
     */
    private derivedSources(): CalendarInfo[] {
        const taken = this.settings.calendarSources.map((s) => s.color);
        const projects: CalendarInfo[] = [];
        const files = this.app.vault
            .getMarkdownFiles()
            .filter((f) => !isSetAside(f.path))
            .sort((a, b) => a.path.localeCompare(b.path));
        for (const file of files) {
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (fm?.kind !== "project") {
                continue;
            }
            const color =
                typeof fm.color === "string" && fm.color
                    ? fm.color
                    : nextSourceColor(taken);
            taken.push(color);
            projects.push({
                type: "notes",
                kind: "task",
                project: file.basename,
                projectPath: file.path,
                color,
            });
        }
        return [
            ...projects,
            { type: "notes", kind: "issue", color: ISSUES_COLOR },
        ];
    }

    /**
     * Every calendar the cache should hold: the derived ones first (so a
     * project is what the create dialog offers by default), then the ones
     * set up in settings (other calendars, the daily note's headings), plus
     * Plan.
     */
    private effectiveSources(): CalendarInfo[] {
        return withPlanSource([
            ...this.derivedSources(),
            ...this.settings.calendarSources,
        ]);
    }

    // What the derived calendars were built from, to tell when the vault's
    // projects have changed (a project added, renamed, recoloured, archived).
    private derivedSignature = "";

    private resetCache() {
        this.derivedSignature = JSON.stringify(this.derivedSources());
        this.cache.reset(this.effectiveSources());
    }

    private rebuildTimer: number | null = null;

    /** Rebuild the calendars if the set of projects is no longer what the
     * cache was built from. Cheap to call; debounced. */
    private rebuildIfProjectsChanged() {
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
        }
        this.rebuildTimer = window.setTimeout(async () => {
            this.rebuildTimer = null;
            if (
                JSON.stringify(this.derivedSources()) === this.derivedSignature
            ) {
                return;
            }
            this.resetCache();
            await this.cache.populate();
            this.cache.resync();
        }, 500);
    }
}
