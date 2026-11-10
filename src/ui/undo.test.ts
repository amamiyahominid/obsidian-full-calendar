jest.mock("obsidian", () => ({}), { virtual: true });
import { restoredText } from "./undo";

describe("restoredText", () => {
    const before = ["## TODO", "- [ ] a ^1", "- [ ] b ^2", "- [ ] c ^3"].join(
        "\n"
    );
    const afterDelete = ["## TODO", "- [ ] a ^1", "- [ ] c ^3"].join("\n");

    it("gives back the old text when nothing changed since", () => {
        expect(restoredText(before, afterDelete, afterDelete)).toBe(before);
    });

    it("puts the line back without undoing later edits", () => {
        const current = [
            "## TODO",
            "- [x] a ^1",
            "- [ ] c ^3",
            "- [ ] d ^4",
        ].join("\n");
        expect(restoredText(before, afterDelete, current)).toBe(
            [
                "## TODO",
                "- [x] a ^1",
                "- [ ] b ^2",
                "- [ ] c ^3",
                "- [ ] d ^4",
            ].join("\n")
        );
    });

    it("restores a line removed from the end", () => {
        const b = "x\ny\nz";
        const a = "x\ny";
        expect(restoredText(b, a, "x\ny\nmore")).toBe("x\ny\nz\nmore");
    });

    it("clamps when the file got shorter", () => {
        expect(restoredText("a\nb\nc\nd", "a\nb\nc", "a")).toBe("a\nd");
    });

    it("keeps identical neighbouring lines straight", () => {
        expect(restoredText("a\na\nb", "a\nb", "a\nb\nc")).toBe("a\na\nb\nc");
    });
});
