/**
 * Handles rendering the calendar given a container element, eventSources, and interaction callbacks.
 */
import {
    Calendar,
    EventApi,
    EventClickArg,
    EventHoveringArg,
    EventSourceInput,
} from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import rrulePlugin from "@fullcalendar/rrule";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import googleCalendarPlugin from "@fullcalendar/google-calendar";
import iCalendarPlugin from "@fullcalendar/icalendar";
import { expandRRuleOccurrences } from "./rruleExpand";

// FullCalendar's stock rrule expansion misbehaves around DST boundaries and
// timezone offsets; see rruleExpand.ts for the full story.
rrulePlugin.recurringTypes[0].expand = expandRRuleOccurrences;

/** "YYYY-MM-DD" of a Date in the host's local timezone. */
const localDayString = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
    ).padStart(2, "0")}`;

interface ExtraRenderProps {
    eventClick?: (info: EventClickArg) => void;
    select?: (
        startDate: Date,
        endDate: Date,
        allDay: boolean,
        viewType: string
    ) => Promise<void>;
    modifyEvent?: (event: EventApi, oldEvent: EventApi) => Promise<boolean>;
    eventMouseEnter?: (info: EventHoveringArg) => void;
    firstDay?: number;
    initialView?: { desktop: string; mobile: string };
    timeFormat24h?: boolean;
    openContextMenuForEvent?: (
        event: EventApi,
        mouseEvent: MouseEvent
    ) => Promise<void>;
    toggleTask?: (event: EventApi, isComplete: boolean) => Promise<boolean>;
    forceNarrow?: boolean;
    // Identifies daily-note TODO calendar sources. The daily-note template
    // rolls unchecked TODOs forward by COPYING them into the next day's note,
    // so only the newest note holds the live list — unchecked items from
    // older notes are stale duplicates and get hidden. Checked items stay as
    // history on the day they were completed. This is a live predicate, not a
    // snapshot, so calendars added after the view opened are still
    // recognized.
    isTodoSource?: (sourceId: string) => boolean;
    // Fires when an external element (a task-tray card) is dropped onto the
    // calendar. FullCalendar has already added a temporary event; the handler
    // is responsible for removing it and persisting the real one.
    onExternalDrop?: (info: {
        event: EventApi;
        revert: () => void;
    }) => Promise<void>;
}

export function renderCalendar(
    containerEl: HTMLElement,
    eventSources: EventSourceInput[],
    settings?: ExtraRenderProps
): Calendar {
    const isMobile = window.innerWidth < 500;
    const isNarrow = settings?.forceNarrow || isMobile;
    const {
        eventClick,
        select,
        modifyEvent,
        eventMouseEnter,
        openContextMenuForEvent,
        toggleTask,
        isTodoSource,
        onExternalDrop,
    } = settings || {};
    const modifyEventCallback =
        modifyEvent &&
        (async ({
            event,
            oldEvent,
            revert,
        }: {
            event: EventApi;
            oldEvent: EventApi;
            revert: () => void;
        }) => {
            const success = await modifyEvent(event, oldEvent);
            if (!success) {
                revert();
            }
        });

    const cal = new Calendar(containerEl, {
        plugins: [
            // View plugins
            dayGridPlugin,
            timeGridPlugin,
            listPlugin,
            // Drag + drop and editing
            interactionPlugin,
            // Remote sources
            googleCalendarPlugin,
            iCalendarPlugin,
            rrulePlugin,
        ],
        googleCalendarApiKey: "AIzaSyDIiklFwJXaLWuT_4y6I9ZRVVsPuf4xGrk",
        initialView:
            settings?.initialView?.[isNarrow ? "mobile" : "desktop"] ||
            (isNarrow ? "timeGrid3Days" : "timeGridWeek"),
        nowIndicator: true,
        scrollTimeReset: false,
        dayMaxEvents: true,

        headerToolbar: !isNarrow
            ? {
                  left: "prev,next today",
                  center: "title",
                  right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek",
              }
            : !isMobile
            ? {
                  right: "today,prev,next",
                  left: "timeGrid3Days,timeGridDay,listWeek",
              }
            : false,
        footerToolbar: isMobile
            ? {
                  right: "today,prev,next",
                  left: "timeGrid3Days,timeGridDay,listWeek",
              }
            : false,

        views: {
            timeGridDay: {
                type: "timeGrid",
                duration: { days: 1 },
                buttonText: isNarrow ? "1" : "day",
            },
            timeGrid3Days: {
                type: "timeGrid",
                duration: { days: 3 },
                buttonText: "3",
            },
            // Custom N-day views activated by pressing 2/4-9 while a
            // timeGrid view has focus. 1 and 3 reuse the existing views
            // above so toolbar buttons keep working.
            timeGrid2Days: {
                type: "timeGrid",
                duration: { days: 2 },
            },
            timeGrid4Days: {
                type: "timeGrid",
                duration: { days: 4 },
            },
            timeGrid5Days: {
                type: "timeGrid",
                duration: { days: 5 },
            },
            timeGrid6Days: {
                type: "timeGrid",
                duration: { days: 6 },
            },
            timeGrid7Days: {
                type: "timeGrid",
                duration: { days: 7 },
            },
            timeGrid8Days: {
                type: "timeGrid",
                duration: { days: 8 },
            },
            timeGrid9Days: {
                type: "timeGrid",
                duration: { days: 9 },
            },
        },
        firstDay: settings?.firstDay,
        ...(settings?.timeFormat24h && {
            eventTimeFormat: {
                hour: "numeric",
                minute: "2-digit",
                hour12: false,
            },
            slotLabelFormat: {
                hour: "numeric",
                minute: "2-digit",
                hour12: false,
            },
        }),
        eventSources,
        eventClick,

        selectable: select && true,
        selectMirror: select && true,
        select:
            select &&
            (async (info) => {
                await select(info.start, info.end, info.allDay, info.view.type);
                info.view.calendar.unselect();
            }),

        editable: modifyEvent && true,
        // Ensure `event.end` is always populated. Without this, dragging an
        // all-day event onto the time-grid produces a timed event whose end
        // is null, and the persisted endTime gets dropped.
        forceEventDuration: true,
        eventDrop: modifyEventCallback,
        eventResize: modifyEventCallback,

        // External drags from the task tray.
        droppable: !!onExternalDrop,
        eventReceive: onExternalDrop,

        eventMouseEnter,

        // Mark completed tasks with a class FullCalendar manages itself.
        // Adding it imperatively in eventDidMount was fragile: FullCalendar
        // owns the element's className and rebuilds it on relayout, wiping a
        // hand-added class (so the strike-through silently disappeared after a
        // re-render) while leaving the prepended checkbox child in place.
        eventClassNames: ({ event }) =>
            event.extendedProps.isTask &&
            event.extendedProps.taskCompleted !== false
                ? ["ofc-task-completed"]
                : [],

        eventDidMount: ({ event, el, textColor }) => {
            // Guaranteed recurrence exclusion. FullCalendar's rrule plugin is
            // supposed to drop occurrences listed in `exdate` / EXDATE, but in
            // the Electron runtime (with our mismatched @fullcalendar plugin
            // versions, rrule 5.11.2 vs common 5.11.4) that exclusion silently
            // fails — the original instance keeps rendering next to a moved
            // recurrence override. Since the rrule still expands occurrences
            // correctly, we hide any instance whose local day is in skipDates.
            const skipDates = event.extendedProps?.skipDates as
                | string[]
                | undefined;
            if (skipDates && skipDates.length > 0 && event.start) {
                if (skipDates.includes(localDayString(event.start))) {
                    el.style.display = "none";
                    return;
                }
            }
            // Hide unchecked TODOs from PAST days: the plugin's rollover
            // moves them into today's note, so anything unchecked in a past
            // note is either mid-migration or a leftover copy from the old
            // copy-forward template. Today's and deferred (future) TODOs
            // show; checked TODOs stay visible as history on their day.
            if (
                isTodoSource &&
                event.start &&
                event.extendedProps.isTask &&
                event.extendedProps.taskCompleted === false &&
                event.source?.id &&
                isTodoSource(event.source.id)
            ) {
                if (localDayString(event.start) < localDayString(new Date())) {
                    el.style.display = "none";
                    return;
                }
            }
            el.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                openContextMenuForEvent && openContextMenuForEvent(event, e);
            });
            if (toggleTask) {
                if (event.extendedProps.isTask) {
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.checked =
                        event.extendedProps.taskCompleted !== false;
                    checkbox.onclick = async (e) => {
                        e.stopPropagation();
                        if (e.target) {
                            let ret = await toggleTask(
                                event,
                                (e.target as HTMLInputElement).checked
                            );
                            if (!ret) {
                                (e.target as HTMLInputElement).checked = !(
                                    e.target as HTMLInputElement
                                ).checked;
                            }
                        }
                    };
                    // Make the checkbox more visible against different color events.
                    if (textColor == "black") {
                        checkbox.addClass("ofc-checkbox-black");
                    } else {
                        checkbox.addClass("ofc-checkbox-white");
                    }

                    // Depending on the view, we should put the checkbox in a different spot.
                    const container =
                        el.querySelector(".fc-event-time") ||
                        el.querySelector(".fc-event-title") ||
                        el.querySelector(".fc-list-event-title");

                    container?.addClass("ofc-has-checkbox");
                    container?.prepend(checkbox);
                }
            }
        },

        longPressDelay: 250,
    });
    cal.render();

    // Number-key shortcut: 1-9 switch to an N-day timeGrid view. Active only
    // when the calendar (or a descendant) holds keyboard focus, so other
    // panes and the event-edit modal aren't affected.
    containerEl.tabIndex = 0;
    // Focus the calendar on click so the user can start using number keys
    // without an extra Tab press. Without this, clicks on FullCalendar's
    // unfocusable inner elements leave focus elsewhere.
    containerEl.addEventListener("mousedown", () => {
        if (!containerEl.contains(document.activeElement)) {
            containerEl.focus();
        }
    });
    containerEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (!cal.view.type.startsWith("timeGrid")) return;
        const target = e.target as HTMLElement | null;
        if (target) {
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
            if (target.isContentEditable) return;
        }
        // Arrow keys move the visible range by the current view's duration
        // (N days). FullCalendar's prev()/next() increment by dateIncrement,
        // which defaults to the view duration — so a 3-day view moves 3 days.
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            cal.prev();
            return;
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            cal.next();
            return;
        }
        // Top-row digits only — ignoring numpad avoids hijacking accidental
        // strokes from users with a numeric keypad workflow.
        if (e.key.length !== 1) return;
        const n = parseInt(e.key, 10);
        if (!Number.isInteger(n) || n < 1 || n > 9) return;
        e.preventDefault();
        const viewName =
            n === 1
                ? "timeGridDay"
                : n === 3
                ? "timeGrid3Days"
                : `timeGrid${n}Days`;
        cal.changeView(viewName);
    });

    return cal;
}
