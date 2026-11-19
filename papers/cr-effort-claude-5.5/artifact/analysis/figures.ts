import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { results: { type: "string" }, data: { type: "string" }, out: { type: "string" } } });
if (!values.results || !values.data || !values.out) {
  console.error("usage: node figures.ts --results <results.json> --data <data dir> --out <figures dir>");
  process.exit(2);
}
const results = JSON.parse(readFileSync(values.results, "utf8"));
const ARMS = ["low", "medium", "high"] as const;
const SURFACE = "#fcfcfb";
const TEXT = "#0b0b0b";
const MUTED = "#52514e";
const GRID = "#e4e3df";
const SERIES = ["#2a78d6", "#eb6834"];
const FONT = "font-family=\"system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif\"";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const pct = (x: number) => `${Math.round(x * 100)}%`;

function svg(width: number, height: number, title: string, desc: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d" ${FONT}>`,
    `<title id="t">${esc(title)}</title>`,
    `<desc id="d">${esc(desc)}</desc>`,
    `<rect width="${width}" height="${height}" fill="${SURFACE}"/>`,
    ...body,
    "</svg>",
  ].join("\n") + "\n";
}
const text = (x: number, y: number, s: string, opts: { size?: number; color?: string; anchor?: string; weight?: number } = {}) =>
  `<text x="${x}" y="${y}" font-size="${opts.size ?? 12}" fill="${opts.color ?? MUTED}" text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}>${esc(s)}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, color = GRID, width = 1) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
const dot = (x: number, y: number, color: string, r = 5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`;

mkdirSync(values.out, { recursive: true });

const split = results.recall.split;
const groups = [["partial_recall", "Recall test recovered part of the fix"], ["full_recall", "Recall test recovered all of the fix"]] as const;
const fy4 = (v: number) => 250 - v * 180;
const fig4body: string[] = [text(24, 30, "Miss Rate by Effort and Recall of the Official Fix", { size: 14, color: TEXT, weight: 600 }), text(24, 48, "Opus 5.5 only; no recall test for Sonnet or Haiku.", { size: 12 })];
for (let t = 0; t <= 1.0001; t += 0.25) fig4body.push(line(90, fy4(t), 650, fy4(t)), text(84, fy4(t) + 4, pct(t), { anchor: "end", size: 11 }));
groups.forEach(([g, label], gi) => {
  const xs = ARMS.map((_, i) => 160 + i * 200 + (gi === 0 ? -14 : 14));
  ARMS.forEach((a, i) => {
    const r = split[g][a].miss_rate;
    fig4body.push(line(xs[i], fy4(r.ci[0]), xs[i], fy4(r.ci[1]), SERIES[gi], 2), dot(xs[i], fy4(r.rate), SERIES[gi]));
    if (gi === 1) fig4body.push(text(160 + i * 200, 272, a, { anchor: "middle", size: 12, color: TEXT }));
    fig4body.push(text(xs[i] + (gi === 0 ? -8 : 8), fy4(r.rate) + 4, `${r.k}/${r.n}`, { anchor: gi === 0 ? "end" : "start", size: 11, color: TEXT }));
  });
  fig4body.push(dot(110 + gi * 300, 300, SERIES[gi]), text(122 + gi * 300, 304, label, { size: 11, color: TEXT }));
});
fig4body.push(text(24, 330, "Recall measured before the main run from the issue text alone; lines of the official fix not present in the issue.", { size: 11 }));
writeFileSync(join(values.out, "fig4-recall-split.svg"), svg(720, 344, "Miss Rate by Effort and Recall of the Official Fix", `Opus 5.5 only. Partial recall: ${ARMS.map((a) => `${a} ${split.partial_recall[a].miss_rate.k} of ${split.partial_recall[a].miss_rate.n}`).join(", ")}. Full recall: ${ARMS.map((a) => `${a} ${split.full_recall[a].miss_rate.k} of ${split.full_recall[a].miss_rate.n}`).join(", ")}.`, fig4body));
console.log("fig4-recall-split.svg");
