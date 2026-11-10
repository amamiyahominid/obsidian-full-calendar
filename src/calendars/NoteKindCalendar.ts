import { TFile } from "obsidian";
import { ObsidianInterface } from "../ObsidianAdapter";
import { EventLocation, OFCEvent } from "../types";
import { EditableEventResponse } from "./EditableCalendar";
import FullNoteCalendar, {
    filenameForEvent,
    modifyFrontmatterString,
    taskFrontmatter,
} from "./FullNoteCalendar";
import { EventPathLocation } from "../core/EventStore";
import { EditableCalendar } from "./EditableCalendar";

/*
 * Notes found by what they ARE, not by where they sit (docs/format.md):
 * a note is a task because its frontmatter says `kind: task`, and it
 * belongs to a project because its `project` links to that project's note.
 * Folders can be renamed and notes moved without anything going missing.
 *
 * One calendar per project holds that project's tasks, so the project is
 * still what a card's colour and name come from.
 * Reading scans the vault's notes; writing a new task puts it in `tasks/`
 * beside the project's note — a place to put it, not a way to find it.
 */

export type NoteKind = "task";

export type ProjectRef = {
    // The project note's basename: what `project: "[[…]]"` links to.
    name: string;
    // The project note's path, for where new tasks are created.
    path: string;
};

/**
 * Archived and template notes take no part: a path with a folder named
 * `archive` (or ending in `_archive`, as in `99_archive`) or `template`,
 * and any note itself named `template`.
 */
export function isSetAside(path: string): boolean {
    const parts = path.split("/");
    const name = (parts.pop() ?? "").replace(/\.md$/, "");
    return (
        name === "template" ||
        parts.some((p) => p === "template" || /(^|_)archive$/i.test(p))
    );
}

/** "[[Note|alias]]" / "[[Note#h]]" / "Note" → "Note". */
export function linkTarget(value: unknown): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") {
        return null;
    }
    const m = raw.match(/^\s*\[\[([^\]]*)\]\]\s*$/);
    const name = (m ? m[1] : raw).split("|")[0].split("#")[0].trim();
    // A link may be written with its folder; the note's name is what counts.
    return name ? name.split("/").pop()!.replace(/\.md$/, "") : null;
}

export default class NoteKindCalendar extends FullNoteCalendar {
    readonly kind: NoteKind;
    readonly project: ProjectRef | null;

    constructor(
        app: ObsidianInterface,
        color: string,
        kind: NoteKind,
        project: ProjectRef | null = null
    ) {
        // The directory is only where NEW notes go.
        super(
            app,
            color,
            project
                ? `${project.path.split("/").slice(0, -1).join("/")}/tasks`
                : ""
        );
        this.kind = kind;
        this.project = project;
    }

    get identifier(): string {
        return this.project
            ? `project/${this.project.name}`
            : `kind/${this.kind}`;
    }

    get name(): string {
        return this.project?.name ?? "Tasks";
    }

    /** Any note might be (or have just become, or stopped being) ours. */
    containsPath(path: string): boolean {
        return path.endsWith(".md");
    }

    private owns(file: TFile): boolean {
        if (isSetAside(file.path)) {
            return false;
        }
        const fm = this.app.getMetadata(file)?.frontmatter;
        if (!fm || fm.kind !== this.kind) {
            return false;
        }
        return !this.project || linkTarget(fm.project) === this.project.name;
    }

    async getEventsInFile(file: TFile): Promise<EditableEventResponse[]> {
        return this.owns(file) ? super.getEventsInFile(file) : [];
    }

    async getEvents(): Promise<EditableEventResponse[]> {
        const events: EditableEventResponse[] = [];
        for (const file of this.app.getMarkdownFiles()) {
            events.push(...(await this.getEventsInFile(file)));
        }
        return events;
    }

    /**
     * Moving a task to another project is rewriting its `project` link —
     * that link is what the task belongs by. The note is then also filed
     * under the new project's `tasks/`, so the folders keep telling the
     * same story as the links.
     */
    async move(
        fromLocation: EventPathLocation,
        toCalendar: EditableCalendar,
        updateCacheWithLocation: (loc: EventLocation) => void
    ): Promise<void> {
        if (
            !(toCalendar instanceof NoteKindCalendar) ||
            !toCalendar.project ||
            this.kind !== "task"
        ) {
            throw new Error("A task can only be moved to another project.");
        }
        const file = this.app.getFileByPath(fromLocation.path);
        if (!file) {
            throw new Error(`File ${fromLocation.path} not found.`);
        }
        const link = `"[[${toCalendar.project.name}]]"`;
        await this.app.rewrite(file, (page) =>
            modifyFrontmatterString(page, {
                project: link,
            } as unknown as Partial<OFCEvent>)
        );
        const newPath = `${toCalendar.directory}/${file.name}`;
        if (newPath === file.path || this.app.getAbstractFileByPath(newPath)) {
            updateCacheWithLocation({ file, lineNumber: undefined });
            return;
        }
        if (!this.app.getAbstractFileByPath(toCalendar.directory)) {
            await this.app.createFolder(toCalendar.directory);
        }
        updateCacheWithLocation({
            file: { path: newPath },
            lineNumber: undefined,
        });
        await this.app.rename(file, newPath);
    }

    async createEvent(event: OFCEvent): Promise<EventLocation> {
        if (!this.project || (event.type && event.type !== "single")) {
            throw new Error(
                "New notes of this kind are made from their template, not here."
            );
        }
        if (!this.app.getAbstractFileByPath(this.directory)) {
            await this.app.createFolder(this.directory);
        }
        const path = `${this.directory}/${filenameForEvent(event)}`;
        if (this.app.getAbstractFileByPath(path)) {
            throw new Error(`Event at ${path} already exists.`);
        }
        const file = await this.app.create(
            path,
            taskFrontmatter(
                {
                    ...(event as Extract<OFCEvent, { type: "single" }>),
                    // A task always has a status; the first stage if unset.
                    status: event.status ?? "Backlog",
                },
                this.project.name
            )
        );
        return { file, lineNumber: undefined };
    }
}
