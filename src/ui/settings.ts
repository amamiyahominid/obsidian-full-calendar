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
import { nextSourceColor } from "./colors";
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
    // Fire a native OS notification before timed events start. Desktop-only.
    enableReminders: boolean;
    // How many minutes before an event's start to notify.
    reminderMinutesBefore: number;
    // Kanban board filters, persisted across sessions with a light save (no
    // cache reset). `sprint` is "all" | "current" | "none" | a literal
    // "YYYY-Www" week; `project` is a calendar ID or null for all. `scope`
    // picks the top-level tab (project tasks vs the issues folder) and
    // `groupBy` the axis within Projects — both survive tab switches.
    // Optional fields because loadSettings() merges shallowly: a data.json
    // saved before they existed yields a kanbanFilters object without them,
    // and readers fall back to "projects"/"status". `groupBy` briefly
    // stored "issue" as a third axis; readers treat that as scope=issue.
    kanbanFilters: {
        project: string | null;
        sprint: string;
        hideDone: boolean;
        groupBy?: "status" | "sprint";
    };
    // Width of the task tray beside the calendar, in px. Set by dragging the
    // tray's resize handle.
    trayWidth: number;
    // Width of the memo column on the calendar's right (desktop).
    memoWidth: number;
    // Tray status groups the user has expanded (keyed by status name).
    // Missing means collapsed — groups exist to get cards out of the way.
    trayExpanded: Record<string, boolean>;
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
    enableReminders: false,
    reminderMinutesBefore: 10,
    kanbanFilters: {
        project: null,
        sprint: "all",
        hideDone: false,
        groupBy: "status",
    },
    trayWidth: 220,
    memoWidth: 300,
    trayExpanded: {},
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
        .setName("カレンダー")
        .setDesc("カレンダーを足す")
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

        containerEl.createEl("h2", { text: "カレンダーの表示" });
        new Setting(containerEl)
            .setName("最初の表示（パソコン）")
            .setDesc("パソコンで開いたときに見せる範囲。")
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
            .setName("最初の表示（スマホ）")
            .setDesc("スマホで開いたときに見せる範囲。")
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
            .setName("週の始まり")
            .setDesc("週を何曜日から始めるか。")
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
            .setName("24時間表記")
            .setDesc("時刻を24時間で出す。")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.timeFormat24h);
                toggle.onChange(async (val) => {
                    this.plugin.settings.timeFormat24h = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("月の表示で、日を押して枠を作る")
            .setDesc("オフにすると、押した日の表示に移る。")
            .addToggle((toggle) => {
                toggle.setValue(
                    this.plugin.settings.clickToCreateEventFromMonthView
                );
                toggle.onChange(async (val) => {
                    this.plugin.settings.clickToCreateEventFromMonthView = val;
                    await this.plugin.saveSettings();
                });
            });

        containerEl.createEl("h2", { text: "知らせ" });
        new Setting(containerEl)
            .setName("始まる前に知らせる")
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
            .setName("何分前に")
            .setDesc("始まりの何分前に知らせるか。")
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

        containerEl.createEl("h2", { text: "カレンダーの管理" });
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
                    this.plugin.settings.calendarSources = settings;
                    await this.plugin.saveSettings();
                },
            }),
            sourcesDiv
        );
    }
}
