import { MarkdownRenderer, Notice, setIcon } from "obsidian";
import type FullCalendarPlugin from "../main";
import {
    memoForDisplay,
    readTodayMemo,
    saveTodayMemo,
    todayNotePath,
} from "../core/memo";

/*
 * メモ: today's memo section in full, as written in the daily note. Clicking
 * the text turns the whole section into an editor that saves as the typing
 * pauses (and on blur or ⌘/Ctrl+Enter; Esc closes it).
 *
 * The panel owns its element and never rebuilds a focused editor: redrawing
 * a focused field drops the caret and breaks a Japanese conversion in
 * progress. Whoever hosts it (the column beside the calendar on desktop,
 * the list on mobile) must keep the element in place across its own redraws.
 */

export type MemoPanel = { reload: () => void; destroy: () => void };

type Edit = {
    // The memo as the note last had it — what a save checks against.
    original: string;
    // The editor's text at the last save (or at open).
    saved: string;
    text: string;
};

export function renderMemoPanel(
    plugin: FullCalendarPlugin,
    el: HTMLElement,
    opts: { onPopOut?: () => void; onPopIn?: () => void } = {}
): MemoPanel {
    el.addClass("ofc-tray-memo");
    const head = el.createDiv({ cls: "ofc-tray-section" });
    head.createSpan({ text: "メモ" });
    const tools = head.createDiv({ cls: "ofc-tray-tools" });
    if (opts.onPopOut) {
        const popBtn = tools.createEl("button", {
            cls: "ofc-row-btn ofc-row-btn-quiet",
        });
        setIcon(popBtn, "arrow-up-right");
        popBtn.setAttr("aria-label", "別のペインに出す");
        popBtn.onclick = (ev) => {
            ev.stopPropagation();
            opts.onPopOut?.();
        };
    }
    if (opts.onPopIn) {
        const backBtn = tools.createEl("button", {
            cls: "ofc-row-btn ofc-row-btn-quiet",
        });
        setIcon(backBtn, "arrow-down-left");
        backBtn.setAttr("aria-label", "カレンダーに戻す");
        backBtn.onclick = (ev) => {
            ev.stopPropagation();
            opts.onPopIn?.();
        };
    }
    const openBtn = tools.createEl("button", {
        cls: "ofc-row-btn ofc-row-btn-quiet",
    });
    setIcon(openBtn, "external-link");
    openBtn.setAttr("aria-label", "daily を開く");
    const view = el.createDiv({ cls: "ofc-tray-memo-body" });

    let edit: Edit | null = null;
    let shown: { body: string; path: string | null } = {
        body: "",
        path: null,
    };
    let loads = 0;

    openBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (shown.path) {
            plugin.app.workspace.openLinkText(shown.path, "", "tab");
        }
    };

    const paint = () => {
        openBtn.toggle(!!shown.path);
        if (edit) {
            return;
        }
        view.empty();
        if (!shown.body) {
            view.createDiv({
                cls: "ofc-tray-empty",
                text: "ここを押してメモを書く。",
            });
            return;
        }
        MarkdownRenderer.renderMarkdown(
            memoForDisplay(shown.body),
            view,
            shown.path ?? "",
            plugin
        );
    };

    const reload = async () => {
        const mine = ++loads;
        try {
            const next = await readTodayMemo(plugin);
            if (mine === loads) {
                shown = next;
                paint();
            }
        } catch (e) {
            console.error(e);
        }
    };

    const openEditor = (body: string) => {
        const current: Edit = { original: body, saved: body, text: body };
        edit = current;
        view.empty();
        const area = view.createEl("textarea", {
            cls: "ofc-tray-memo-editor",
            attr: { "aria-label": "メモ", spellcheck: "false" },
        });
        area.value = current.text;
        const fit = () => {
            area.style.height = "auto";
            area.style.height = `${area.scrollHeight + 2}px`;
        };

        // Saving: a moment after the typing pauses, and again on the way
        // out. Saves run one at a time so each checks against what the
        // previous one wrote.
        let saveTimer: number | null = null;
        let composing = false;
        let saving: Promise<boolean> = Promise.resolve(true);
        let warned = false;
        const save = (): Promise<boolean> => {
            saving = saving.then(async () => {
                const text = current.text;
                if (text === current.saved) {
                    return true;
                }
                let now: string | null = null;
                try {
                    now = await saveTodayMemo(plugin, current.original, text);
                } catch (e) {
                    console.error(e);
                }
                if (now === null) {
                    // Nothing was written; the typed text stays in the field
                    // so it can be copied out.
                    if (!warned) {
                        warned = true;
                        new Notice(
                            "メモは保存していません。daily の側でメモが書き換わっています。"
                        );
                    }
                    return false;
                }
                warned = false;
                current.original = now;
                current.saved = text;
                return true;
            });
            return saving;
        };
        const scheduleSave = () => {
            if (saveTimer !== null) {
                window.clearTimeout(saveTimer);
            }
            saveTimer = window.setTimeout(() => {
                saveTimer = null;
                if (!composing) {
                    save();
                }
            }, 600);
        };
        const finish = async (keep: boolean) => {
            if (edit !== current) {
                return;
            }
            if (saveTimer !== null) {
                window.clearTimeout(saveTimer);
                saveTimer = null;
            }
            // Esc drops only what hasn't been saved yet; what the pauses
            // already wrote stays written.
            if (keep && !(await save())) {
                return;
            }
            if (edit !== current) {
                return;
            }
            edit = null;
            await reload();
        };

        area.addEventListener("compositionstart", () => {
            composing = true;
        });
        area.addEventListener("compositionend", () => {
            composing = false;
            current.text = area.value;
            scheduleSave();
        });
        area.oninput = () => {
            current.text = area.value;
            fit();
            scheduleSave();
        };
        area.onkeydown = (ev) => {
            if (ev.key === "Escape") {
                ev.preventDefault();
                finish(false);
            } else if (
                ev.key === "Enter" &&
                (ev.metaKey || ev.ctrlKey) &&
                !ev.isComposing
            ) {
                ev.preventDefault();
                finish(true);
            } else if (ev.key === "Tab" && !ev.isComposing) {
                // Tab indents the bullet instead of leaving the field.
                ev.preventDefault();
                const at = area.selectionStart;
                const lineStart = area.value.lastIndexOf("\n", at - 1) + 1;
                if (ev.shiftKey) {
                    const m = area.value.slice(lineStart).match(/^( {1,4}|\t)/);
                    if (m) {
                        area.setRangeText(
                            "",
                            lineStart,
                            lineStart + m[0].length
                        );
                        area.selectionStart = area.selectionEnd = Math.max(
                            lineStart,
                            at - m[0].length
                        );
                    }
                } else {
                    area.setRangeText("    ", lineStart, lineStart);
                    area.selectionStart = area.selectionEnd = at + 4;
                }
                current.text = area.value;
                scheduleSave();
            }
        };
        area.onblur = () => {
            // Being detached fires blur too; that is not the user leaving.
            if (area.isConnected) {
                finish(true);
            }
        };
        fit();
        area.focus();
        area.selectionStart = area.selectionEnd = area.value.length;
    };

    view.onclick = async (ev) => {
        if (edit) {
            return;
        }
        const target = ev.target as HTMLElement;
        const link = target.closest("a") as HTMLAnchorElement | null;
        if (link) {
            // Links work as links; everything else opens the editor.
            if (link.hasClass("internal-link")) {
                ev.preventDefault();
                plugin.app.workspace.openLinkText(
                    link.getAttr("data-href") ?? link.getAttr("href") ?? "",
                    shown.path ?? "",
                    ev.metaKey || ev.ctrlKey ? "tab" : false
                );
            }
            return;
        }
        if (window.getSelection()?.toString()) {
            return;
        }
        // Open on what the note says NOW, not on what was drawn a while ago.
        let body = shown.body;
        try {
            const fresh = await readTodayMemo(plugin);
            shown = fresh;
            body = fresh.body;
        } catch (e) {
            console.error(e);
        }
        if (!edit) {
            openEditor(body);
        }
    };

    // The daily note changed (typed in the note, synced from the phone):
    // show it now. Memo text isn't an event, so the cache never announces it.
    // "create" covers the day's note appearing after the panel was drawn.
    let timer: number | null = null;
    const onChange = (file: { path: string }) => {
        if (edit || file.path !== todayNotePath()) {
            return;
        }
        if (timer !== null) {
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
            timer = null;
            if (!edit) {
                reload();
            }
        }, 150);
    };
    const refs = [
        plugin.app.vault.on("modify", onChange),
        plugin.app.vault.on("create", onChange),
    ];

    reload();
    return {
        reload: () => {
            if (!edit) {
                reload();
            }
        },
        destroy: () => {
            refs.forEach((r) => plugin.app.vault.offref(r));
            if (timer !== null) {
                window.clearTimeout(timer);
            }
        },
    };
}
