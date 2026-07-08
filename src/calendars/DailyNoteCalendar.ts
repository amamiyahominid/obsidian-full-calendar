import moment from "moment";
import {
    TFile,
    CachedMetadata,
    HeadingCache,
    ListItemCache,
    Loc,
    Pos,
} from "obsidian";
import {
    appHasDailyNotesPluginLoaded,
    createDailyNote,
    getAllDailyNotes,
    getDailyNote,
    getDailyNoteSettings,
    getDateFromFile,
} from "obsidian-daily-notes-interface";
import { EventPathLocation } from "../core/EventStore";
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

const getHeadingPosition = (
    headingText: string,
    metadata: CachedMetadata,
    endOfDoc: Loc
): Pos | null => {
    if (!metadata.headings) {
        return null;
    }

    let level: number | null = null;
    let startingPos: Pos | null = null;
    let endingPos: Pos | null = null;

    for (const heading of metadata.headings) {
        if (!level && heading.heading === headingText) {
            level = heading.level;
            startingPos = heading.position;
        } else if (level && heading.level <= level) {
            endingPos = heading.position;
            break;
        }
    }

    if (!level || !startingPos) {
        return null;
    }

    return { start: startingPos.end, end: endingPos?.start || endOfDoc };
};

const getListsUnderHeading = (
    headingText: string,
    metadata: CachedMetadata
): ListItemCache[] => {
    if (!metadata.listItems) {
        return [];
    }
    const endOfDoc = metadata.sections?.last()?.position.end;
    if (!endOfDoc) {
        return [];
    }
    const headingPos = getHeadingPosition(headingText, metadata, endOfDoc);
    if (!headingPos) {
        return [];
    }
    return metadata.listItems?.filter(
        (l) =>
            headingPos.start.offset < l.position.start.offset &&
            l.position.end.offset <= headingPos.end.offset
    );
};

/**
 * List items in the "TODO region" of a daily note: everything from the top of
 * the file until the first heading or thematic break (`---`), whichever comes
 * first. This matches the daily-note template's layout, where rolled-over
 * TODOs sit at the top of the note above a `---` separator.
 */
export const getTodoRegionListItems = (
    metadata: CachedMetadata
): ListItemCache[] => {
    if (!metadata.listItems) {
        return [];
    }
    const firstHeading = metadata.headings?.[0]?.position.start.offset;
    const firstBreak = metadata.sections?.find(
        (s) => s.type === "thematicBreak"
    )?.position.start.offset;
    const boundary = Math.min(firstHeading ?? Infinity, firstBreak ?? Infinity);
    return metadata.listItems.filter((l) => l.position.start.offset < boundary);
};

const listRegex = /^(\s*)\-\s+(\[(.)\]\s+)?/;
const checkboxRegex = /^\s*\-\s+\[(.)\]\s+/;
const checkboxTodo = (s: string) => {
    const match = s.match(checkboxRegex);
    if (!match || !match[1]) {
        return null;
    }
    return match[1] === " " ? false : match[1];
};

export const getInlineEventFromLine = (
    text: string,
    globalAttrs: Partial<OFCEvent>,
    opts: { implicitTodo?: boolean } = {}
): OFCEvent | null => {
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
    listItems: ListItemCache[],
    fileGlobalAttrs: Partial<OFCEvent>,
    opts: { implicitTodo?: boolean } = {}
): { lineNumber: number; event: OFCEvent }[] {
    const lines = fileText.split("\n");
    const listItemText: Line[] = listItems
        .map((i) => i.position.start.line)
        .map((idx) => ({ lineNumber: idx, text: lines[idx] }));

    return listItemText
        .map((l) => ({
            lineNumber: l.lineNumber,
            event: getInlineEventFromLine(
                l.text,
                {
                    ...fileGlobalAttrs,
                    type: "single",
                },
                opts
            ),
        }))
        .flatMap(({ event, lineNumber }) =>
            event ? [{ event, lineNumber }] : []
        );
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

    return `${whitespacePrefix}- ${
        checkbox || ""
    } ${title} ${generateInlineAttributes(attrs)}`.trimEnd();
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
    heading: HeadingCache | undefined;
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
        appHasDailyNotesPluginLoaded();
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
        const { folder } = getDailyNoteSettings();
        if (!folder) {
            throw new Error("Could not load daily note settings.");
        }
        return folder;
    }

    async getEventsInFile(file: TFile): Promise<EditableEventResponse[]> {
        // @ts-ignore
        const date = getDateFromFile(file, "day")?.format(DATE_FORMAT);
        if (!date) {
            return [];
        }
        const cache = this.app.getMetadata(file);
        if (!cache) {
            return [];
        }
        // TODO mode reads under its heading when one is configured (e.g.
        // "## TODO"); without one it falls back to the top-of-file region.
        const listItems =
            this.todos && !this.heading
                ? getTodoRegionListItems(cache)
                : getListsUnderHeading(this.heading, cache);
        const inlineEvents = await this.app.process(file, (text) =>
            getAllInlineEventsFromFile(
                text,
                listItems,
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
        const notes = getAllDailyNotes();
        const files = Object.values(notes) as TFile[];
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
        const m = moment(event.date);
        let file = getDailyNote(m, getAllDailyNotes()) as TFile;
        if (!file) {
            file = (await createDailyNote(m)) as TFile;
        }

        if (this.todos && !this.heading) {
            const item = this.asTodoItem(event);
            let lineNumber = await this.app.rewrite(file, (contents) => {
                const { page, lineNumber } = addToTodoRegion(contents, item);
                return [page, lineNumber] as [string, number];
            });
            return { file, lineNumber };
        }

        const metadata = await this.app.waitForMetadata(file);

        // A missing heading is fine — addToHeading appends it to the end of
        // the note, so notes created before the work-log workflow just work.
        const headingInfo = metadata.headings?.find(
            (h) => h.heading == this.heading
        );
        const item = this.todos ? this.asTodoItem(event) : event;
        let lineNumber = await this.app.rewrite(file, (contents) => {
            const { page, lineNumber } = addToHeading(
                contents,
                {
                    heading: headingInfo,
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

    private getConcreteLocation({ path, lineNumber }: EventPathLocation): {
        file: TFile;
        lineNumber: number;
    } {
        const file = this.app.getFileByPath(path);
        if (!file) {
            throw new Error(`File not found at path: ${path}`);
        }
        if (!lineNumber) {
            throw new Error(`Daily note events must have a line number.`);
        }
        return { file, lineNumber };
    }

    async deleteEvent(loc: EventPathLocation): Promise<void> {
        const { file, lineNumber } = this.getConcreteLocation(loc);
        this.app.rewrite(file, (contents) => {
            let lines = contents.split("\n");
            lines.splice(lineNumber, 1);
            return lines.join("\n");
        });
    }

    async modifyEvent(
        loc: EventPathLocation,
        newEvent: OFCEvent,
        updateCacheWithLocation: (loc: EventLocation) => void
    ): Promise<void> {
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
        const oldDate = getDateFromFile(file as any, "day")?.format(
            DATE_FORMAT
        );
        if (!oldDate) {
            throw new Error(
                `Could not get date from file at path ${file.path}`
            );
        }
        if (newEvent.date !== oldDate) {
            // Event needs to be moved to a new file.
            console.debug("daily note event moving to a new file.");
            // TODO: Factor this out with the createFile path.
            const m = moment(newEvent.date);
            let newFile = getDailyNote(m, getAllDailyNotes()) as TFile;
            if (!newFile) {
                newFile = (await createDailyNote(m)) as TFile;
            }
            await this.app.read(newFile);

            const metadata = this.app.getMetadata(newFile);
            if (!metadata) {
                throw new Error("No metadata for file " + file.path);
            }
            // A missing heading is fine — addToHeading appends it to the end
            // of the destination note.
            const headingInfo =
                this.todos && !this.heading
                    ? undefined
                    : metadata.headings?.find((h) => h.heading == this.heading);

            await this.app.rewrite(file, async (oldFileContents) => {
                // Open the old file and remove the event.
                let lines = oldFileContents.split("\n");
                lines.splice(lineNumber, 1);
                await this.app.rewrite(newFile, (newFileContents) => {
                    // Before writing that change back to disk, open the new file and add the event.
                    const { page, lineNumber } =
                        this.todos && !this.heading
                            ? addToTodoRegion(
                                  newFileContents,
                                  this.asTodoItem(newEvent)
                              )
                            : addToHeading(
                                  newFileContents,
                                  {
                                      heading: headingInfo,
                                      item: this.todos
                                          ? this.asTodoItem(newEvent)
                                          : newEvent,
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
                const newLine = modifyListItem(
                    lines[lineNumber],
                    this.todos ? this.asTodoItem(newEvent) : newEvent,
                    { omitAllDay: this.todos }
                );
                if (!newLine) {
                    throw new Error("Did not successfully update line.");
                }
                lines[lineNumber] = newLine;
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
