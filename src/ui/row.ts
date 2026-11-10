import { setIcon } from "obsidian";
import { formatHours } from "./sprint";

/*
 * The row: ONE look for a thing to do, wherever it shows — today's list,
 * the week's groups, a kanban column. Page surface, hairline frame, a bar
 * on the left in the colour of what it belongs to (its project; neutral
 * when it belongs to none), a title, an optional second line of small
 * print, and at most a checkbox on the left and a button or two on the
 * right.
 *
 * Behaviour stays with the caller: the row draws, the surface decides what
 * a click, a drag or a tick means. `cls` carries the surface's own class
 * (`ofc-tray-card`, `ofc-kanban-card`, …) for its drag selectors.
 */

export type RowButton = {
    icon: string;
    label: string;
    // `quiet`: no outline — for the secondary action beside the main one.
    // `reveal`: shown on hover only (always on touch screens).
    quiet?: boolean;
    reveal?: boolean;
    onClick: () => unknown;
};

export type RowSpec = {
    cls?: string[];
    title: string;
    // Colour of the bar on the left; null/undefined → neutral.
    color?: string | null;
    done?: boolean;
    running?: boolean;
    check?: {
        checked: boolean;
        label: string;
        onToggle: () => unknown;
    };
    // Fills the small-print line. Left out (or leaving it empty) → no line.
    meta?: (metaEl: HTMLElement) => void;
    buttons?: RowButton[];
};

export type Row = { el: HTMLElement; bodyEl: HTMLElement };

export function renderRow(parent: HTMLElement, spec: RowSpec): Row {
    const el = parent.createDiv({ cls: ["ofc-row", ...(spec.cls ?? [])] });
    if (spec.color) {
        el.style.setProperty("--ofc-row-color", spec.color);
    }
    el.toggleClass("ofc-row-done", !!spec.done);
    el.toggleClass("ofc-row-running", !!spec.running);

    if (spec.check) {
        const check = el.createEl("input", {
            type: "checkbox",
            cls: "ofc-row-check",
        });
        check.checked = spec.check.checked;
        check.setAttr("aria-label", spec.check.label);
        const { onToggle } = spec.check;
        check.onclick = (ev) => {
            ev.stopPropagation();
            onToggle();
        };
    }

    const bodyEl = el.createDiv({ cls: "ofc-row-body" });
    bodyEl.createDiv({ cls: "ofc-row-title", text: spec.title });
    if (spec.meta) {
        const metaEl = bodyEl.createDiv({ cls: "ofc-row-meta" });
        spec.meta(metaEl);
        if (!metaEl.hasChildNodes()) {
            metaEl.remove();
        }
    }

    for (const button of spec.buttons ?? []) {
        const btn = el.createEl("button", { cls: "ofc-row-btn" });
        btn.toggleClass("ofc-row-btn-quiet", !!button.quiet);
        btn.toggleClass("ofc-row-btn-reveal", !!button.reveal);
        setIcon(btn, button.icon);
        btn.setAttr("aria-label", button.label);
        btn.onclick = (ev) => {
            ev.stopPropagation();
            button.onClick();
        };
    }
    return { el, bodyEl };
}

/** One piece of small print; pieces after the first get a " · " before. */
export function metaPart(
    metaEl: HTMLElement,
    text: string,
    cls?: string
): HTMLElement {
    const lead = metaEl.hasChildNodes() ? " · " : "";
    return metaEl.createSpan({ cls, text: lead + text });
}

/** "⏱ 0.5h / 2h" — logged time against the estimate; null when neither. */
export function timeLabel(
    actualMinutes: number,
    estimateMinutes: number
): string | null {
    if (actualMinutes <= 0 && estimateMinutes <= 0) {
        return null;
    }
    return `⏱ ${formatHours(actualMinutes)}${
        estimateMinutes > 0 ? ` / ${formatHours(estimateMinutes)}` : ""
    }`;
}

/** The deadline, in red once it's close or past. */
export function dueMeta(
    metaEl: HTMLElement,
    due: { text: string; urgent: boolean } | null
): void {
    if (!due) {
        return;
    }
    metaPart(metaEl, due.text, "ofc-row-due").toggleClass(
        "ofc-row-due-urgent",
        due.urgent
    );
}
