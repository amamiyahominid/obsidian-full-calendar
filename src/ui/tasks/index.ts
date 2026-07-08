import { OFCEvent } from "src/types";

/*
 * Two kinds of checkbox-bearing events, each with ONE source of truth:
 * - Workflow tasks (task notes): the `status` frontmatter field. "Done"
 *   means checked. Any `completed` key is legacy and gets cleared on the
 *   next toggle rather than kept in sync.
 * - Daily-note checkbox lines: the literal `[x]` on the line, surfaced as
 *   `completed`. These never have a status field.
 */

export const isTask = (e: OFCEvent) =>
    e.type === "single" &&
    (e.status !== undefined ||
        (e.completed !== undefined && e.completed !== null));

export const unmakeTask = (event: OFCEvent): OFCEvent => {
    if (event.type !== "single") {
        return event;
    }
    // null is the writers' deletion marker: drop the checkbox AND leave the
    // workflow (a status-less note disappears from the kanban board).
    return { ...event, completed: null, status: null } as unknown as OFCEvent;
};

export const toggleTask = (event: OFCEvent, isDone: boolean): OFCEvent => {
    if (event.type !== "single") {
        return event;
    }
    if (event.status !== undefined) {
        // Status is the source of truth; clear any legacy completed key
        // instead of maintaining a second copy that can drift.
        return {
            ...event,
            completed: null,
            status: isDone ? "Done" : "Review",
        };
    }
    return { ...event, completed: isDone };
};
