import {
    blockIdsUnder,
    confirmPlan,
    fillPlan,
    routineFor,
    weekdaysOf,
} from "./plan";
import { listLinesUnderHeading } from "./dailyText";

const ROUTINE = [
    "# 決まった枠",
    "",
    "## 毎日",
    "- [[回復を保つ]] [startTime:: 22:00] [endTime:: 23:59]",
    "",
    "## 月 火 木 金",
    "- [[子育て]] [startTime:: 18:00] [endTime:: 20:00]",
    "- [[回復を保つ]] [startTime:: 00:00] [endTime:: 08:30]",
    "",
    "## 平日、土",
    "- [[ボディメイク]] [startTime:: 12:00] [endTime:: 13:30]",
    "",
    "## 日",
    "- [[夫婦]] [startTime:: 09:00] [endTime:: 14:00]",
].join("\n");

const DAY = [
    "## TODO",
    "",
    "- [ ] ",
    "",
    "---",
    "",
    "## Memo",
    "",
    "- ",
    "",
    "---",
    "",
    "## Plan",
    "",
    "---",
    "",
    "## Log",
    "",
].join("\n");

describe("routine", () => {
    it("reads which weekdays a heading names", () => {
        expect(weekdaysOf("毎日")).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(weekdaysOf("月 火 木 金").sort()).toEqual([1, 2, 4, 5]);
        expect(weekdaysOf("平日、土").sort()).toEqual([1, 2, 3, 4, 5, 6]);
        expect(weekdaysOf("決まった枠")).toEqual([]);
    });

    it("gathers a weekday's blocks in time order", () => {
        expect(routineFor(ROUTINE, 2)).toEqual([
            "- [[回復を保つ]] [startTime:: 00:00] [endTime:: 08:30]",
            "- [[ボディメイク]] [startTime:: 12:00] [endTime:: 13:30]",
            "- [[子育て]] [startTime:: 18:00] [endTime:: 20:00]",
            "- [[回復を保つ]] [startTime:: 22:00] [endTime:: 23:59]",
        ]);
        expect(routineFor(ROUTINE, 0)).toEqual([
            "- [[夫婦]] [startTime:: 09:00] [endTime:: 14:00]",
            "- [[回復を保つ]] [startTime:: 22:00] [endTime:: 23:59]",
        ]);
    });
});

describe("filling a day's plan", () => {
    it("puts the routine under Plan, each line named, and nowhere else", () => {
        const page = fillPlan(DAY, routineFor(ROUTINE, 2));
        const lines = page.split("\n");
        expect(listLinesUnderHeading(lines, "Plan").length).toBe(4);
        expect(new Set(blockIdsUnder(page, "Plan")).size).toBe(4);
        expect(listLinesUnderHeading(lines, "Log")).toEqual([]);
        // The rule that closes Plan still follows it, one blank line apart.
        const last = listLinesUnderHeading(lines, "Plan")[3];
        expect(lines.slice(last + 1, last + 3)).toEqual(["", "---"]);
        expect(lines[lines.indexOf("## Plan") + 1]).toBe("");
    });

    it("leaves a day that already has a plan alone", () => {
        const once = fillPlan(DAY, routineFor(ROUTINE, 2));
        expect(fillPlan(once, routineFor(ROUTINE, 2))).toBe(once);
    });

    it("leaves a note without a Plan heading alone", () => {
        const old = "## TODO\n\n## Log\n";
        expect(fillPlan(old, routineFor(ROUTINE, 2))).toBe(old);
    });
});

describe("confirming the plan", () => {
    const planned = fillPlan(DAY, routineFor(ROUTINE, 2));

    it("moves only the blocks that have ended by now", () => {
        const { page, moved } = confirmPlan(planned, "14:00");
        expect(moved).toBe(2);
        const lines = page.split("\n");
        expect(listLinesUnderHeading(lines, "Plan").length).toBe(2);
        const log = listLinesUnderHeading(lines, "Log").map((i) => lines[i]);
        expect(log[0]).toContain("[endTime:: 08:30]");
        expect(log[1]).toContain("[[ボディメイク]]");
        // Lines keep their names when they move.
        expect(blockIdsUnder(page, "Log")).toEqual(
            blockIdsUnder(planned, "Plan").slice(0, 2)
        );
    });

    it("moves everything for a past day, and nothing twice", () => {
        const { page, moved } = confirmPlan(planned, null);
        expect(moved).toBe(4);
        expect(listLinesUnderHeading(page.split("\n"), "Plan")).toEqual([]);
        expect(confirmPlan(page, null).moved).toBe(0);
    });

    it("appends below what the log already holds", () => {
        const withLog = planned.replace(
            "## Log\n",
            "## Log\n\n- [[x]] [startTime:: 09:00] [endTime:: 10:00] ^zzz999\n"
        );
        const { page } = confirmPlan(withLog, "09:00");
        expect(blockIdsUnder(page, "Log")[0]).toBe("zzz999");
        expect(blockIdsUnder(page, "Log").length).toBe(2);
    });
});
