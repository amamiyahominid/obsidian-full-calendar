import { findPlaceholder } from "../core/dailyText";
import { TFile } from "obsidian";
import { EventPathLocation } from "../core/EventStore";
import {
    allDailyFiles,
    dailyFile,
    dateOfFile,
    ensureDaily,
    getDailySettings,
} from "../core/dailyService";
import {
    blockIdFromEventId,
    blockIdOf,
    findHeading,
    findLineByBlockId,
    lineEventId,
    listLinesInTopRegion,
    listLinesUnderHeading,
    newBlockId,
    stripBlockId,
} from "../core/dailyText";
import { ObsidianInterface } from "../ObsidianAdapter";
import { OFCEvent, EventLocation, CalendarInfo, validateEvent } from "../types";
import { EventResponse } from "./Calendar";
import { EditableCalendar, EditableEventResponse } from "./EditableCalendar";

const DATE_FORMAT = "YYYY-MM-DD";

// PARSING

type Line = {
    text: string;
    lineNumber: number;
};

const parseBool = (s: string): boolean | string =>
    s === "true" ? true : s === "false" ? false : s;

const fieldRegex = /\[([^\]]+):: ?([^\]]+)\]/g;
export function getInlineAttributes(
    s: string
): Record<string, string | boolean> {
    return Object.fromEntries(
        Array.from(s.matchAll(fieldRegex)).map((m) => [m[1], parseBool(m[2])])
    );
}

const listRegex = /^(\s*)\-\s+(\[(.)\]\s+)?/;
const checkboxRegex = /^\s*\-\s+\[(.)\]\s+/;
const checkboxTodo = (s: string) => {
    const match = s.match(checkboxRegex);
    if (!match || !match[1]) {
        return null;
    }
    // Normalize to a boolean: toggleTask writes `completed: true`, and if the
    // parse returned the raw character ("x") instead, every toggle made the
    // stored event differ from the re-parse, re-keying the whole file's
    // events — and the next click on the stale ID silently failed.
    return match[1] !== " ";
};

export const getInlineEventFromLine = (
    text: string,
    globalAttrs: Partial<OFCEvent>,
    opts: { implicitTodo?: boolean } = {}
): OFCEvent | null => {
    // A trailing block id (" ^k3f9aq") names the line; it is not part of
    // the title. The event's id adds the note's date, since a block id is
    // only unique within its note.
    const blockId = blockIdOf(text);
    if (blockId) {
        text = stripBlockId(text);
        const date = (globalAttrs as { date?: string }).date;
        globalAttrs = {
            ...globalAttrs,
            id: date ? lineEventId(date, blockId) : blockId,
        };
    }
    const attrs = getInlineAttributes(text);

    if (Object.keys(attrs).length === 0) {
        // In TODO mode, a bare checkbox line counts as an all-day task on the
        // note's day; anything without a checkbox is prose. Outside TODO mode,
        // lines without inline attributes are never events.
        const completed = opts.implicitTodo ? checkboxTodo(text) : null;
        if (completed === null) {
            return null;
        }
        const title = text.replace(listRegex, "").trim();
        if (!title) {
            // "- [ ]" with no text would render as a blank block.
            return null;
        }
        return validateEvent({
            title,
            completed,
            ...globalAttrs,
            allDay: true,
        });
    }

    return validateEvent({
        title: text.replace(listRegex, "").replace(fieldRegex, "").trim(),
        completed: checkboxTodo(text),
        ...globalAttrs,
        ...attrs,
    });
};

function getAllInlineEventsFromFile(
    fileText: string,
    listLines: (lines: string[]) => number[],
    fileGlobalAttrs: Partial<OFCEvent>,
    opts: { implicitTodo?: boolean } = {}
): { lineNumber: number; event: OFCEvent }[] {
    const lines = fileText.split("\n");
    const seen = new Set<string>();
    const out: { lineNumber: number; event: OFCEvent }[] = [];
    for (const lineNumber of listLines(lines)) {
        const event = getInlineEventFromLine(
            lines[lineNumber],
            { ...fileGlobalAttrs, type: "single" },
            opts
        );
        if (!event) {
            continue;
        }
        // A copied line carries its block id along. Two events with one id
        // can't both be stored, so only the first keeps it; the copy reads
        // as a line with no id (and gets its own when next written).
        if (event.id) {
            if (seen.has(event.id)) {
                delete event.id;
            } else {
                seen.add(event.id);
            }
        }
        out.push({ lineNumber, event });
    }
    return out;
}

// SERIALIZATION

const generateInlineAttributes = (attrs: Record<string, any>): string => {
    return Object.entries(attrs)
        .map(([k, v]) => `[${k}:: ${v}]`)
        .join("  ");
};

const makeListItem = (
    data: OFCEvent,
    whitespacePrefix: string = "",
    opts: { omitAllDay?: boolean } = {}
): string => {
    if (data.type !== "single") {
        throw new Error("Can only pass in single event.");
    }
    const { completed, title } = data;
    const checkbox = (() => {
        if (completed !== null && completed !== undefined) {
            return `[${completed ? "x" : " "}]`;
        }
        return null;
    })();

    const attrs: Partial<OFCEvent> = { ...data };
    // The line's name goes last, as a block id — after the inline fields,
    // where Obsidian expects it. (An id of any other shape, i.e. a
    // hand-written `[id:: x]`, stays an inline field.)
    const blockId = blockIdFromEventId(data.id);
    if (blockId) {
        delete attrs["id"];
    }
    delete attrs["completed"];
    delete attrs["title"];
    delete attrs["type"];
    delete attrs["date"];

    for (const key of <(keyof OFCEvent)[]>Object.keys(attrs)) {
        if (attrs[key] === undefined || attrs[key] === null) {
            delete attrs[key];
        }
    }

    // In TODO mode the checkbox alone marks the line as an all-day task, and
    // writing `[allDay:: true]` would get copied around by the daily-note
    // template's rollover — so leave implicit lines attribute-free.
    if (!attrs["allDay"] || opts.omitAllDay) {
        delete attrs["allDay"];
    }

    const line = `${whitespacePrefix}- ${
        checkbox || ""
    } ${title} ${generateInlineAttributes(attrs)}`.trimEnd();
    return blockId ? `${line} ^${blockId}` : line;
};

const modifyListItem = (
    line: string,
    data: OFCEvent,
    opts: { omitAllDay?: boolean } = {}
): string | null => {
    const listMatch = line.match(listRegex);
    if (!listMatch) {
        console.warn(
            "Tried modifying a list item with a position that wasn't a list item",
            { line }
        );
        return null;
    }

    return makeListItem(data, listMatch[1], opts);
};

/**
 * Add a list item to a given heading.
 * If the heading is undefined, then append the heading to the end of the file.
 */
// TODO: refactor this to not do the weird props thing
type AddToHeadingProps = {
    // Where the heading is. Only its line and level are used, so both
    // Obsidian's HeadingCache and a position read from the text fit.
    heading:
        | { position: { start: { line: number } }; level: number }
        | undefined;
    item: OFCEvent;
    headingText: string;
};
export const addToHeading = (
    page: string,
    { heading, item, headingText }: AddToHeadingProps,
    opts: { omitAllDay?: boolean } = {}
): { page: string; lineNumber: number } => {
    let lines = page.split("\n");

    const listItem = makeListItem(item, "", opts);
    if (heading) {
        const headingLine = heading.position.start.line;
        // Keep a blank line between the heading and the first entry; add it
        // if missing (this also retrofits sections written before this
        // convention — the metadata-cache update refreshes the shifted line
        // numbers of any entries below).
        if (
            headingLine + 1 >= lines.length ||
            lines[headingLine + 1].trim() !== ""
        ) {
            lines.splice(headingLine + 1, 0, "");
        }
        const firstEntryLine = headingLine + 2;
        // Append at the END of the heading's section so entries read
        // chronologically (a work log grows downward). The section ends at
        // the next heading of the same or higher level, or at EOF; trailing
        // blank lines stay below the inserted item.
        let boundary = lines.length;
        for (let i = firstEntryLine; i < lines.length; i++) {
            const match = lines[i].match(/^(#{1,6})\s/);
            if (match && match[1].length <= heading.level) {
                boundary = i;
                break;
            }
            // Horizontal rules separate sections in the daily template;
            // entries must land above the rule, not after it.
            if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i])) {
                boundary = i;
                break;
            }
        }
        // The template's empty line is where the first entry goes.
        const placeholder = findPlaceholder(lines, firstEntryLine, boundary);
        if (placeholder >= 0) {
            lines[placeholder] = listItem;
            return { page: lines.join("\n"), lineNumber: placeholder };
        }
        let lineNumber = boundary;
        while (
            lineNumber > firstEntryLine &&
            lines[lineNumber - 1].trim() === ""
        ) {
            lineNumber--;
        }
        lines.splice(lineNumber, 0, listItem);
        // Keep one visible blank line under the section: between the last
        // entry and the next heading, or at the end of the note. (A single
        // trailing "" after join() is just the final newline, not a blank
        // line, hence the doubled push at EOF.)
        const after = lineNumber + 1;
        if (after === lines.length) {
            lines.push("", "");
        } else if (lines[after].trim() !== "") {
            lines.splice(after, 0, "");
        } else if (after === lines.length - 1 && lines[after] === "") {
            lines.push("");
        }
        return { page: lines.join("\n"), lineNumber };
    } else {
        // Separate the new section from the note body with a blank line
        // above the heading, one between the heading and the entry, and one
        // below the entry.
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
            lines.pop();
        }
        if (lines.length > 0) {
            lines.push("");
        }
        lines.push(`## ${headingText}`, "");
        const lineNumber = lines.length;
        lines.push(listItem);
        lines.push("", "");
        return { page: lines.join("\n"), lineNumber };
    }
};

/**
 * Add a checkbox list item to the top of the note's TODO region (after YAML
 * frontmatter if present), attribute-free so the daily-note template's
 * rollover treats it like any hand-written TODO.
 */
const addToTodoRegion = (
    page: string,
    item: OFCEvent
): { page: string; lineNumber: number } => {
    const lines = page.split("\n");
    let insertAt = 0;
    if (lines[0]?.trim() === "---") {
        const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
        if (close > 0) {
            insertAt = close + 1;
        }
    }
    lines.splice(insertAt, 0, makeListItem(item, "", { omitAllDay: true }));
    return { page: lines.join("\n"), lineNumber: insertAt };
};

/** A heading's place, read from the text, in the shape addToHeading takes. */
const headingRef = (lines: string[], text: string) => {
    const h = findHeading(lines, text);
    return h
        ? { position: { start: { line: h.line } }, level: h.level }
        : undefined;
};

export default class DailyNoteCalendar extends EditableCalendar {
    app: ObsidianInterface;
    heading: string;
    /** TODO mode: parse bare checkbox lines at the top of the note instead
     * of attribute lines under `heading`. */
    readonly todos: boolean;

    constructor(
        app: ObsidianInterface,
        color: string,
        heading: string,
        todos: boolean = false
    ) {
        super(color);
        this.app = app;
        this.heading = heading;
        this.todos = todos;
    }

    get type(): CalendarInfo["type"] {
        return "dailynote";
    }
    get identifier(): string {
        return this.todos ? "%todos%" : this.heading;
    }
    get name(): string {
        return this.todos
            ? "Daily note TODOs"
            : `Daily note under "${this.heading}"`;
    }
    get directory(): string {
        return getDailySettings().folder;
    }

    async getEventsInFile(file: TFile): Promise<EditableEventResponse[]> {
        const date = dateOfFile(file);
        if (!date) {
            return [];
        }
        // Structure is read from the note's own text (core/dailyText), not
        // from Obsidian's parsed metadata: the text is what gets rewritten,
        // so reading it keeps line numbers and content from one source.
        // TODO mode reads under its heading when one is configured (e.g.
        // "## TODO"); without one it falls back to the top-of-file region.
        const listLines = (lines: string[]) =>
            this.todos && !this.heading
                ? listLinesInTopRegion(lines)
                : listLinesUnderHeading(lines, this.heading);
        const inlineEvents = await this.app.process(file, (text) =>
            getAllInlineEventsFromFile(
                text,
                listLines,
                { date },
                { implicitTodo: this.todos }
            )
        );
        return inlineEvents.map(({ event, lineNumber }) => [
            event,
            { file, lineNumber },
        ]);
    }

    async getEvents(): Promise<EventResponse[]> {
        const notes = allDailyFiles(this.app);
        const files = notes;
        return (
            await Promise.all(files.map((f) => this.getEventsInFile(f)))
        ).flat();
    }

    async createEvent(event: OFCEvent): Promise<EventLocation> {
        if (event.type !== "single" && event.type !== undefined) {
            console.debug(
                "tried creating a recurring event in a daily note",
                event
            );
            throw new Error("Cannot create a recurring event in a daily note.");
        }
        if (!event.date) {
            throw new Error("A daily note event needs a date.");
        }
        const file = await ensureDaily(this.app, event.date);

        const date = event.date;
        if (this.todos && !this.heading) {
            let lineNumber = await this.app.rewrite(file, (contents) => {
                const item = this.named(
                    this.asTodoItem(event),
                    contents.split("\n"),
                    date
                );
                event.id = item.id;
                const { page, lineNumber } = addToTodoRegion(contents, item);
                return [page, lineNumber] as [string, number];
            });
            return { file, lineNumber };
        }

        // A note created a moment ago may still be getting its template;
        // wait until Obsidian has indexed it before writing into it.
        await this.app.waitForMetadata(file);

        let lineNumber = await this.app.rewrite(file, (contents) => {
            const lines = contents.split("\n");
            const item = this.named(
                this.todos ? this.asTodoItem(event) : event,
                lines,
                date
            );
            // The caller stores this same object: give it the line's name
            // so the cache knows the event by the id that is on disk.
            event.id = item.id;
            const { page, lineNumber } = addToHeading(
                contents,
                {
                    // A missing heading is fine — addToHeading appends it
                    // to the end of the note.
                    heading: headingRef(lines, this.heading),
                    item,
                    headingText: this.heading,
                },
                { omitAllDay: this.todos }
            );
            return [page, lineNumber] as [string, number];
        });
        return { file, lineNumber };
    }

    /**
     * Ensure a TODO-mode line stays parseable when written back: an implicit
     * (attribute-free) all-day line is only recognized by its checkbox, so
     * give it one if the event doesn't have a completion state yet.
     */
    private asTodoItem(event: OFCEvent): OFCEvent {
        if (
            event.type === "single" &&
            event.allDay &&
            (event.completed === undefined || event.completed === null)
        ) {
            return { ...event, completed: false };
        }
        return event;
    }

    /**
     * Stored line numbers go stale between the metadata cache's debounced
     * refreshes (e.g. two quick drags in a row). Verify the recorded line
     * still holds this event's title; if not, re-locate it by title — and
     * refuse to touch anything when that isn't unambiguous, rather than
     * splicing a wrong line and corrupting the note.
     */
    /**
     * The event with a line name. One it already has is kept unless another
     * line of this note holds it (a line moved in from a different day);
     * otherwise it gets a fresh one. `onDisk` is the id the line being
     * rewritten carries in the note, which wins over everything.
     */
    private named(
        event: OFCEvent,
        lines: string[],
        date: string,
        onDisk?: string | null
    ): OFCEvent {
        const own = blockIdFromEventId(event.id);
        const blockId =
            onDisk ??
            (own && findLineByBlockId(lines, own) < 0
                ? own
                : newBlockId(lines));
        return { ...event, id: lineEventId(date, blockId) };
    }

    private findEventLine(
        lines: string[],
        lineNumber: number,
        title: string,
        id?: string
    ): number | null {
        // A line that has a name is found by its name, wherever it moved
        // to and whatever else shares its title.
        const blockId = blockIdFromEventId(id);
        if (blockId) {
            const at = findLineByBlockId(lines, blockId);
            if (at >= 0) {
                return at;
            }
        }
        const wanted = title.trim();
        const matches = (line: string | undefined): boolean => {
            if (line === undefined || !line.match(listRegex)) {
                return false;
            }
            const text = stripBlockId(line)
                .replace(listRegex, "")
                .replace(fieldRegex, "")
                .trim();
            return text === wanted;
        };
        if (matches(lines[lineNumber])) {
            return lineNumber;
        }
        const hits: number[] = [];
        lines.forEach((line, i) => {
            if (matches(line)) {
                hits.push(i);
            }
        });
        return hits.length === 1 ? hits[0] : null;
    }

    private getConcreteLocation({ path, lineNumber }: EventPathLocation): {
        file: TFile;
        lineNumber: number;
    } {
        const file = this.app.getFileByPath(path);
        if (!file) {
            throw new Error(`File not found at path: ${path}`);
        }
        if (lineNumber === undefined || lineNumber === null) {
            throw new Error(`Daily note events must have a line number.`);
        }
        return { file, lineNumber };
    }

    async deleteEvent(loc: EventPathLocation, event?: OFCEvent): Promise<void> {
        const { file, lineNumber } = this.getConcreteLocation(loc);
        // Awaited: the caller's next step may be another edit of this same
        // note, which must see this one already written.
        await this.app.rewrite(file, (contents) => {
            let lines = contents.split("\n");
            // Same care as a rewrite: find the line by name (or title)
            // instead of trusting a stored line number with a deletion.
            const target = event
                ? this.findEventLine(lines, lineNumber, event.title, event.id)
                : lineNumber;
            if (target === null) {
                throw new Error(
                    `Could not find "${event?.title}" in ${file.path} — the note just changed. Try again.`
                );
            }
            lines.splice(target, 1);
            return lines.join("\n");
        });
    }

    async modifyEvent(
        loc: EventPathLocation,
        newEvent: OFCEvent,
        updateCacheWithLocation: (loc: EventLocation) => void,
        oldEvent?: OFCEvent
    ): Promise<void> {
        // Relocation must match what's on disk NOW, i.e. the PRE-edit title.
        const needle = (oldEvent ?? newEvent).title;
        const needleId = (oldEvent ?? newEvent).id;
        console.debug("modified daily note event");
        if (newEvent.type !== "single" && newEvent.type !== undefined) {
            throw new Error(
                "Recurring events in daily notes are not supported."
            );
        }
        if (newEvent.endDate) {
            throw new Error(
                "Multi-day events are not supported in daily notes."
            );
        }
        const { file, lineNumber } = this.getConcreteLocation(loc);
        const oldDate = dateOfFile(file);
        if (!oldDate) {
            throw new Error(
                `Could not get date from file at path ${file.path}`
            );
        }
        if (newEvent.date !== oldDate) {
            // Event needs to be moved to a new file.
            console.debug("daily note event moving to a new file.");
            // TODO: Factor this out with the createFile path.
            if (!newEvent.date) {
                throw new Error("A daily note event needs a date.");
            }
            const newFile = await ensureDaily(this.app, newEvent.date);
            // The target note may have JUST been created — wait for its
            // metadata instead of racing the cache and appending a duplicate
            // heading at the end of the file.
            await this.app.waitForMetadata(newFile);

            await this.app.rewrite(file, async (oldFileContents) => {
                // Open the old file and remove the event.
                let lines = oldFileContents.split("\n");
                const sourceLine = this.findEventLine(
                    lines,
                    lineNumber,
                    needle,
                    needleId
                );
                if (sourceLine === null) {
                    throw new Error(
                        `Could not find "${needle}" in ${file.path} — the note just changed. Try again.`
                    );
                }
                lines.splice(sourceLine, 1);
                await this.app.rewrite(newFile, (newFileContents) => {
                    // Before writing that change back to disk, open the new file and add the event.
                    const newLines = newFileContents.split("\n");
                    // The line keeps its name across days when it can; the
                    // event id follows the note it now lives in.
                    const item = this.named(
                        this.todos ? this.asTodoItem(newEvent) : newEvent,
                        newLines,
                        newEvent.date as string
                    );
                    newEvent.id = item.id;
                    const { page, lineNumber } =
                        this.todos && !this.heading
                            ? addToTodoRegion(newFileContents, item)
                            : addToHeading(
                                  newFileContents,
                                  {
                                      // A missing heading is fine —
                                      // addToHeading appends it.
                                      heading: headingRef(
                                          newLines,
                                          this.heading
                                      ),
                                      item,
                                      headingText: this.heading,
                                  },
                                  { omitAllDay: this.todos }
                              );
                    // Before any file changes are committed, call the updateCacheWithLocation callback to ensure
                    // the cache is properly updated with the new location.
                    updateCacheWithLocation({ file: newFile, lineNumber });
                    return page;
                });
                return lines.join("\n");
            });
        } else {
            console.debug("daily note event staying in same file.");
            updateCacheWithLocation({ file, lineNumber });
            await this.app.rewrite(file, (contents) => {
                const lines = contents.split("\n");
                const target = this.findEventLine(
                    lines,
                    lineNumber,
                    needle,
                    needleId
                );
                if (target === null) {
                    throw new Error(
                        `Could not find "${needle}" in ${file.path} — the note just changed. Try again.`
                    );
                }
                // A line with no name yet gets one on its first rewrite.
                const item = this.named(
                    this.todos ? this.asTodoItem(newEvent) : newEvent,
                    lines,
                    oldDate,
                    blockIdOf(lines[target])
                );
                newEvent.id = item.id;
                const newLine = modifyListItem(lines[target], item, {
                    omitAllDay: this.todos,
                });
                if (!newLine) {
                    throw new Error("Did not successfully update line.");
                }
                lines[target] = newLine;
                return lines.join("\n");
            });
        }
    }

    move(
        from: EventPathLocation,
        to: EditableCalendar
    ): Promise<EventLocation> {
        throw new Error("Method not implemented.");
    }
}
