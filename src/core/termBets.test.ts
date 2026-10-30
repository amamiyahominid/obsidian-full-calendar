import { betFromCell, parseTermBets } from "./termBets";

describe("betFromCell", () => {
    it("keeps a lone wikilink", () => {
        expect(betFromCell(" [[回復]] ")).toEqual({
            name: "回復",
            title: "[[回復]]",
        });
    });

    it("uses plain text as is", () => {
        expect(betFromCell("時短")).toEqual({ name: "時短", title: "時短" });
    });

    it("takes the text before a parenthesis", () => {
        expect(betFromCell("資産形成（[[お金の設計]]）")).toEqual({
            name: "資産形成",
            title: "資産形成",
        });
    });

    it("skips an empty cell", () => {
        expect(betFromCell("  ")).toBeNull();
    });
});

describe("parseTermBets", () => {
    const page = [
        "---",
        "term: 2026",
        "---",
        "| 営み  | 場    | 手               | 量（時間/週） | 目標  | 判定  |",
        "| --- | ---- | --------------- | ------- | --- | --- |",
        "| 保つ  | 自己   | [[回復]]          | 70      |     |     |",
        "| 練る  | 自己   | 時短              | 1       | x |     |",
        "| 練る  | 自己   | 資産形成（[[お金の設計]]） | 0.5     |     |     |",
        "| 遊ぶ  | 自己   |                 | 5       |     |     |",
        "| 渡す  | 社会   | [[新規事業]]        | 25      |     |     |",
        "",
        "- 手ごとに一行。",
    ].join("\n");

    it("reads the 手 column in table order, skipping empty cells", () => {
        expect(parseTermBets(page).map((h) => h.title)).toEqual([
            "[[回復]]",
            "時短",
            "資産形成",
            "[[新規事業]]",
        ]);
    });

    it("returns nothing without a 手 column", () => {
        expect(parseTermBets("| a | b |\n| - | - |\n| 1 | 2 |")).toEqual([]);
    });
});
