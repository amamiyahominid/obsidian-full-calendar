import { z, ZodError } from "zod";
import { DateTime, Duration } from "luxon";

const stripTime = (date: DateTime) => {
    // Strip time from luxon dateTime.
    return DateTime.fromObject(
        {
            year: date.year,
            month: date.month,
            day: date.day,
        },
        { zone: "utc" }
    );
};

export const ParsedDate = z.string();
// z.string().transform((val, ctx) => {
//     const parsed = DateTime.fromISO(val, { zone: "utc" });
//     if (parsed.invalidReason) {
//         ctx.addIssue({
//             code: z.ZodIssueCode.custom,
//             message: parsed.invalidReason,
//         });
//         return z.NEVER;
//     }
//     return stripTime(parsed);
// });

export const ParsedTime = z.string();
// z.string().transform((val, ctx) => {
//     let parsed = DateTime.fromFormat(val, "h:mm a");
//     if (parsed.invalidReason) {
//         parsed = DateTime.fromFormat(val, "HH:mm");
//     }

//     if (parsed.invalidReason) {
//         ctx.addIssue({
//             code: z.ZodIssueCode.custom,
//             message: parsed.invalidReason,
//         });
//         return z.NEVER;
//     }

//     return Duration.fromISOTime(
//         parsed.toISOTime({
//             includeOffset: false,
//             includePrefix: false,
//         })
//     );
// });

export const TimeSchema = z.discriminatedUnion("allDay", [
    z.object({ allDay: z.literal(true) }),
    z.object({
        allDay: z.literal(false),
        startTime: ParsedTime,
        endTime: ParsedTime.nullable().default(null),
    }),
]);

export const CommonSchema = z.object({
    title: z.string(),
    id: z.string().optional(),
});

export const EventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("single"),
        date: ParsedDate,
        endDate: ParsedDate.nullable().default(null),
        // `completed` is a boolean since this fork stopped persisting the
        // ISO completion timestamp (the timestamp added churn to frontmatter
        // diffs without buying anything; status now records intent).
        // `false` keeps the explicit "task that isn't done" state.
        completed: ParsedDate.or(z.literal(true))
            .or(z.literal(false))
            .or(z.literal(null))
            .optional(),
        // Workflow stage: Backlog / Ready / In Progress / Review / Done.
        // Free-form string in the schema so callers can extend their own set.
        // metadata-menu's multi-value text type writes the field as a list
        // (`status:\n  - Done`); unwrap a single-element array so those notes
        // still validate.
        status: z.preprocess(
            (val) =>
                Array.isArray(val)
                    ? val.length > 0
                        ? val[0]
                        : undefined
                    : val,
            z.string().optional()
        ),
        // Sprint the task is assigned to, as an ISO week ("2026-W27").
        // Same array-unwrap as status for metadata-menu compatibility; a bare
        // `sprint:` line parses as YAML null, so nulls collapse to undefined —
        // parsed events never carry null. Writers set null explicitly as a
        // deletion marker: modifyFrontmatterString removes the key for
        // null-valued modifications.
        sprint: z.preprocess(
            (val) =>
                Array.isArray(val)
                    ? val.length > 0
                        ? val[0]
                        : undefined
                    : val ?? undefined,
            z.string().nullable().optional()
        ),
    }),
    z.object({
        type: z.literal("recurring"),
        daysOfWeek: z.array(z.enum(["U", "M", "T", "W", "R", "F", "S"])),
        startRecur: ParsedDate.optional(),
        endRecur: ParsedDate.optional(),
    }),
    z.object({
        type: z.literal("rrule"),
        startDate: ParsedDate,
        rrule: z.string(),
        skipDates: z.array(ParsedDate),
    }),
]);

type EventType = z.infer<typeof EventSchema>;
type TimeType = z.infer<typeof TimeSchema>;
type CommonType = z.infer<typeof CommonSchema>;

export type OFCEvent = CommonType & TimeType & EventType;

export function parseEvent(obj: unknown): OFCEvent {
    if (typeof obj !== "object") {
        throw new Error("value for parsing was not an object.");
    }
    const objectWithDefaults = { type: "single", allDay: false, ...obj };
    return {
        ...CommonSchema.parse(objectWithDefaults),
        ...TimeSchema.parse(objectWithDefaults),
        ...EventSchema.parse(objectWithDefaults),
    };
}

export function validateEvent(obj: unknown): OFCEvent | null {
    try {
        return parseEvent(obj);
    } catch (e) {
        if (e instanceof ZodError) {
            console.debug("Parsing failed with errors", {
                obj,
                message: e.message,
            });
        }
        return null;
    }
}
type Json =
    | { [key: string]: Json }
    | Json[]
    | string
    | number
    | true
    | false
    | null;

export function serializeEvent(obj: OFCEvent): Json {
    return { ...obj };
}
