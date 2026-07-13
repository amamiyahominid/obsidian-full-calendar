import FullCalendarPlugin from "../main";
import {
    App,
    DropdownComponent,
    Notice,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from "obsidian";
import { makeDefaultPartialCalendarSource, CalendarInfo } from "../types";
import {
    configureStatuses,
    DEFAULT_STATUSES,
    DEFAULT_UNCHECK_STATUS,
    nextSourceColor,
    StatusDef,
} from "./colors";
import { CalendarSettings } from "./components/CalendarSetting";
import { AddCalendarSource } from "./components/AddCalendarSource";
import * as ReactDOM from "react-dom";
import { createElement } from "react";
import { getDailyNoteSettings } from "obsidian-daily-notes-interface";
import ReactModal from "./ReactModal";
import { importCalendars } from "src/calendars/parsing/caldav/import";

export interface FullCalendarSettings {
    calendarSources: CalendarInfo[];
    defaultCalendar: number;
    firstDay: number;
    initialView: {
        desktop: string;
        mobile: string;
    };
    timeFormat24h: boolean;
    clickToCreateEventFromMonthView: boolean;
    // Folder that is auto-registered as a "Full note" calendar source. Empty
    // string disables the feature.
    autoTaskFolder: string;
    // Auto-folders the user manually removed from the calendar list — never
    // re-added automatically until they re-select the folder in settings.
    dismissedAutoFolders: string[];
    // Fire a native OS notification before timed events start. Desktop-only.
    enableReminders: boolean;
    // How many minutes before an event's start to notify.
    reminderMinutesBefore: number;
    // Kanban board filters, persisted across sessions with a light save (no
    // cache reset). `sprint` is "all" | "current" | "none" | a literal
    // "YYYY-Www" week; `project` is a calendar ID or null for all. `groupBy`
    // picks the board axis; it's optional because loadSettings() merges
    // shallowly, so a data.json saved before this field existed yields a
    // kanbanFilters object without it — readers fall back to "status".
    kanbanFilters: {
        project: string | null;
        sprint: string;
        hideDone: boolean;
        groupBy?: "status" | "sprint";
    };
    // Width of the task tray beside the calendar, in px. Set by dragging the
    // tray's resize handle.
    trayWidth: number;
    // Manual tray order, keyed by sprint week ("2026-W28"). Entries are task
    // linktexts, or divider labels prefixed with ":" (a character that can't
    // appear in note filenames). Only the current week's key is kept.
    trayOrder: Record<string, string[]>;
    // Workflow stages in kanban column order, with their fill colors. The
    // LAST stage counts as "done" (checked on the calendar). Renaming a
    // stage does NOT rewrite existing task notes — unknown statuses surface
    // as extra kanban columns rather than disappearing.
    statuses: StatusDef[];
    // The stage a task returns to when its checkbox is unticked.
    uncheckStatus: string;
}

export const DEFAULT_SETTINGS: FullCalendarSettings = {
    calendarSources: [],
    defaultCalendar: 0,
    firstDay: 0,
    initialView: {
        desktop: "timeGridWeek",
        mobile: "timeGrid3Days",
    },
    timeFormat24h: false,
    clickToCreateEventFromMonthView: true,
    autoTaskFolder: "",
    dismissedAutoFolders: [],
    enableReminders: false,
    reminderMinutesBefore: 10,
    kanbanFilters: {
        project: null,
        sprint: "all",
        hideDone: false,
        groupBy: "status",
    },
    trayWidth: 220,
    trayOrder: {},
    statuses: DEFAULT_STATUSES,
    uncheckStatus: DEFAULT_UNCHECK_STATUS,
};

const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

const INITIAL_VIEW_OPTIONS = {
    DESKTOP: {
        timeGridDay: "Day",
        timeGridWeek: "Week",
        dayGridMonth: "Month",
        listWeek: "List",
    },
    MOBILE: {
        timeGrid3Days: "3 Days",
        timeGridDay: "Day",
        listWeek: "List",
    },
};

export function addCalendarButton(
    app: App,
    plugin: FullCalendarPlugin,
    containerEl: HTMLElement,
    submitCallback: (setting: CalendarInfo) => void,
    listUsedDirectories?: () => string[]
) {
    let dropdown: DropdownComponent;
    const directories = app.vault
        .getAllLoadedFiles()
        .filter((f) => f instanceof TFolder)
        .map((f) => f.path);

    return new Setting(containerEl)
        .setName("Calendars")
        .setDesc("Add calendar")
        .addDropdown(
            (d) =>
                (dropdown = d.addOptions({
                    local: "Full note",
                    dailynote: "Daily Note",
                    dailytodo: "Daily Note TODOs",
                    icloud: "iCloud",
                    caldav: "CalDAV",
                    ical: "Remote (.ics format)",
                }))
        )
        .addExtraButton((button) => {
            button.setTooltip("Add Calendar");
            button.setIcon("plus-with-circle");
            button.onClick(() => {
                let modal = new ReactModal(app, async () => {
                    await plugin.loadSettings();
                    const usedDirectories = (
                        listUsedDirectories
                            ? listUsedDirectories
                            : () =>
                                  plugin.settings.calendarSources
                                      .map(
                                          (s) =>
                                              s.type === "local" && s.directory
                                      )
                                      .filter((s): s is string => !!s)
                    )();
                    let headings: string[] = [];
                    let { template } = getDailyNoteSettings();

                    if (template) {
                        if (!template.endsWith(".md")) {
                            template += ".md";
                        }
                        const file = app.vault.getAbstractFileByPath(template);
                        if (file instanceof TFile) {
                            headings =
                                app.metadataCache
                                    .getFileCache(file)
                                    ?.headings?.map((h) => h.heading) || [];
                        }
                    }

                    return createElement(AddCalendarSource, {
                        source: {
                            ...makeDefaultPartialCalendarSource(
                                dropdown.getValue() as
                                    | CalendarInfo["type"]
                                    | "icloud"
                                    | "dailytodo"
                            ),
                            // Default to the next unused palette color (muted
                            // for ical, vivid otherwise) so newly added sources
                            // are visually distinct and on-theme out of the box.
                            color: nextSourceColor(
                                plugin.settings.calendarSources.map(
                                    (s) => s.color
                                ),
                                dropdown.getValue()
                            ),
                        },
                        directories: directories.filter(
                            (dir) => usedDirectories.indexOf(dir) === -1
                        ),
                        headings,
                        submit: async (source: CalendarInfo) => {
                            if (source.type === "caldav") {
                                try {
                                    let sources = await importCalendars(
                                        {
                                            type: "basic",
                                            username: source.username,
                                            password: source.password,
                                        },
                                        source.url
                                    );
                                    sources.forEach((source) =>
                                        submitCallback(source)
                                    );
                                } catch (e) {
                                    if (e instanceof Error) {
                                        new Notice(e.message);
                                    }
                                }
                            } else {
                                submitCallback(source);
                            }
                            modal.close();
                        },
                    });
                });
                modal.open();
            });
        });
}

export class FullCalendarSettingTab extends PluginSettingTab {
    plugin: FullCalendarPlugin;

    constructor(app: App, plugin: FullCalendarPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Calendar Preferences" });
        new Setting(containerEl)
            .setName("Desktop Initial View")
            .setDesc("Choose the initial view range on desktop devices.")
            .addDropdown((dropdown) => {
                Object.entries(INITIAL_VIEW_OPTIONS.DESKTOP).forEach(
                    ([value, display]) => {
                        dropdown.addOption(value, display);
                    }
                );
                dropdown.setValue(this.plugin.settings.initialView.desktop);
                dropdown.onChange(async (initialView) => {
                    this.plugin.settings.initialView.desktop = initialView;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Mobile Initial View")
            .setDesc("Choose the initial view range on mobile devices.")
            .addDropdown((dropdown) => {
                Object.entries(INITIAL_VIEW_OPTIONS.MOBILE).forEach(
                    ([value, display]) => {
                        dropdown.addOption(value, display);
                    }
                );
                dropdown.setValue(this.plugin.settings.initialView.mobile);
                dropdown.onChange(async (initialView) => {
                    this.plugin.settings.initialView.mobile = initialView;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Starting Day of the Week")
            .setDesc("Choose what day of the week to start.")
            .addDropdown((dropdown) => {
                WEEKDAYS.forEach((day, code) => {
                    dropdown.addOption(code.toString(), day);
                });
                dropdown.setValue(this.plugin.settings.firstDay.toString());
                dropdown.onChange(async (codeAsString) => {
                    this.plugin.settings.firstDay = Number(codeAsString);
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("24-hour format")
            .setDesc("Display the time in a 24-hour format.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.timeFormat24h);
                toggle.onChange(async (val) => {
                    this.plugin.settings.timeFormat24h = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Click on a day in month view to create event")
            .setDesc("Switch off to open day view on click instead.")
            .addToggle((toggle) => {
                toggle.setValue(
                    this.plugin.settings.clickToCreateEventFromMonthView
                );
                toggle.onChange(async (val) => {
                    this.plugin.settings.clickToCreateEventFromMonthView = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Auto-managed Task Folder")
            .setDesc(
                "Automatically register this folder as a Full note calendar. " +
                    "Removing it from the calendar list below won't bring it back; " +
                    "re-select it here to re-enable."
            )
            .addDropdown((dropdown) => {
                dropdown.addOption("", "(None)");
                this.app.vault
                    .getAllLoadedFiles()
                    .filter((f) => f instanceof TFolder)
                    .forEach((f) => dropdown.addOption(f.path, f.path));
                dropdown.setValue(this.plugin.settings.autoTaskFolder || "");
                dropdown.onChange(async (folder) => {
                    this.plugin.settings.autoTaskFolder = folder;
                    if (folder) {
                        // Re-selecting a folder clears any prior dismissal.
                        this.plugin.settings.dismissedAutoFolders =
                            this.plugin.settings.dismissedAutoFolders.filter(
                                (p) => p !== folder
                            );
                        this.plugin.syncAutoTaskFolder();
                    }
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        containerEl.createEl("h2", { text: "Reminders" });
        new Setting(containerEl)
            .setName("Notify before events start")
            .setDesc(
                "Show a native OS notification before timed events begin. " +
                    "Desktop only — Obsidian must be running. Covers all " +
                    "calendars, including recurring and remote (ical) events."
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.enableReminders);
                toggle.onChange(async (val) => {
                    this.plugin.settings.enableReminders = val;
                    await this.plugin.saveReminderSettings();
                });
            });

        new Setting(containerEl)
            .setName("Minutes before")
            .setDesc("How many minutes before the start time to notify.")
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.setValue(
                    this.plugin.settings.reminderMinutesBefore.toString()
                );
                text.onChange(async (val) => {
                    const parsed = parseInt(val, 10);
                    if (!Number.isFinite(parsed) || parsed < 0) {
                        return;
                    }
                    this.plugin.settings.reminderMinutesBefore = parsed;
                    await this.plugin.saveReminderSettings();
                });
            });

        containerEl.createEl("h2", { text: "Workflow statuses" });
        containerEl.createEl("p", {
            cls: "setting-item-description",
            text: "Stages in kanban column order. The last stage counts as done. Renaming a stage does not rewrite existing notes — old values show up as extra columns.",
        });
        // Persist + apply without the full cache reset: statuses only affect
        // how things render, so a light save and a view resync suffice.
        const applyStatuses = async (rerender: boolean) => {
            await this.plugin.saveData(this.plugin.settings);
            configureStatuses(
                this.plugin.settings.statuses,
                this.plugin.settings.uncheckStatus
            );
            this.plugin.cache.resync();
            if (rerender) {
                this.display();
            }
        };
        this.plugin.settings.statuses.forEach((status, idx) => {
            const row = new Setting(containerEl);
            row.addText((text) => {
                text.setValue(status.name).onChange(async (val) => {
                    this.plugin.settings.statuses[idx].name = val;
                    await applyStatuses(false);
                });
            });
            row.addColorPicker((picker) => {
                picker.setValue(status.color).onChange(async (val) => {
                    this.plugin.settings.statuses[idx].color = val;
                    await applyStatuses(false);
                });
            });
            row.addExtraButton((btn) => {
                btn.setIcon("arrow-up")
                    .setTooltip("Move up")
                    .setDisabled(idx === 0)
                    .onClick(async () => {
                        const statuses = this.plugin.settings.statuses;
                        [statuses[idx - 1], statuses[idx]] = [
                            statuses[idx],
                            statuses[idx - 1],
                        ];
                        await applyStatuses(true);
                    });
            });
            row.addExtraButton((btn) => {
                btn.setIcon("trash")
                    .setTooltip("Remove")
                    .setDisabled(this.plugin.settings.statuses.length <= 1)
                    .onClick(async () => {
                        this.plugin.settings.statuses.splice(idx, 1);
                        await applyStatuses(true);
                    });
            });
        });
        new Setting(containerEl).addButton((btn) => {
            btn.setButtonText("Add status").onClick(async () => {
                this.plugin.settings.statuses.push({
                    name: "New status",
                    color: "#cccccc",
                });
                await applyStatuses(true);
            });
        });
        new Setting(containerEl)
            .setName("Status after unchecking")
            .setDesc(
                "The stage a task returns to when its checkbox is unticked on the calendar."
            )
            .addDropdown((dropdown) => {
                for (const s of this.plugin.settings.statuses) {
                    dropdown.addOption(s.name, s.name);
                }
                dropdown
                    .setValue(this.plugin.settings.uncheckStatus)
                    .onChange(async (val) => {
                        this.plugin.settings.uncheckStatus = val;
                        await applyStatuses(false);
                    });
            });

        containerEl.createEl("h2", { text: "Manage Calendars" });
        addCalendarButton(
            this.app,
            this.plugin,
            containerEl,
            async (source: CalendarInfo) => {
                sourceList.addSource(source);
            },
            () =>
                sourceList.state.sources
                    .map((s) => s.type === "local" && s.directory)
                    .filter((s): s is string => !!s)
        );

        const sourcesDiv = containerEl.createDiv();
        sourcesDiv.style.display = "block";
        let sourceList = ReactDOM.render(
            createElement(CalendarSettings, {
                sources: this.plugin.settings.calendarSources,
                submit: async (settings: CalendarInfo[]) => {
                    // If the user removed the auto-managed folder, remember the
                    // dismissal so it isn't re-added on next launch.
                    const autoFolder =
                        this.plugin.settings.autoTaskFolder?.trim();
                    if (autoFolder) {
                        const stillPresent = settings.some(
                            (s) =>
                                s.type === "local" && s.directory === autoFolder
                        );
                        if (
                            !stillPresent &&
                            !this.plugin.settings.dismissedAutoFolders.includes(
                                autoFolder
                            )
                        ) {
                            this.plugin.settings.dismissedAutoFolders.push(
                                autoFolder
                            );
                        }
                    }
                    this.plugin.settings.calendarSources = settings;
                    await this.plugin.saveSettings();
                },
            }),
            sourcesDiv
        );
    }
}
