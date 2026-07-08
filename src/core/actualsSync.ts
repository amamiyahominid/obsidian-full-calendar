import { collectTaskCards } from "../ui/kanban";
import { actualMinutesByLinktext, linktextForEvent } from "./worklog";
import type FullCalendarPlugin from "../main";

/*
 * Materialize each task's logged session time into its frontmatter as
 * `actual` (minutes), so Dataview/metadata-menu and plain reading of the
 * note can see it.
 *
 * The field is a CACHE of the session totals, never a second source of
 * truth: any session change triggers a debounced full reconcile that
 * recomputes every total and rewrites only the notes whose value changed.
 * Increment-on-create was rejected deliberately — resizes, moves, deletions
 * and hand edits would all need matching decrements and any missed path
 * would drift forever, whereas recompute is idempotent and self-healing.
 *
 * Loop safety: writing `actual` re-fires the cache update event, which
 * reschedules a reconcile, which finds no diffs and writes nothing.
 */

let timer: number | null = null;
let running = false;

/** Debounced entry point, wired to the cache's update event. */
export function scheduleActualsSync(plugin: FullCalendarPlugin): void {
    if (timer !== null) {
        window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
        timer = null;
        reconcileActuals(plugin).catch((e) =>
            console.error("Full Calendar: actuals sync failed.", e)
        );
    }, 2000);
}

/**
 * Recompute session totals for every workflow task and write the `actual`
 * frontmatter field where it changed (null-deleting it at zero). Returns
 * the number of notes written.
 */
export async function reconcileActuals(
    plugin: FullCalendarPlugin
): Promise<number> {
    if (running) {
        // A concurrent run is already writing; its writes re-fire the update
        // event and reschedule us, so nothing is lost by bailing here.
        return 0;
    }
    running = true;
    try {
        const totals = actualMinutesByLinktext(plugin);
        let written = 0;
        for (const card of collectTaskCards(plugin)) {
            const link = linktextForEvent(plugin, card.id);
            if (!link) {
                continue;
            }
            const total = Math.round(totals.get(link) ?? 0);
            const current = card.event.actual ?? 0;
            if (total === current) {
                continue;
            }
            await plugin.cache.processEvent(card.id, (e) =>
                e.type === "single"
                    ? {
                          ...e,
                          // null is the writers' deletion marker.
                          actual: (total > 0 ? total : null) as unknown as
                              | number
                              | undefined,
                      }
                    : e
            );
            written++;
        }
        return written;
    } finally {
        running = false;
    }
}
