import { ZodError, z } from "zod";
import { OFCEvent } from "./schema";

const calendarOptionsSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("local"), directory: z.string() }),
    // Two modes: `heading` parses list items under that heading; `todos`
    // instead parses bare checkbox lines at the top of the note (before the
    // first heading or thematic break) as all-day tasks. `heading` is unused
    // in todos mode and defaults to "" so old configs stay valid.
    z.object({
        type: z.literal("dailynote"),
        heading: z.string().default(""),
        todos: z.boolean().default(false),
    }),
    // Notes found by their `kind` (and, for tasks, the project they link
    // to) rather than by folder. Never saved in settings: the plugin works
    // these out from the vault's project notes (docs/format.md).
    z.object({
        type: z.literal("notes"),
        kind: z.enum(["task", "issue"]),
        project: z.string().optional(),
        projectPath: z.string().optional(),
    }),
    // `hand`: for a remote calendar, what its events count towards when
    // time is added up by hand — a note's name, or "-" for a calendar that
    // isn't time spent (public holidays). The plugin only stores it; the
    // vault's own summaries read it from here, next to the private URL it
    // describes, instead of keeping a second list of calendars.
    z.object({
        type: z.literal("ical"),
        url: z.string().url(),
        hand: z.string().optional(),
    }),
    z.object({
        type: z.literal("caldav"),
        name: z.string(),
        url: z.string().url(),
        homeUrl: z.string().url(),
        username: z.string(),
        password: z.string(),
        hand: z.string().optional(),
    }),
]);

const colorValidator = z.object({ color: z.string() });

export type TestSource = {
    type: "FOR_TEST_ONLY";
    id: string;
    events?: OFCEvent[];
};

export type CalendarInfo = (
    | z.infer<typeof calendarOptionsSchema>
    | TestSource
) &
    z.infer<typeof colorValidator>;

export function parseCalendarInfo(obj: unknown): CalendarInfo {
    const options = calendarOptionsSchema.parse(obj);
    const color = colorValidator.parse(obj);

    return { ...options, ...color };
}

export function safeParseCalendarInfo(obj: unknown): CalendarInfo | null {
    try {
        return parseCalendarInfo(obj);
    } catch (e) {
        if (e instanceof ZodError) {
            console.debug("Parsing calendar info failed with errors", {
                obj,
                error: e.message,
            });
        }
        return null;
    }
}

/**
 * Construct a partial calendar source of the specified type
 */
export function makeDefaultPartialCalendarSource(
    type: CalendarInfo["type"] | "icloud" | "dailytodo"
): Partial<CalendarInfo> {
    if (type === "icloud") {
        return {
            type: "caldav",
            color: getComputedStyle(document.body)
                .getPropertyValue("--interactive-accent")
                .trim(),
            url: "https://caldav.icloud.com",
        };
    }
    if (type === "dailytodo") {
        return {
            type: "dailynote",
            todos: true,
            color: getComputedStyle(document.body)
                .getPropertyValue("--interactive-accent")
                .trim(),
        };
    }

    return {
        type: type,
        color: getComputedStyle(document.body)
            .getPropertyValue("--interactive-accent")
            .trim(),
    };
}
