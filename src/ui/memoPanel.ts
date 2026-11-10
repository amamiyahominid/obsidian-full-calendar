import { MarkdownRenderer, Notice, setIcon, TFile } from "obsidian";
import { createEmbeddedEditor, EmbeddedEditor } from "./embeddedEditor";
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

/**
 * The memo as an always-open editor. Text is saved a moment after the
 * typing pauses and when the editor loses focus; a change made in the note
 * itself (or synced in) is shown as soon as the editor isn't being typed in.
 */
function mountMemoPage(
    plugin: FullCalendarPlugin,
    view: HTMLElement,
    openBtn: HTMLElement
): MemoPanel | null {
    let path: string | null = todayNotePath();
    const file = () => {
        const f = path ? plugin.app.vault.getAbstractFileByPath(path) : null;
        return f instanceof TFile ? f : null;
    };
    const editor: EmbeddedEditor | null = createEmbeddedEditor(
        plugin.app,
        plugin,
        view,
        file
    );
    if (!editor) {
        return null;
    }
    view.addClass("ofc-memo-page");

    // The memo as the note last had it (what a save checks against), and
    // the editor's text at the last save or load.
    let original = "";
    let saved = "";
    let warned = false;
    let saving: Promise<void> = Promise.resolve();

    openBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (path) {
            plugin.app.workspace.openLinkText(path, "", "tab");
        }
    };

    const load = async () => {
        try {
            const memo = await readTodayMemo(plugin);
            path = memo.path;
            openBtn.toggle(!!path);
            // Never pull the page out from under someone typing on it, or
            // over text that hasn't been saved yet.
            if (editor.hasFocus() || editor.get() !== saved) {
                return;
            }
            original = memo.body;
            saved = memo.body;
            editor.set(memo.body);
        } catch (e) {
            console.error(e);
        }
    };

    const save = () => {
        saving = saving.then(async () => {
            const text = editor.get();
            if (text === saved) {
                return;
            }
            let now: string | null = null;
            try {
                now = await saveTodayMemo(plugin, original, text);
            } catch (e) {
                console.error(e);
            }
            if (now === null) {
                // Nothing was written; the text stays on the page so it
                // can be copied out.
                if (!warned) {
                    warned = true;
                    new Notice(
                        "メモは保存していません。daily の側でメモが書き換わっています。"
                    );
                }
                return;
            }
            warned = false;
            original = now;
            saved = text;
            path = todayNotePath();
            openBtn.toggle(!!path);
        });
        return saving;
    };

    // Typing is noticed by looking, not by hooking the editor: a check
    // twice a second while the page has focus, saving once the text has
    // stopped changing for a beat. Crude, and independent of the editor's
    // internals.
    let lastSeen = "";
    let still = 0;
    const tick = window.setInterval(() => {
        if (!editor.hasFocus()) {
            return;
        }
        const text = editor.get();
        if (text !== lastSeen) {
            lastSeen = text;
            still = 0;
            return;
        }
        if (text !== saved && ++still >= 1) {
            save();
        }
    }, 500);
    const onBlur = () => {
        // focusout fires before the new focus lands; look after it has.
        window.setTimeout(async () => {
            if (!editor.hasFocus()) {
                await save();
                load();
            }
        }, 0);
    };
    view.addEventListener("focusout", onBlur);

    let timer: number | null = null;
    const onChange = (f: { path: string }) => {
        if (f.path !== todayNotePath()) {
            return;
        }
        if (timer !== null) {
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
            timer = null;
            load();
        }, 150);
    };
    const refs = [
        plugin.app.vault.on("modify", onChange),
        plugin.app.vault.on("create", onChange),
    ];

    load();
    return {
        reload: () => {
            load();
        },
        destroy: () => {
            window.clearInterval(tick);
            view.removeEventListener("focusout", onBlur);
            refs.forEach((r) => plugin.app.vault.offref(r));
            if (timer !== null) {
                window.clearTimeout(timer);
            }
            editor.destroy();
        },
    };
}

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

    // First choice: Obsidian's own editor, always open on today's memo —
    // a page to write on, not a field to click into. When that can't be
    // mounted (it rests on Obsidian internals), the rest of this function
    // is the fallback: the memo rendered, and a plain field on click.
    const page = mountMemoPage(plugin, view, openBtn);
    if (page) {
        return page;
    }

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
