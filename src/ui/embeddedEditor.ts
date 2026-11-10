import { App, Component, TFile } from "obsidian";

/*
 * Obsidian's own markdown editor, mounted in an element of ours — link
 * suggestions, list continuation, indenting, the vault's editor settings
 * and theme, instead of a bare <textarea>.
 *
 * Obsidian has no public API for this. The editor class is reached the way
 * other plugins that embed editors reach it: by asking the embed registry
 * for a markdown embed and walking up from its edit mode's prototype. That
 * can change with any Obsidian release, so EVERYTHING here is allowed to
 * fail: `createEmbeddedEditor` returns null, and the caller falls back to a
 * plain field. Nothing outside this file touches the internals.
 */

export type EmbeddedEditor = {
    get: () => string;
    set: (text: string) => void;
    hasFocus: () => boolean;
    focus: () => void;
    destroy: () => void;
};

// Looked up once per session; null after a failed attempt so we don't retry
// (and re-throw) on every panel.
let editorClass: any | null | undefined;

function findEditorClass(app: App): any | null {
    if (editorClass !== undefined) {
        return editorClass;
    }
    try {
        const registry = (app as any).embedRegistry;
        const embed = registry.embedByExtension.md(
            { app, containerEl: createDiv(), state: {} },
            null,
            ""
        );
        embed.load();
        embed.editable = true;
        embed.showEditor();
        const base = Object.getPrototypeOf(
            Object.getPrototypeOf(embed.editMode)
        ).constructor;
        embed.unload();
        editorClass = typeof base === "function" ? base : null;
    } catch (e) {
        console.warn(
            "Full Calendar: Obsidian's editor can't be embedded here; the memo uses a plain field.",
            e
        );
        editorClass = null;
    }
    return editorClass;
}

/**
 * Mount an editor in `containerEl`, owned by `owner` (unloaded with it).
 * `getFile` names the note the text belongs to, so links resolve and
 * suggest as they would inside that note. Null when it can't be done.
 */
export function createEmbeddedEditor(
    app: App,
    owner: Component,
    containerEl: HTMLElement,
    getFile: () => TFile | null
): EmbeddedEditor | null {
    const Base = findEditorClass(app);
    if (!Base) {
        return null;
    }
    let editor: any;
    try {
        class MemoEditor extends Base {
            // The stock editor pads its bottom to let the last line scroll
            // to mid-screen; in a side panel that is just a blank gap.
            updateBottomPadding() {}
        }
        // What the editor expects of the view that hosts it.
        const controller = {
            app,
            showSearch: () => {},
            toggleMode: () => {},
            onMarkdownScroll: () => {},
            getMode: () => "source",
            scroll: 0,
            editMode: null as any,
            get editor() {
                return editor?.editor;
            },
            get file() {
                return getFile();
            },
            get path() {
                return getFile()?.path ?? "";
            },
        };
        editor = new (MemoEditor as any)(app, containerEl, controller);
        controller.editMode = editor;
        owner.addChild(editor);
        editor.set("");
        if (!containerEl.querySelector(".cm-editor")) {
            throw new Error("no editor element was created");
        }
    } catch (e) {
        console.warn(
            "Full Calendar: mounting Obsidian's editor failed; the memo uses a plain field.",
            e
        );
        try {
            owner.removeChild(editor);
        } catch {
            // Nothing to clean up.
        }
        containerEl.empty();
        editorClass = null;
        return null;
    }

    const get = (): string => {
        try {
            return (
                editor.editor?.getValue?.() ??
                editor.cm?.state?.doc?.toString?.() ??
                ""
            );
        } catch {
            return "";
        }
    };
    return {
        get,
        set: (text) => {
            if (get() !== text) {
                editor.set(text);
            }
        },
        hasFocus: () =>
            !!document.activeElement &&
            containerEl.contains(document.activeElement),
        focus: () => {
            try {
                editor.editor?.focus?.();
            } catch {
                // Not worth failing over.
            }
        },
        destroy: () => {
            try {
                owner.removeChild(editor);
            } catch {
                // Already gone.
            }
        },
    };
}
