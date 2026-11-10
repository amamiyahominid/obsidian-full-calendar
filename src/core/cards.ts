import type FullCalendarPlugin from "../main";
import type { OFCEvent } from "../types";

/*
 * Cards: the things to do that live in notes of their own (tasks and
 * issues), as every surface — tray, kanban, calendar — reads them. Lives in
 * the core so the surfaces depend on it, not on each other.
 */

export type Card = {
    id: string;
    event: Extract<OFCEvent, { type: "single" }>;
    calendarId: string;
    sourceColor: string | null | undefined;
};

/**
 * All workflow task cards. A task is a status-bearing single event from a
 * project (full-note) calendar — nothing else counts. Daily-note sources are
 * excluded — their checkbox lines are day-scoped TODOs and work-log
 * sessions, not 案件, and would otherwise flood the Backlog column.
 */
export function collectTaskCards(plugin: FullCalendarPlugin): Card[] {
    const issuesId = plugin.issuesSourceId();
    const cards: Card[] = [];
    for (const source of plugin.cache.getAllEvents()) {
        if (!source.editable || source.id.startsWith("dailynote")) {
            continue;
        }
        // Issues are workflow cards too, but deliberately not tasks: they
        // live on the kanban's Issue axis (collectIssueCards) and never mix
        // into the task board, tray, or sprint planning.
        if (issuesId !== null && source.id === issuesId) {
            continue;
        }
        for (const { id, event } of source.events) {
            if (event.type !== "single") {
                continue;
            }
            if (event.status === undefined) {
                continue;
            }
            cards.push({
                id,
                event,
                calendarId: source.id,
                sourceColor: source.color,
            });
        }
    }
    cards.sort((a, b) => {
        const dateCmp = (a.event.date ?? "").localeCompare(b.event.date ?? "");
        return dateCmp !== 0
            ? dateCmp
            : a.event.title.localeCompare(b.event.title);
    });
    return cards;
}

/**
 * Status-bearing notes from the issues folder. Same card shape as tasks so
 * the board render path is shared, but collected separately — issues and
 * project tasks are never shown side by side.
 */
export function collectIssueCards(plugin: FullCalendarPlugin): Card[] {
    const issuesId = plugin.issuesSourceId();
    if (issuesId === null) {
        return [];
    }
    const cards: Card[] = [];
    for (const source of plugin.cache.getAllEvents()) {
        if (source.id !== issuesId || !source.editable) {
            continue;
        }
        for (const { id, event } of source.events) {
            if (event.type !== "single" || event.status === undefined) {
                continue;
            }
            cards.push({
                id,
                event,
                calendarId: source.id,
                sourceColor: source.color,
            });
        }
    }
    // Issues carry no date; title order keeps columns stable.
    return cards.sort((a, b) => a.event.title.localeCompare(b.event.title));
}

// "local::30_projects/01_foo/tasks" → "01_foo". Falls back to the raw ID for
// sources that don't follow the project-folder convention.
export const projectLabel = (calendarId: string): string => {
    const path = calendarId.split("::")[1] ?? calendarId;
    const segments = path.replace(/\/tasks$/, "").split("/");
    return segments[segments.length - 1] || calendarId;
};
