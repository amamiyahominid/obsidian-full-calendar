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

// There is an issue with FullCalendar RRule support around DST boundaries which is fixed by this monkeypatch:
// https://github.com/fullcalendar/fullcalendar/issues/5273#issuecomment-1360459342
//
// Two further tweaks on top of the upstream snippet:
//   1. Extend the `between` window to the end of the requested day so that
//      events that occur late in the day (or as a whole-day occurrence) are
//      not silently dropped at view boundaries.
//   2. Read date components in UTC and re-pack them with the dtstart's hours
//      and minutes. With local-zone reads, recurring weekly events shifted
//      by a day for hosts east of UTC.
rrulePlugin.recurringTypes[0].expand = function (errd, fr, de) {
    const hours = errd.rruleSet._dtstart.getHours();
    const minutes = errd.rruleSet._dtstart.getMinutes();
    const endDate = de.toDate(fr.end);
    endDate.setHours(23, 59, 59, 999);
    return errd.rruleSet
        .between(de.toDate(fr.start), endDate, true)
        .map((d: Date) => {
            return new Date(
                Date.UTC(
                    d.getUTCFullYear(),
                    d.getUTCMonth(),
                    d.getUTCDate(),
                    hours,
                    minutes
                )
            );
        });
};

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

        eventMouseEnter,

        eventDidMount: ({ event, el, textColor }) => {
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

                    if (checkbox.checked) {
                        el.addClass("ofc-task-completed");
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
