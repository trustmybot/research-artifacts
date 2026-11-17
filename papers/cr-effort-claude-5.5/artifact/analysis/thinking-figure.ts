import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { median, readCsv } from "./lib.ts";
import { ARMS, MODELS, MUTED, SERIES, SURFACE, TEXT, line, modelLabel, svgDocument, text } from "./svg.ts";

const { values } = parseArgs({ options: { reviews: { type: "string" }, out: { type: "string" } } });
if (!values.reviews || !values.out) {
  console.error("usage: node thinking-figure.ts --reviews <reviews.csv> --out <figures dir>");
  process.exit(2);
}
const rows = readCsv(values.reviews);
mkdirSync(values.out, { recursive: true });

const tokens = (raw: string, where: string): number => {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value < 0) throw new Error(`bad thinking_tokens "${raw}" at ${where}`);
  return value;
};
const settings = MODELS.flatMap(([m, name], mi) =>
  ARMS.map((a) => {
    const counts = rows.filter((r) => r.model === m && r.effort === a).map((r, i) => tokens(r.thinking_tokens, `${m} ${a} row ${i}`));
    if (counts.length === 0) throw new Error(`no reviews for ${m} ${a}`);
    return { model: m, name, mi, arm: a, values: counts, zero: counts.filter((v) => v === 0).length, median: median(counts) };
  }),
);

const COLUMN = 88, GAP = 24, X0 = 84, X1 = X0 + 9 * COLUMN + 2 * GAP, Y0 = 104, Y1 = 404, W = X1 + 32, H = 500;
const maxTokens = Math.max(...settings.flatMap((s) => s.values));
const top = 10 ** (Math.ceil(Math.log10(maxTokens + 1) * 2) / 2);
const fy = (v: number) => Y1 - (Math.log10(1 + v) / Math.log10(1 + top)) * (Y1 - Y0);
const columnCenter = (mi: number, ai: number) => X0 + mi * (3 * COLUMN + GAP) + (ai + 0.5) * COLUMN;
const jitter = (i: number) => (((i * 0.6180339887) % 1) - 0.5) * COLUMN * 0.6;

const body: string[] = [
  text(24, 30, "Thinking Tokens per Review by Model and Effort", { size: 14, color: TEXT, weight: 600 }),
  text(24, 48, "Each dot is one review; the dark bar is the median. Zero-token reviews sit on the 0 baseline.", { size: 12 }),
];
const ticks = [0, ...Array.from({ length: Math.floor(Math.log10(top)) }, (_, k) => 10 ** (k + 1))];
for (const t of ticks) body.push(line(X0, fy(t), X1, fy(t)), text(X0 - 6, fy(t) + 4, t.toLocaleString("en-US"), { anchor: "end", size: 11 }));
body.push(`<text x="0" y="0" transform="translate(30 ${((Y0 + Y1) / 2).toFixed(1)}) rotate(-90)" font-size="11" fill="${MUTED}" text-anchor="middle">Thinking Tokens per Review (Log Scale)</text>`);

const desc: string[] = [];
for (const s of settings) {
  const ai = ARMS.indexOf(s.arm);
  const cx = columnCenter(s.mi, ai);
  if (ai === 1) body.push(text(cx, Y0 - 16, modelLabel(s.model), { anchor: "middle", size: 13, color: SERIES[s.mi], weight: 600 }));
  s.values.forEach((v, i) => body.push(`<circle cx="${(cx + jitter(i)).toFixed(1)}" cy="${fy(v).toFixed(1)}" r="2.5" fill="${SERIES[s.mi]}" fill-opacity="0.5"/>`));
  body.push(line(cx - COLUMN * 0.38, fy(s.median), cx + COLUMN * 0.38, fy(s.median), SURFACE, 5), line(cx - COLUMN * 0.38, fy(s.median), cx + COLUMN * 0.38, fy(s.median), TEXT, 2.5));
  body.push(text(cx, Y1 + 18, s.arm, { anchor: "middle", size: 12, color: TEXT }));
  const labelRow = (s.mi * ARMS.length + ai) % 2;
  body.push(text(cx, Y1 + 36 + labelRow * 14, `${s.zero} of ${s.values.length} with no thinking`, { anchor: "middle", size: 10 }));
  desc.push(`${s.name} ${s.arm}: median ${s.median}, ${s.zero} of ${s.values.length} with no thinking`);
}
body.push(text((X0 + X1) / 2, H - 20, "Effort", { anchor: "middle", size: 11 }));

writeFileSync(join(values.out, "fig6-thinking-tokens.svg"), svgDocument(W, H, "Thinking Tokens per Review by Model and Effort", `Jittered dot plot on a log(1 + tokens) scale. ${desc.join("; ")}.`, body));
console.log("fig6-thinking-tokens.svg");
