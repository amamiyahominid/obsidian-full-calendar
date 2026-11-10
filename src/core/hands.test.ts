import { handNotes } from "./hands";

const file = (path: string) =>
    ({ path, basename: path.split("/").pop()!.replace(/\.md$/, "") } as any);

describe("handNotes", () => {
    const kinds: Record<string, string | undefined> = {
        "50_knowledge/趣味.md": "hand",
        "anywhere/else/夫婦.md": "hand",
        "50_knowledge/各論.md": "note",
        "50_knowledge/archive/昔の手.md": "hand",
        "50_knowledge/template.md": "hand",
        "no-frontmatter.md": undefined,
    };
    const io = {
        getMarkdownFiles: () => Object.keys(kinds).map(file),
        getMetadata: (f: any) =>
            kinds[f.path] ? { frontmatter: { kind: kinds[f.path] } } : null,
    };

    it("finds notes of kind hand wherever they sit", () => {
        expect(
            handNotes(io)
                .map((h) => h.name)
                .sort()
        ).toEqual(["夫婦", "趣味"].sort());
    });

    it("writes a hand as a link to its note", () => {
        expect(handNotes(io).find((h) => h.name === "趣味")?.title).toBe(
            "[[趣味]]"
        );
    });
});
