import {
    SOURCE_PALETTE,
    STATUS_COLORS,
    nextSourceColor,
    contrastTextColor,
    migrateSourceColor,
} from "./colors";

describe("nextSourceColor", () => {
    it("returns the first palette color when none are used", () => {
        expect(nextSourceColor([])).toBe(SOURCE_PALETTE[0]);
    });

    it("skips colors already in use", () => {
        expect(nextSourceColor([SOURCE_PALETTE[0], SOURCE_PALETTE[1]])).toBe(
            SOURCE_PALETTE[2]
        );
    });

    it("is case-insensitive about used colors", () => {
        expect(nextSourceColor([SOURCE_PALETTE[0].toUpperCase()])).toBe(
            SOURCE_PALETTE[1]
        );
    });

    it("ignores non-palette colors when picking the next one", () => {
        expect(nextSourceColor(["#123456"])).toBe(SOURCE_PALETTE[0]);
    });

    it("cycles once the whole palette is used", () => {
        expect(nextSourceColor([...SOURCE_PALETTE])).toBe(SOURCE_PALETTE[0]);
    });
});

describe("migrateSourceColor", () => {
    it("remaps a legacy palette color to the current palette", () => {
        // Legacy red -> current red (first palette slot).
        expect(migrateSourceColor("#e6194b")).toBe(SOURCE_PALETTE[0]);
    });

    it("is case-insensitive", () => {
        expect(migrateSourceColor("#E6194B")).toBe(SOURCE_PALETTE[0]);
    });

    it("leaves custom (non-legacy) colors unchanged", () => {
        expect(migrateSourceColor("#123456")).toBe("#123456");
    });

    it("leaves current palette colors unchanged", () => {
        expect(migrateSourceColor(SOURCE_PALETTE[2])).toBe(SOURCE_PALETTE[2]);
    });
});

describe("contrastTextColor", () => {
    it("uses black text on light fills", () => {
        expect(contrastTextColor(STATUS_COLORS["In Progress"])).toBe("black");
    });

    it("uses white text on dark fills", () => {
        expect(contrastTextColor("#3b82f6")).toBe("white");
    });
});
