import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sum } from "./lib.ts";
import { ARMS, MODELS, MUTED, SERIES, SURFACE, TEXT, line, marker, modelLabel, svgDocument, text } from "./svg.ts";

const { values } = parseArgs({ options: { shallow: { type: "string" }, models: { type: "string" }, out: { type: "string" } } });
if (!values.shallow || !values.models || !values.out) {
  console.error("usage: node flowchart.ts --shallow <shallow-pass.json> --models <models.json> --out <figures dir>");
  process.exit(2);
}
const shallow = JSON.parse(readFileSync(values.shallow, "utf8"));
const models = JSON.parse(readFileSync(values.models, "utf8"));

type Model = (typeof MODELS)[number][0];
type Arm = (typeof ARMS)[number];
const checked = (value: unknown, where: string): number => {
  if (typeof value !== "number") throw new Error(`missing count at ${where}`);
  return value;
};
const shallowCount = (key: string) => (m: Model, a: Arm) => checked(shallow.by_model[m]?.[a]?.[key]?.reviews, `shallow-pass.json by_model.${m}.${a}.${key}.reviews`);
const malformedCount = (m: Model, a: Arm) => {
  const byLabel = models.by_model[m]?.malformed?.[a];
  if (!byLabel) throw new Error(`missing models.json by_model.${m}.malformed.${a}`);
  return sum(Object.values(byLabel).map((v, i) => checked(v, `models.json by_model.${m}.malformed.${a}[${i}]`)));
};
const reviewsPerCell = checked(shallow.by_model[MODELS[0][0]]?.[ARMS[0]]?.reviews, `shallow-pass.json by_model.${MODELS[0][0]}.${ARMS[0]}.reviews`);

const steps = [
  { name: "Input", detail: "Issue text and patch commit", notes: [] },
  { name: "Thinking", detail: "May think before acting", notes: [["No Thinking", shallowCount("no_thinking")]] },
  { name: "Tools and Tests", detail: "Reads code, runs commands", notes: [["At Most One Tool Call", shallowCount("at_most_one_tool_call")], ["No Test Run", shallowCount("no_test_run")]] },
  { name: "Strictly Decoded Verdict", detail: "Pass, fail or no verdict", notes: [["Malformed Verdict", malformedCount]] },
] as const;

const W = 1100, H = 400, LEFT = 24, BOX_W = 236, GAP = 36, BOX_Y = 76, BOX_H = 60, NOTE_Y = 170, NOTE_H = 92;
const boxX = (i: number) => LEFT + i * (BOX_W + GAP);
const arrow = (x1: number, x2: number, y: number) => [
  line(x1 + 4, y, x2 - 8, y, MUTED, 1.5),
  `<path d="M${(x2 - 2).toFixed(1)},${y.toFixed(1)} L${(x2 - 10).toFixed(1)},${(y - 4.5).toFixed(1)} L${(x2 - 10).toFixed(1)},${(y + 4.5).toFixed(1)} Z" fill="${MUTED}"/>`,
];

const body: string[] = [
  text(LEFT, 30, "How a Reviewer Works and Where Reviews Went Shallow or Failed", { size: 14, color: TEXT, weight: 600 }),
  text(LEFT, 48, `Counts of reviews at low / medium / high effort, out of ${reviewsPerCell} per model and effort.`, { size: 12 }),
];
const desc: string[] = [];
steps.forEach((step, i) => {
  const x = boxX(i);
  body.push(
    `<rect x="${x}" y="${BOX_Y}" width="${BOX_W}" height="${BOX_H}" rx="8" fill="${SURFACE}" stroke="${MUTED}" stroke-width="1.25"/>`,
    text(x + 12, BOX_Y + 25, `${i + 1}. ${step.name}`, { size: 13, color: TEXT, weight: 600 }),
    text(x + 12, BOX_Y + 44, step.detail, { size: 11 }),
  );
  if (i < steps.length - 1) body.push(...arrow(x + BOX_W, boxX(i + 1), BOX_Y + BOX_H / 2));
  step.notes.forEach(([heading, count], ni) => {
    const y = NOTE_Y + ni * NOTE_H;
    body.push(line(x, y - 18, x + BOX_W, y - 18), text(x, y, heading, { size: 12, color: TEXT, weight: 600 }));
    const parts: string[] = [];
    MODELS.forEach(([m], mi) => {
      const counts = ARMS.map((a) => count(m, a)).join(" / ");
      const rowY = y + 22 + mi * 20;
      body.push(marker(mi, x + 6, rowY - 4, SERIES[mi]), text(x + 18, rowY, modelLabel(m), { size: 12, color: TEXT }), text(x + BOX_W, rowY, counts, { size: 12, color: TEXT, anchor: "end" }));
      parts.push(`${modelLabel(m)} ${counts}`);
    });
    desc.push(`${heading} at step ${i + 1}: ${parts.join(", ")}`);
  });
});
body.push(line(LEFT, H - 40, W - LEFT, H - 40), text(LEFT, H - 18, "No review hit the $4 cost cap or the 60-minute timeout.", { size: 11 }));

const title = "How a Reviewer Works and Where Reviews Went Shallow or Failed";
const flow = `Four steps from left to right: ${steps.map((s, i) => `${i + 1}. ${s.name} (${s.detail.toLowerCase()})`).join(", ")}`;
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "fig0-reviewer-flowchart.svg"), svgDocument(W, H, title, `${flow}. Counts at low / medium / high effort: ${desc.join("; ")}. No review hit the $4 cost cap or the 60-minute timeout.`, body));
console.log("fig0-reviewer-flowchart.svg");
