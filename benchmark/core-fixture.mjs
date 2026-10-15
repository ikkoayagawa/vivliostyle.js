/**
 * Deterministic HTML input for Vivliostyle Core regression checks.
 *
 * Generates Japanese prose with stable chapter and paragraph structure.
 */

import { createHash } from "node:crypto";

export const BENCHMARK_SIZES = [40_000, 80_000, 160_000, 320_000];
export const BENCHMARK_POSITIONS = ["start", "middle", "end"];

/** Fixed-size vertical writing layout for regression inputs. */
export const BENCHMARK_CSS = `
@page {
  size: 148mm 105mm;
  margin: 10.5mm 8mm;
}
html {
  writing-mode: vertical-rl;
  font-size: 9pt;
  font-family: "Yu Mincho", "YuMincho", serif;
  line-height: 1.75;
}
body {
  margin: 0;
  padding: 0;
}
h1 {
  font-size: 1em;
  font-weight: bold;
  margin: 0 0 1em 0;
  padding: 0;
  break-before: page;
}
p {
  margin: 0;
  padding: 0;
  text-indent: 1em;
  line-height: 1.75;
}
`.trim();

const PROSE = [
  "　窓を開けると、朝の風が静かに部屋へ入ってきた。遠くの踏切から電車の音が聞こえる。",
  "　彼女は机に置いた手紙を読み返した。昨日とは違う意味が、短い言葉の間に見える気がした。",
  "　川沿いの道には誰もいなかった。木々の葉が揺れ、水面に映る雲がゆっくりと流れていく。",
  "　待ち合わせの時計はまだ動いていた。「少し歩こう」と彼は言い、鞄を持ち直した。",
];

const CHAPTER_KANJI =
  "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";

/**
 * Generate a deterministic HTML document for benchmarking.
 *
 * @param {number} characters - Target total character count (4000–1,000,000)
 * @param {"start"|"middle"|"end"} position - Which chapter to edit in the benchmark
 * @param {number} chapterCount - Number of chapters (default 8)
 * @returns {{ html: string, css: string, editOffset: number, editMarker: string,
 *             characters: number, actualCharacters: number, position: string,
 *             chapterCount: number, editChapter: number, sha256: string }}
 */
export function createBenchmarkFixture(characters, position, chapterCount = 8) {
  if (
    !Number.isSafeInteger(characters) ||
    characters < 4_000 ||
    characters > 1_000_000
  ) {
    throw new Error("Invalid benchmark size");
  }
  if (!BENCHMARK_POSITIONS.includes(position)) {
    throw new Error("Invalid benchmark position");
  }
  if (
    !Number.isSafeInteger(chapterCount) ||
    chapterCount < 2 ||
    chapterCount > 32
  ) {
    throw new Error("Invalid chapter count");
  }

  const editChapter =
    position === "start"
      ? 0
      : position === "middle"
        ? Math.floor(chapterCount / 2)
        : chapterCount - 1;

  const chapters = [];
  for (let chapter = 0; chapter < chapterCount; chapter++) {
    const budget =
      Math.floor(characters / chapterCount) +
      (chapter < characters % chapterCount ? 1 : 0);
    const heading = `第${CHAPTER_KANJI[chapter]}章`;
    const marker = `編集地点${String.fromCharCode(0x4e00 + chapter)}。`;
    let paragraphs = [marker];
    let bodyLen = marker.length;
    for (let p = 0; bodyLen < budget; p++) {
      const line = PROSE[(chapter + p) % PROSE.length];
      paragraphs.push(line);
      bodyLen += line.length;
    }
    // Trim last paragraph so total is close to budget
    const over = bodyLen - budget;
    if (over > 0) {
      const last = paragraphs.at(-1);
      if (last && last.length > over) {
        paragraphs[paragraphs.length - 1] = last.slice(0, last.length - over);
      }
    }
    chapters.push({ heading, paragraphs, marker });
  }

  // Build HTML
  let html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>組版ベンチマーク</title>
</head>
<body>
`;
  let editOffset = -1;
  let actualCharacters = 0;

  for (let i = 0; i < chapters.length; i++) {
    const { heading, paragraphs } = chapters[i];
    html += `<h1>${heading}</h1>\n`;
    for (const para of paragraphs) {
      if (
        i === editChapter &&
        editOffset === -1 &&
        para === chapters[i].marker
      ) {
        // Record the UTF-16 offset at the start of this paragraph text node
        editOffset = html.length + "<p>".length;
      }
      html += `<p>${para}</p>\n`;
      actualCharacters += para.length;
    }
  }
  html += `</body>\n</html>\n`;

  const editMarker = chapters[editChapter].marker;
  const sha256 = createHash("sha256").update(html).digest("hex");

  return {
    html,
    css: BENCHMARK_CSS,
    editOffset,
    editMarker,
    characters,
    actualCharacters,
    position,
    chapterCount,
    editChapter,
    sha256,
  };
}
