// Mechanical checks for docs/ux.md. What the rules say must go through one
// place is refused here when it doesn't, so a drift can't land quietly.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const problems = [];
const say = (file, line, text) => problems.push(`${file}:${line}  ${text}`);

// ---- overrides.css: durations and meaning-colours only via variables ----
const cssPath = "src/ui/overrides.css";
const css = readFileSync(cssPath, "utf8").split("\n");
// The one block that defines the variables.
const tokensEnd = css.findIndex((l, i) => i > 0 && l.trim() === "}");
css.forEach((line, i) => {
    if (i <= tokensEnd) {
        return;
    }
    const code = line.replace(/\/\*.*?\*\//g, "");
    if (/^\s*(\/\*|\*)/.test(line)) {
        return;
    }
    if (
        /(animation|transition)[^:]*:/.test(code) &&
        /\b\d*\.?\d+m?s\b/.test(code)
    ) {
        say(cssPath, i + 1, "生の秒数。--ofc-fx-s / -m / -l を使う。");
    }
    if (/--color-(green|red)(-rgb)?\b/.test(code)) {
        say(cssPath, i + 1, "生の緑・赤。--ofc-running / --ofc-late を使う。");
    }
    if (/#14a3a3/i.test(code)) {
        say(cssPath, i + 1, "手の色は --ofc-hand を使う。");
    }
    if (/^\s*(color|background-color):\s*(white|black)\s*;/.test(code)) {
        say(cssPath, i + 1, "生の色。テーマの変数を使う。");
    }
});

// ---- motion: only the three sizes ----
const allowedFx = new Set(["ofc-fx-arrive", "ofc-fx-touch", "ofc-fx-done"]);
const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
const sources = walk("src").filter(
    (p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)
);
for (const file of [...sources, cssPath]) {
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
            for (const m of line.matchAll(/\bofc-fx-[a-z]+\b/g)) {
                if (
                    !allowedFx.has(m[0]) &&
                    !/^ofc-fx-[sml]$/.test(m[0])
                ) {
                    say(file, i + 1, `三段に無い動き：${m[0]}`);
                }
            }
        });
}

// ---- deletes from the UI go through undo ----
for (const file of sources.filter((p) => p.startsWith("src/ui"))) {
    if (file.endsWith("undo.ts")) {
        continue;
    }
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
            if (/cache\.deleteEvent\(/.test(line)) {
                say(file, i + 1, "deleteWithUndo を通さない削除。");
            }
        });
}

if (problems.length > 0) {
    console.error("docs/ux.md に合わない所があります：\n");
    console.error(problems.join("\n"));
    process.exit(1);
}
console.log("ux: ok");
