import { DateTime } from "luxon";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { CalendarInfo, OFCEvent } from "../../types";
import { weekOf } from "../sprint";
import {
    buildRRule,
    parseRRule,
    DEFAULT_RECURRENCE,
    RecurrenceForm,
    Frequency,
    RRULE_WEEKDAYS,
    WEEKDAY_LABELS,
    WEEKDAY_POSITIONS,
} from "./recurrence";

function makeChangeListener<T>(
    setState: React.Dispatch<React.SetStateAction<T>>,
    fromString: (val: string) => T
): React.ChangeEventHandler<HTMLInputElement | HTMLSelectElement> {
    return (e) => setState(fromString(e.target.value));
}

interface DayChoiceProps {
    code: string;
    label: string;
    isSelected: boolean;
    onClick: (code: string) => void;
}
const DayChoice = ({ code, label, isSelected, onClick }: DayChoiceProps) => (
    <button
        type="button"
        style={{
            marginLeft: "0.25rem",
            marginRight: "0.25rem",
            padding: "0",
            backgroundColor: isSelected
                ? "var(--interactive-accent)"
                : "var(--interactive-normal)",
            color: isSelected ? "var(--text-on-accent)" : "var(--text-normal)",
            borderStyle: "solid",
            borderWidth: "1px",
            borderRadius: "50%",
            width: "25px",
            height: "25px",
        }}
        onClick={() => onClick(code)}
    >
        <b>{label[0]}</b>
    </button>
);

const DAY_MAP = {
    U: "Sunday",
    M: "Monday",
    T: "Tuesday",
    W: "Wednesday",
    R: "Thursday",
    F: "Friday",
    S: "Saturday",
};

const DaySelect = ({
    value: days,
    onChange,
}: {
    value: string[];
    onChange: (days: string[]) => void;
}) => {
    return (
        <div>
            {Object.entries(DAY_MAP).map(([code, label]) => (
                <DayChoice
                    key={code}
                    code={code}
                    label={label}
                    isSelected={days.includes(code)}
                    onClick={() =>
                        days.includes(code)
                            ? onChange(days.filter((c) => c !== code))
                            : onChange([code, ...days])
                    }
                />
            ))}
        </div>
    );
};

const MONTH_LABELS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

const RecurrencePattern = ({
    frequency,
    value,
    onChange,
}: {
    frequency: "monthly" | "yearly";
    value: RecurrenceForm;
    onChange: (patch: Partial<RecurrenceForm>) => void;
}) => (
    <p>
        {frequency === "yearly" && (
            <select
                value={value.month}
                onChange={(e) =>
                    onChange({ month: parseInt(e.target.value, 10) })
                }
            >
                {MONTH_LABELS.map((label, i) => (
                    <option key={i} value={i + 1}>
                        {label}
                    </option>
                ))}
            </select>
        )}{" "}
        <select
            value={value.dayMode}
            onChange={(e) =>
                onChange({
                    dayMode: e.target.value as RecurrenceForm["dayMode"],
                })
            }
        >
            <option value="dayOfMonth">on day</option>
            <option value="weekday">on the</option>
        </select>{" "}
        {value.dayMode === "dayOfMonth" ? (
            <select
                value={value.monthDay}
                onChange={(e) =>
                    onChange({ monthDay: parseInt(e.target.value, 10) })
                }
            >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                        {d}
                    </option>
                ))}
            </select>
        ) : (
            <>
                <select
                    value={value.position}
                    onChange={(e) =>
                        onChange({ position: parseInt(e.target.value, 10) })
                    }
                >
                    {WEEKDAY_POSITIONS.map((p) => (
                        <option key={p.value} value={p.value}>
                            {p.label}
                        </option>
                    ))}
                </select>{" "}
                <select
                    value={value.weekday}
                    onChange={(e) => onChange({ weekday: e.target.value })}
                >
                    {RRULE_WEEKDAYS.map((code) => (
                        <option key={code} value={code}>
                            {WEEKDAY_LABELS[code]}
                        </option>
                    ))}
                </select>
            </>
        )}
    </p>
);

interface EditEventProps {
    submit: (frontmatter: OFCEvent, calendarIndex: number) => Promise<void>;
    readonly calendars: {
        id: string;
        name: string;
        type: CalendarInfo["type"];
    }[];
    defaultCalendarIndex: number;
    initialEvent?: Partial<OFCEvent>;
    open?: () => Promise<void>;
    deleteEvent?: () => Promise<void>;
}

export const EditEvent = ({
    initialEvent,
    submit,
    open,
    deleteEvent,
    calendars,
    defaultCalendarIndex,
}: EditEventProps) => {
    const [date, setDate] = useState(
        initialEvent
            ? initialEvent.type === "single"
                ? initialEvent.date
                : initialEvent.type === "recurring"
                ? initialEvent.startRecur
                : initialEvent.type === "rrule"
                ? initialEvent.startDate
                : ""
            : ""
    );
    const [endDate, setEndDate] = useState(
        initialEvent && initialEvent.type === "single"
            ? initialEvent.endDate
            : undefined
    );

    let initialStartTime = "";
    let initialEndTime = "";
    if (initialEvent) {
        // @ts-ignore
        const { startTime, endTime } = initialEvent;
        initialStartTime = startTime || "";
        initialEndTime = endTime || "";
    }

    const [startTime, setStartTime] = useState(initialStartTime);
    const [endTime, setEndTime] = useState(initialEndTime);
    const [title, setTitle] = useState(initialEvent?.title || "");
    const [isRecurring, setIsRecurring] = useState(
        initialEvent?.type === "recurring" ||
            initialEvent?.type === "rrule" ||
            false
    );
    const [endRecur, setEndRecur] = useState("");

    const [daysOfWeek, setDaysOfWeek] = useState<string[]>(
        (initialEvent?.type === "recurring" ? initialEvent.daysOfWeek : []) ||
            []
    );

    // Monthly/yearly recurrence is stored as an `rrule` event. Seed the form
    // from an existing rule when editing; otherwise fall back to weekly.
    const initialRecurrence =
        initialEvent?.type === "rrule" && initialEvent.rrule
            ? parseRRule(initialEvent.rrule)
            : null;
    const [frequency, setFrequency] = useState<Frequency>(
        initialRecurrence ? initialRecurrence.frequency : "weekly"
    );
    const [recurrence, setRecurrence] = useState<RecurrenceForm>(
        initialRecurrence ?? DEFAULT_RECURRENCE
    );
    // Preserve skip dates (exceptions) across edits of an rrule event.
    const [skipDates] = useState<string[]>(
        (initialEvent?.type === "rrule" && initialEvent.skipDates) || []
    );

    const patchRecurrence = (patch: Partial<RecurrenceForm>) =>
        setRecurrence((prev) => ({ ...prev, ...patch }));

    const [allDay, setAllDay] = useState(initialEvent?.allDay || false);

    const [calendarIndex, setCalendarIndex] = useState(defaultCalendarIndex);

    const initialCompleted =
        initialEvent?.type === "single" ? initialEvent.completed : undefined;
    const initialStatus =
        initialEvent?.type === "single" ? initialEvent.status : undefined;
    const initialSprint =
        initialEvent?.type === "single" ? initialEvent.sprint : undefined;

    const [complete, setComplete] = useState<string | boolean | null>(
        initialCompleted !== null && initialCompleted !== undefined
            ? initialCompleted
            : false
    );

    // A new event (no title yet) defaults to a task; existing events keep
    // task-ness if they carry either done-ness field (status for task notes,
    // completed for daily-note checkbox lines).
    const [isTask, setIsTask] = useState(
        (initialCompleted !== undefined && initialCompleted !== null) ||
            initialStatus !== undefined
            ? true
            : !(initialEvent && initialEvent.title)
    );

    const [status, setStatus] = useState<string>(initialStatus || "Backlog");

    // "" means no sprint. The dropdown offers the planning window (this week
    // through +3); an out-of-window value already on the event is kept as an
    // extra choice so opening and saving the modal never rewrites it.
    const [sprint, setSprint] = useState<string>(initialSprint || "");
    const sprintChoices = [0, 1, 2, 3].map((offset) => weekOf(offset));
    if (initialSprint && !sprintChoices.includes(initialSprint)) {
        sprintChoices.push(initialSprint);
    }

    // Preserve the original completion value so toggling "Task Event" off
    // and on doesn't reset a previously-set completion.
    const originalCompleted = initialCompleted;

    const titleRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (titleRef.current) {
            titleRef.current.focus();
        }
    }, [titleRef]);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        await submit(
            {
                ...{ title },
                ...(allDay
                    ? { allDay: true }
                    : { allDay: false, startTime: startTime || "", endTime }),
                ...(isRecurring
                    ? frequency === "weekly"
                        ? {
                              type: "recurring",
                              daysOfWeek: daysOfWeek as (
                                  | "U"
                                  | "M"
                                  | "T"
                                  | "W"
                                  | "R"
                                  | "F"
                                  | "S"
                              )[],
                              startRecur: date || undefined,
                              endRecur: endRecur || undefined,
                          }
                        : {
                              type: "rrule",
                              startDate: date || "",
                              rrule: buildRRule({
                                  ...recurrence,
                                  frequency,
                              }),
                              skipDates,
                          }
                    : (() => {
                          // Which field owns done-ness depends on the target:
                          // task notes (local calendars) use `status` and must
                          // not carry a legacy `completed` key; daily-note
                          // lines use the checkbox (`completed`) and must not
                          // get a `[status:: ...]` attribute.
                          const workflowTask =
                              isTask &&
                              calendars[calendarIndex]?.type === "local";
                          return {
                              type: "single" as const,
                              date: date || "",
                              endDate: endDate || null,
                              completed: workflowTask
                                  ? null
                                  : isTask
                                  ? !!complete
                                  : originalCompleted !== undefined
                                  ? originalCompleted
                                  : null,
                              // null deletes the frontmatter key (see
                              // modifyFrontmatterString); un-tasking an event
                              // removes it from the workflow entirely.
                              status: (workflowTask
                                  ? status
                                  : isTask
                                  ? undefined
                                  : null) as unknown as string | undefined,
                              sprint: sprint || null,
                          };
                      })()),
            },
            calendarIndex
        );
    };

    return (
        <>
            <div>
                <p style={{ float: "right" }}>
                    {open && <button onClick={open}>Open Note</button>}
                </p>
            </div>

            <form onSubmit={handleSubmit}>
                <p>
                    <input
                        ref={titleRef}
                        type="text"
                        id="title"
                        value={title}
                        placeholder={"Add title"}
                        required
                        onChange={makeChangeListener(setTitle, (x) => x)}
                    />
                </p>
                <p>
                    <select
                        id="calendar"
                        value={calendarIndex}
                        onChange={makeChangeListener(
                            setCalendarIndex,
                            parseInt
                        )}
                    >
                        {calendars
                            .flatMap((cal) =>
                                cal.type === "local" || cal.type === "dailynote"
                                    ? [cal]
                                    : []
                            )
                            .map((cal, idx) => (
                                <option
                                    key={idx}
                                    value={idx}
                                    disabled={
                                        !(
                                            initialEvent?.title === undefined ||
                                            calendars[calendarIndex].type ===
                                                cal.type
                                        )
                                    }
                                >
                                    {cal.type === "local"
                                        ? cal.name
                                        : "Daily Note"}
                                </option>
                            ))}
                    </select>
                </p>
                <p>
                    {!isRecurring && (
                        <input
                            type="date"
                            id="date"
                            value={date}
                            required={!isRecurring}
                            // @ts-ignore
                            onChange={makeChangeListener(setDate, (x) => x)}
                        />
                    )}

                    {allDay ? (
                        <></>
                    ) : (
                        <>
                            <input
                                type="time"
                                id="startTime"
                                value={startTime}
                                required
                                onChange={makeChangeListener(
                                    setStartTime,
                                    (x) => x
                                )}
                            />
                            -
                            <input
                                type="time"
                                id="endTime"
                                value={endTime}
                                required
                                onChange={makeChangeListener(
                                    setEndTime,
                                    (x) => x
                                )}
                            />
                        </>
                    )}
                </p>
                <p>
                    <label htmlFor="allDay">All day event </label>
                    <input
                        id="allDay"
                        checked={allDay}
                        onChange={(e) => setAllDay(e.target.checked)}
                        type="checkbox"
                    />
                </p>
                <p>
                    <label htmlFor="recurring">Recurring Event </label>
                    <input
                        id="recurring"
                        checked={isRecurring}
                        onChange={(e) => setIsRecurring(e.target.checked)}
                        type="checkbox"
                    />
                </p>

                {isRecurring && (
                    <>
                        <p>
                            <label htmlFor="frequency">Repeats </label>
                            <select
                                id="frequency"
                                value={frequency}
                                onChange={(e) =>
                                    setFrequency(e.target.value as Frequency)
                                }
                            >
                                <option value="weekly">Weekly</option>
                                <option value="monthly">Monthly</option>
                                <option value="yearly">Yearly</option>
                            </select>
                        </p>

                        {frequency === "weekly" && (
                            <DaySelect
                                value={daysOfWeek}
                                onChange={setDaysOfWeek}
                            />
                        )}

                        {(frequency === "monthly" ||
                            frequency === "yearly") && (
                            <RecurrencePattern
                                frequency={frequency}
                                value={recurrence}
                                onChange={patchRecurrence}
                            />
                        )}

                        <p>
                            Starts recurring
                            <input
                                type="date"
                                id="startDate"
                                value={date}
                                // @ts-ignore
                                onChange={makeChangeListener(setDate, (x) => x)}
                            />
                            {frequency === "weekly" && (
                                <>
                                    and stops recurring
                                    <input
                                        type="date"
                                        id="endDate"
                                        value={endRecur}
                                        onChange={makeChangeListener(
                                            setEndRecur,
                                            (x) => x
                                        )}
                                    />
                                </>
                            )}
                        </p>
                    </>
                )}
                <p>
                    <label htmlFor="task">Task Event </label>
                    <input
                        id="task"
                        checked={isTask}
                        onChange={(e) => {
                            setIsTask(e.target.checked);
                        }}
                        type="checkbox"
                    />
                </p>

                {isTask && (
                    <>
                        <label htmlFor="taskStatus">Complete? </label>
                        <input
                            id="taskStatus"
                            checked={
                                !(complete === false || complete === undefined)
                            }
                            onChange={(e) => {
                                const isChecked = e.target.checked;
                                setComplete(
                                    isChecked ? DateTime.now().toISO() : false
                                );
                                setStatus(isChecked ? "Done" : "Review");
                            }}
                            type="checkbox"
                        />
                        <p>
                            <label htmlFor="status">Status </label>
                            <select
                                id="status"
                                value={status}
                                onChange={(e) => {
                                    const newStatus = e.target.value;
                                    setStatus(newStatus);
                                    setComplete(
                                        newStatus === "Done"
                                            ? DateTime.now().toISO()
                                            : false
                                    );
                                }}
                            >
                                <option value="Backlog">Backlog</option>
                                <option value="Ready">Ready</option>
                                <option value="In Progress">In Progress</option>
                                <option value="Review">Review</option>
                                <option value="Done">Done</option>
                            </select>
                        </p>
                        <p>
                            <label htmlFor="sprint">Sprint </label>
                            <select
                                id="sprint"
                                value={sprint}
                                onChange={(e) => setSprint(e.target.value)}
                            >
                                <option value="">No sprint</option>
                                {sprintChoices.map((week, i) => (
                                    <option key={week} value={week}>
                                        {i === 0 ? `${week} (this week)` : week}
                                    </option>
                                ))}
                            </select>
                        </p>
                    </>
                )}

                <p
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                    }}
                >
                    <button type="submit"> Save Event </button>
                    <span>
                        {deleteEvent && (
                            <button
                                type="button"
                                style={{
                                    backgroundColor:
                                        "var(--interactive-normal)",
                                    color: "var(--background-modifier-error)",
                                    borderColor:
                                        "var(--background-modifier-error)",
                                    borderWidth: "1px",
                                    borderStyle: "solid",
                                }}
                                onClick={deleteEvent}
                            >
                                Delete Event
                            </button>
                        )}
                    </span>
                </p>
            </form>
        </>
    );
};
