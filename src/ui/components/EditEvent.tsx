import { DateTime } from "luxon";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { CalendarInfo, OFCEvent } from "../../types";

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
        initialEvent?.type === "recurring" || false
    );
    const [endRecur, setEndRecur] = useState("");

    const [daysOfWeek, setDaysOfWeek] = useState<string[]>(
        (initialEvent?.type === "recurring" ? initialEvent.daysOfWeek : []) ||
            []
    );

    const [allDay, setAllDay] = useState(initialEvent?.allDay || false);

    const [calendarIndex, setCalendarIndex] = useState(defaultCalendarIndex);

    const initialCompleted =
        initialEvent?.type === "single" ? initialEvent.completed : undefined;
    const initialStatus =
        initialEvent?.type === "single" ? initialEvent.status : undefined;

    const [complete, setComplete] = useState<string | boolean | null>(
        initialCompleted !== null && initialCompleted !== undefined
            ? initialCompleted
            : false
    );

    // A new event (no title yet) defaults to a task; existing events keep
    // task-ness only if they explicitly set `completed`.
    const [isTask, setIsTask] = useState(
        initialCompleted !== undefined && initialCompleted !== null
            ? true
            : !(initialEvent && initialEvent.title)
    );

    const [status, setStatus] = useState<string>(initialStatus || "Backlog");

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
                          type: "single",
                          date: date || "",
                          endDate: endDate || null,
                          completed: isTask
                              ? !!complete
                              : originalCompleted !== undefined
                              ? originalCompleted
                              : null,
                          status: isTask ? status : undefined,
                      }),
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
                        <DaySelect
                            value={daysOfWeek}
                            onChange={setDaysOfWeek}
                        />
                        <p>
                            Starts recurring
                            <input
                                type="date"
                                id="startDate"
                                value={date}
                                // @ts-ignore
                                onChange={makeChangeListener(setDate, (x) => x)}
                            />
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
