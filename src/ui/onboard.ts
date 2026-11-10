import { App } from "obsidian";
import FullCalendarPlugin from "../main";
import { addCalendarButton } from "./settings";
import { CalendarInfo } from "../types";

export function renderOnboarding(
    app: App,
    plugin: FullCalendarPlugin,
    el: HTMLElement
) {
    el.style.height = "100%";
    const nocal = el.createDiv();
    nocal.style.height = "100%";
    nocal.style.display = "flex";
    nocal.style.alignItems = "center";
    nocal.style.justifyContent = "center";
    const notice = nocal.createDiv();
    notice.createEl("h1").textContent = "カレンダーがまだない";
    notice.createEl("p").textContent = "下のボタンでカレンダーを足す。";

    const container = notice.createDiv();
    container.style.position = "fixed";
    addCalendarButton(app, plugin, container, async (source: CalendarInfo) => {
        const { calendarSources } = plugin.settings;
        calendarSources.push(source);
        await plugin.saveSettings();
        await plugin.activateView();
    });
}
