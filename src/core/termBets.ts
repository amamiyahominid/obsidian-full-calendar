import type { App, TFile } from "obsidian";

/*
 * Term bets: the rows of the current term note's table, offered in the
 * session picker beside this sprint's tasks.
 *
 * A term note (one per year, under the configured folder) carries
 * `start`/`end` ISO dates in its frontmatter and a markdown table with a
 * 手 column. Each non-empty cell there is one bet. The cell decides what
 * the work-log line gets as its title:
 *   [[回復]]                    → [[回復]]  (a lone wikilink is kept)
 *   時短                        → 時短      (plain text as is)
 *   資産形成（[[お金の設計]]）  → 資産形成  (text before the parenthesis)
 */

export type TermBet = {
    // Shown in the picker.
    name: string;
    // Written as the work-log line's title.
    title: string;
};

const HAND_COLUMN = "手";
const LONE_LINK = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;

function splitRow(line: string): string[] | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
        return null;
    }
    return trimmed
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
}

const isDivider = (cells: string[]) => cells.every((c) => /^:?-+:?$/.test(c));

export function betFromCell(cell: string): TermBet | null {
    const text = cell.trim();
    if (!text) {
        return null;
    }
    const link = text.match(LONE_LINK);
    if (link) {
        return { name: link[1].trim(), title: `[[${link[1].trim()}]]` };
    }
    const name = text
        .split(/[（(]/)[0]
        .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
        .trim();
    return name ? { name, title: name } : null;
}

/** Bets from the first table that has a 手 column, in table order. */
export function parseTermBets(markdown: string): TermBet[] {
    const lines = markdown.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const header = splitRow(lines[i]);
        const col = header ? header.indexOf(HAND_COLUMN) : -1;
        if (col < 0) {
            continue;
        }
        const bets: TermBet[] = [];
        for (let j = i + 1; j < lines.length; j++) {
            const cells = splitRow(lines[j]);
            if (!cells) {
                break;
            }
            if (isDivider(cells)) {
                continue;
            }
            const bet = betFromCell(cells[col] ?? "");
            if (bet && !bets.some((h) => h.title === bet.title)) {
                bets.push(bet);
            }
        }
        return bets;
    }
    return [];
}

const isoOf = (v: unknown): string | null => {
    if (typeof v === "string") {
        return v.slice(0, 10);
    }
    if (v instanceof Date) {
        return v.toISOString().slice(0, 10);
    }
    return null;
};

/** The term note whose start..end (inclusive) covers `date` (YYYY-MM-DD). */
export function findTermFile(
    app: App,
    folder: string,
    date: string
): TFile | null {
    const prefix = folder.replace(/\/+$/, "") + "/";
    for (const file of app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(prefix)) {
            continue;
        }
        const fm = app.metadataCache.getFileCache(file)?.frontmatter;
        const start = isoOf(fm?.start);
        const end = isoOf(fm?.end);
        if (start && end && start <= date && date <= end) {
            return file;
        }
    }
    return null;
}

export async function termBetsFor(
    app: App,
    folder: string,
    date: string
): Promise<TermBet[]> {
    if (!folder.trim()) {
        return [];
    }
    const file = findTermFile(app, folder.trim(), date);
    if (!file) {
        return [];
    }
    return parseTermBets(await app.vault.cachedRead(file));
}
