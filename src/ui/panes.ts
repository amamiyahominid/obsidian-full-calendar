import { ItemView, WorkspaceLeaf } from "obsidian";
import type FullCalendarPlugin from "../main";
import type { UpdateViewCallback } from "../core/EventCache";
import { MemoPanel, renderMemoPanel } from "./memoPanel";
import { renderTaskTray, TaskTray } from "./tray";

/*
 * The tray and the memo as panes of their own. Obsidian then does the
 * arranging: drag the tab to split it beside the calendar, dock it in a
 * sidebar, stack it, and the workspace remembers. While one of these is
 * open somewhere, the calendar view hides its built-in copy of that column
 * (see CalendarView.syncPoppedPanels) so nothing shows twice.
 *
 * Dragging a card from a tray pane onto the calendar works within one
 * window — FullCalendar's external drag listens on the whole document — but
 * not from a pane moved to a separate window.
 */

export const FULL_CALENDAR_TRAY_VIEW_TYPE = "full-calendar-tray-view";
export const FULL_CALENDAR_MEMO_VIEW_TYPE = "full-calendar-memo-view";

export class TrayView extends ItemView {
    private tray: TaskTray | null = null;
    private callback: UpdateViewCallback | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: FullCalendarPlugin) {
        super(leaf);
    }

    getViewType() {
        return FULL_CALENDAR_TRAY_VIEW_TYPE;
    }

    getDisplayText() {
        return "今日と今週";
    }

    getIcon() {
        return "list-checks";
    }

    async onOpen() {
        this.contentEl.empty();
        const el = this.contentEl.createDiv({
            cls: "ofc-task-tray ofc-task-tray-pane",
        });
        if (!this.plugin.cache.initialized) {
            // Restored panes open before the vault index is complete; the
            // plugin populates the cache on layout-ready, and the update
            // subscription below redraws once events arrive.
            this.app.workspace.onLayoutReady(async () => {
                await this.plugin.cache.populate();
                this.tray?.refresh();
            });
        }
        this.tray = renderTaskTray(this.plugin, el, {
            onPopIn: () => this.plugin.returnPane(FULL_CALENDAR_TRAY_VIEW_TYPE),
        });
        this.callback = this.plugin.cache.on("update", () =>
            this.tray?.refresh()
        );
    }

    async onClose() {
        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
        this.tray?.destroy();
        this.tray = null;
    }
}

export class MemoView extends ItemView {
    private panel: MemoPanel | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: FullCalendarPlugin) {
        super(leaf);
    }

    getViewType() {
        return FULL_CALENDAR_MEMO_VIEW_TYPE;
    }

    getDisplayText() {
        return "メモ";
    }

    getIcon() {
        return "sticky-note";
    }

    async onOpen() {
        this.contentEl.empty();
        const el = this.contentEl.createDiv({
            cls: "ofc-memo-pane ofc-memo-pane-standalone",
        });
        this.panel = renderMemoPanel(this.plugin, el, {
            onPopIn: () => this.plugin.returnPane(FULL_CALENDAR_MEMO_VIEW_TYPE),
        });
    }

    async onClose() {
        this.panel?.destroy();
        this.panel = null;
    }
}
