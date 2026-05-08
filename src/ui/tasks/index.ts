import { OFCEvent } from "src/types";

export const isTask = (e: OFCEvent) =>
    e.type === "single" && e.completed !== undefined && e.completed !== null;

export const unmakeTask = (event: OFCEvent): OFCEvent => {
    if (event.type !== "single") {
        return event;
    }
    return { ...event, completed: null };
};

export const toggleTask = (event: OFCEvent, isDone: boolean): OFCEvent => {
    if (event.type !== "single") {
        return event;
    }
    // Only mirror the workflow status if the event already opted into it
    // (status is undefined for events that have never set one).
    const nextStatus =
        event.status !== undefined
            ? isDone
                ? "Done"
                : "Review"
            : event.status;
    return { ...event, completed: isDone, status: nextStatus };
};
