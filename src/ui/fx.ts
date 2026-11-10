/*
 * Motion, per docs/ux.md: three sizes and nothing else, shown once in reply
 * to something the user did.
 *
 * The surfaces rebuild their rows wholesale, often more than once for one
 * change, so an animation started on one element would be cut short by the
 * next redraw. Each effect is therefore remembered by KEY and by when it
 * began; whatever element stands for that key in a later draw picks it up
 * where it was (a negative animation-delay), and after its time it is gone.
 */

export type FxKind = "arrive" | "touch" | "done";

// Must match the durations in overrides.css (--ofc-fx-s / --ofc-fx-m).
const DURATION: Record<FxKind, number> = {
    arrive: 200,
    touch: 200,
    done: 700,
};

const CLASS: Record<FxKind, string> = {
    arrive: "ofc-fx-arrive",
    touch: "ofc-fx-touch",
    done: "ofc-fx-done",
};

const live = new Map<string, { kind: FxKind; at: number }>();

/** Something just happened to `key`; its element should answer. */
export function markFx(key: string, kind: FxKind): void {
    live.set(key, { kind, at: Date.now() });
}

/** Give `el` whatever effect is still under way for `key`. */
export function applyFx(el: HTMLElement, key: string | null | undefined) {
    if (!key) {
        return;
    }
    const fx = live.get(key);
    if (!fx) {
        return;
    }
    const elapsed = Date.now() - fx.at;
    if (elapsed >= DURATION[fx.kind]) {
        live.delete(key);
        return;
    }
    el.addClass(CLASS[fx.kind]);
    el.style.animationDelay = `-${elapsed}ms`;
}

/**
 * Tells what changed between two draws of a set of keys. The first draw
 * reports nothing: opening a view is not an event.
 */
export class Tracker {
    private last: Set<string> | null = null;

    update(now: Iterable<string>): { added: string[]; removed: string[] } {
        const next = new Set(now);
        const prev = this.last;
        this.last = next;
        if (!prev) {
            return { added: [], removed: [] };
        }
        return {
            added: [...next].filter((k) => !prev.has(k)),
            removed: [...prev].filter((k) => !next.has(k)),
        };
    }
}

/** "0:42" — hours and minutes since `startISO` (local "YYYY-MM-DDTHH:mm"). */
export function elapsedText(startISO: string, now = Date.now()): string {
    const start = new Date(startISO).getTime();
    if (isNaN(start)) {
        return "";
    }
    const minutes = Math.max(0, Math.floor((now - start) / 60000));
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(
        2,
        "0"
    )}`;
}

/**
 * A running clock in a row's small print. The text is refreshed in place by
 * `tickElapsed`, so nothing has to be redrawn for the minutes to move.
 */
export function elapsedPart(metaEl: HTMLElement, startISO: string) {
    const lead = metaEl.hasChildNodes() ? " · " : "";
    const span = metaEl.createSpan({ cls: "ofc-row-elapsed" });
    span.dataset.ofcLead = lead;
    span.dataset.ofcSince = startISO;
    span.setText(`${lead}● ${elapsedText(startISO)}`);
    return span;
}

/** Refresh every running clock on screen. Called on a timer by the host. */
export function tickElapsed(root: ParentNode = document): void {
    const now = Date.now();
    root.querySelectorAll<HTMLElement>("[data-ofc-since]").forEach((el) => {
        el.setText(
            `${el.dataset.ofcLead ?? ""}● ${elapsedText(
                el.dataset.ofcSince ?? "",
                now
            )}`
        );
    });
}
