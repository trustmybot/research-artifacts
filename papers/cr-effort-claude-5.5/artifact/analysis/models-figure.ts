import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readCsv } from "./lib.ts";
import { COST_THRESHOLD } from "./models.ts";
import { ARMS, MODELS, MUTED, SERIES, TEXT, line, marker, modelLabel, pct, svgDocument, text } from "./svg.ts";

const { values } = parseArgs({ options: { models: { type: "string" }, reviews: { type: "string" }, out: { type: "string" } } });
if (!values.models || !values.reviews || !values.out) {
  console.error("usage: node models-figure.ts --models <models.json> --reviews <reviews.csv> --out <figures dir>");
  process.exit(2);
}
const results = JSON.parse(readFileSync(values.models, "utf8"));
const reviews = readCsv(values.reviews);
mkdirSync(values.out, { recursive: true });

const legend = (y: number, note: string) => [
  ...MODELS.flatMap(([m], mi) => [marker(mi, 30 + mi * 175, y - 4, SERIES[mi]), text(42 + mi * 175, y, modelLabel(m), { size: 12, color: TEXT })]),
  text(696, y, note, { size: 11, anchor: "end" }),
];

type Metric = "miss_rate" | "false_alarm_rate";
function ratePanel(x0: number, y0: number, w: number, h: number, metric: Metric, heading: string, sub: string): string[] {
  const left = x0 + 40;
  const y = (v: number) => y0 + h - v * h;
  const out = [text(x0, y0 - 28, heading, { size: 13, color: TEXT, weight: 600 }), text(x0, y0 - 12, sub, { size: 12 })];
  for (let t = 0; t <= 1 + 1e-9; t += 0.2) out.push(line(left, y(t), x0 + w, y(t)), text(left - 6, y(t) + 4, pct(t), { anchor: "end", size: 11 }));
  const group = (x0 + w - left) / ARMS.length;
  ARMS.forEach((a, ai) => {
    const center = left + group * (ai + 0.5);
    out.push(text(center, y0 + h + 18, a, { anchor: "middle", size: 12, color: TEXT }));
    MODELS.forEach(([m], mi) => {
      const r = results.by_model[m].rates[a][metric];
      const cx = center + (mi - 1) * 20;
      out.push(line(cx, y(r.ci[0]), cx, y(r.ci[1]), SERIES[mi], 2, 0.6), marker(mi, cx, y(r.rate), SERIES[mi]));
    });
  });
  out.push(text((left + x0 + w) / 2, y0 + h + 36, "Effort", { anchor: "middle", size: 11 }));
  return out;
}

const n = (metric: Metric) => results.by_model[MODELS[0][0]].rates[ARMS[0]][metric].n;
const describe = (metric: Metric) =>
  MODELS.map(([m, name]) => `${name} ${ARMS.map((a) => `${a} ${results.by_model[m].rates[a][metric].k} of ${results.by_model[m].rates[a][metric].n}`).join(", ")}`).join("; ");
const fig1 = svgDocument(720, 400, "Miss Rate and False-Alarm Rate by Model and Effort",
  `Dot plot with 95% Wilson intervals. Miss rate: ${describe("miss_rate")}. False-alarm rate: ${describe("false_alarm_rate")}.`,
  [
    text(24, 30, "Miss Rate and False-Alarm Rate by Model and Effort", { size: 14, color: TEXT, weight: 600 }),
    text(24, 48, "Lower is better. Each model reviewed every patch once at each effort.", { size: 12 }),
    ...ratePanel(24, 104, 320, 200, "miss_rate", "Miss Rate", `Wrong patches accepted (n = ${n("miss_rate")})`),
    ...ratePanel(384, 104, 320, 200, "false_alarm_rate", "False-Alarm Rate", `Correct patches rejected (n = ${n("false_alarm_rate")})`),
    ...legend(382, "Whiskers: 95% Wilson CI"),
  ]);
writeFileSync(join(values.out, "fig1-error-rates.svg"), fig1);

function costStrip(): string {
  const cells = MODELS.flatMap(([m], mi) => ARMS.map((a, ai) => {
    const costs = reviews.filter((r) => r.model === m && r.effort === a).map((r, i) => {
      const v = Number(r.cost_usd);
      if (r.cost_usd.trim() === "" || !Number.isFinite(v) || v <= 0) throw new Error(`bad cost_usd "${r.cost_usd}" at ${m} ${a} row ${i}`);
      return v;
    });
    const expected = results.by_model[m].reviews / ARMS.length;
    if (costs.length !== expected) throw new Error(`${costs.length} reviews for ${m} ${a} in reviews.csv, ${expected} in models.json`);
    return { m, mi, a, ai, costs: costs.sort((x, y) => x - y), gm: results.by_model[m].cost[a].geometric_mean as number };
  }));
  const all = cells.flatMap((c) => c.costs);
  const TICKS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  // Pad the domain past the first and last tick so a review cheaper than $0.001 is drawn, not clipped.
  const lo = Math.log10(Math.min(TICKS[0], ...all)) - 0.08, hi = Math.log10(Math.max(TICKS[TICKS.length - 1], ...all)) + 0.02;
  const W = 720, X0 = 96, X1 = 616, Y0 = 84, ROW = 28, GROUP = 3 * ROW + 26;
  const fx = (v: number) => X0 + ((Math.log10(v) - lo) / (hi - lo)) * (X1 - X0);
  const rowY = (mi: number, ai: number) => Y0 + mi * GROUP + 22 + ai * ROW;
  const Y1 = rowY(MODELS.length - 1, ARMS.length - 1) + ROW / 2 + 4;
  const H = Y1 + 74;
  const body: string[] = [
    text(24, 30, "Cost per Review by Model and Effort", { size: 14, color: TEXT, weight: 600 }),
    text(24, 48, "Each dot is one review; the dark bar is the geometric mean. Log cost scale.", { size: 12 }),
    text(696, 70, "Geometric mean", { size: 11, anchor: "end" }),
  ];
  for (const t of TICKS) body.push(line(fx(t), Y0, fx(t), Y1), text(fx(t), Y1 + 18, `$${t}`, { anchor: "middle", size: 11 }));
  body.push(text((X0 + X1) / 2, Y1 + 36, "Cost per Review (USD, List Price)", { anchor: "middle", size: 11 }));
  const desc: string[] = [];
  MODELS.forEach(([m], mi) => {
    const h3 = results.by_model[m].hypotheses.H3;
    const ratio = `cost ratio ${h3.ratio.toFixed(3)} (95% BCa ${h3.bca_ci.map((x: number) => x.toFixed(3)).join(" to ")})`;
    const headY = rowY(mi, 0) - 20;
    body.push(text(24, headY, modelLabel(m), { size: 12, color: SERIES[mi], weight: 600 }), text(696, headY, `Medium/high ${ratio}`, { size: 11, anchor: "end" }));
    desc.push(`${modelLabel(m)}: geometric means ${cells.filter((c) => c.m === m).map((c) => `${c.a} $${c.gm.toFixed(4)}`).join(", ")}; medium/high ${ratio}`);
  });
  for (const c of cells) {
    const cy = rowY(c.mi, c.ai);
    body.push(text(X0 - 10, cy + 4, c.a, { anchor: "end", size: 12, color: TEXT }));
    c.costs.forEach((v, j) => body.push(`<circle cx="${fx(v).toFixed(1)}" cy="${(cy + ((j * 7) % 17) - 8).toFixed(1)}" r="2.2" fill="${SERIES[c.mi]}" fill-opacity="0.5"/>`));
    body.push(line(fx(c.gm), cy - 12, fx(c.gm), cy + 12, TEXT, 2.5), text(696, cy + 4, `$${c.gm.toFixed(4)}`, { size: 11, color: TEXT, anchor: "end" }));
  }
  body.push(text(24, H - 14, `${all.length} reviews, ${cells[0].costs.length} per model and effort. H3 threshold for the medium/high geometric-mean cost ratio: ${COST_THRESHOLD.toFixed(2).replace(/^0/, "")}.`, { size: 11 }));
  return svgDocument(W, H, "Cost per Review by Model and Effort", `Strip plot of ${all.length} review costs on a log scale, one row per model and effort. ${desc.join(". ")}.`, body);
}
writeFileSync(join(values.out, "fig2-models-cost.svg"), costStrip());

const W = 720, H = 380, X0 = 80, X1 = 690, Y0 = 70, Y1 = 300;
const lo = Math.log10(0.001), hi = Math.log10(0.2);
const fx = (v: number) => X0 + ((Math.log10(v) - lo) / (hi - lo)) * (X1 - X0);
const yMin = 0.45, yMax = 0.85;
const fy = (v: number) => Y1 - ((v - yMin) / (yMax - yMin)) * (Y1 - Y0);
const body: string[] = [
  text(24, 30, "Mean Cost Versus Balanced Accuracy by Model and Effort", { size: 14, color: TEXT, weight: 600 }),
  text(24, 48, "Balanced accuracy = mean of (1 - miss rate) and (1 - false-alarm rate). Higher and further left is better. Log cost scale.", { size: 12 }),
];
for (const t of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2]) body.push(line(fx(t), Y0, fx(t), Y1), text(fx(t), Y1 + 18, `$${t}`, { anchor: "middle", size: 11 }));
for (const t of [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) body.push(line(X0, fy(t), X1, fy(t)), text(X0 - 6, fy(t) + 4, t.toFixed(2), { anchor: "end", size: 11 }));
body.push(`<text x="0" y="0" transform="translate(34 ${fy(0.65).toFixed(1)}) rotate(-90)" font-size="11" fill="${MUTED}" text-anchor="middle">Balanced Accuracy</text>`);
body.push(text((X0 + X1) / 2, Y1 + 36, "Mean Cost per Review (USD, List Price)", { anchor: "middle", size: 11 }));

const offsets: Record<string, [number, number, string]> = {
  opus_low: [9, 16, "start"], opus_medium: [-6, -10, "end"], opus_high: [9, 16, "start"],
  sonnet_low: [-9, -8, "end"], sonnet_medium: [-9, 16, "end"], sonnet_high: [0, -12, "middle"],
  haiku_low: [-9, 16, "end"], haiku_medium: [9, 16, "start"], haiku_high: [-9, -8, "end"],
};
const desc: string[] = [];
MODELS.forEach(([m, name], mi) => {
  const pts = ARMS.map((a) => {
    const ba = results.by_model[m].rates[a].balanced_accuracy;
    const ci = results.by_model[m].youden[a].ci_mover.map((j: number) => (1 + j) / 2);
    return { a, x: results.by_model[m].cost[a].mean, y: ba, ci };
  });
  body.push(`<polyline points="${pts.map((p) => `${fx(p.x).toFixed(1)},${fy(p.y).toFixed(1)}`).join(" ")}" fill="none" stroke="${SERIES[mi]}" stroke-width="2" stroke-linejoin="round" stroke-opacity="0.7"/>`);
  for (const p of pts) body.push(line(fx(p.x), fy(Math.max(yMin, p.ci[0])), fx(p.x), fy(Math.min(yMax, p.ci[1])), SERIES[mi], 2, 0.45));
  for (const p of pts) {
    const [dx, dy, anchor] = offsets[`${m}_${p.a}`];
    body.push(marker(mi, fx(p.x), fy(p.y), SERIES[mi]), text(fx(p.x) + dx, fy(p.y) + dy, `${p.a} ${p.y.toFixed(3)}`, { size: 11, color: TEXT, anchor }));
    desc.push(`${name} ${p.a}: ${p.y.toFixed(3)} at $${p.x.toFixed(4)}`);
  }
});
body.push(...legend(H - 18, "Whiskers: 95% CI"));
writeFileSync(join(values.out, "fig5-models-cost-agreement.svg"), svgDocument(W, H, "Mean Cost Versus Balanced Accuracy by Model and Effort", desc.join("; "), body));
console.log("fig1-error-rates.svg, fig2-models-cost.svg, fig5-models-cost-agreement.svg");
