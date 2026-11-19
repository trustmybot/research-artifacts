import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ARMS, GRID, line, MODELS, pct, SERIES, SURFACE, svgDocument, text, TEXT } from "../../../artifact/analysis/svg.ts";
import { DEFAULT_OUT, PATCH_OUTCOMES, type PatchOutcome } from "./analyze.ts";
import { FINDINGS } from "./packet-lib.ts";

const OUTCOMES: Record<PatchOutcome, { label: string; fill: string; ink: string }> = {
  rejected_named: { label: "Rejected, defect named", fill: SERIES[0], ink: SURFACE },
  rejected_partial: { label: "Rejected, partly named", fill: "#9cc3ef", ink: TEXT },
  rejected_other: { label: "Rejected for another reason", fill: SERIES[1], ink: TEXT },
  accepted_seen: { label: "Accepted, defect named in feedback", fill: SERIES[2], ink: TEXT },
  accepted_not_named: { label: "Accepted, defect not named", fill: "#d6d4ce", ink: TEXT },
};

const TITLE = "Why Each Reviewer Rejected or Accepted the Wrong Patches";
const LEFT = 190, RIGHT = 730, BAR = 22, GAP = 8, GROUP_GAP = 22, MIN_LABEL = 12;

type Outcomes = Record<PatchOutcome, number>;

export function fig7(byModel: Record<string, Record<string, { patch_outcomes: Outcomes }>>): string {
  const width = RIGHT + 30;
  const scale = (x: number) => LEFT + x * (RIGHT - LEFT);
  const body: string[] = [text(24, 30, TITLE, { size: 14, color: TEXT, weight: 600 })];
  const total = (o: Outcomes) => PATCH_OUTCOMES.reduce((s, k) => s + o[k], 0);
  const patches = total(byModel[MODELS[0][0]][ARMS[0]].patch_outcomes);
  body.push(text(24, 48, `Each bar is one model and effort cell: the ${patches} wrong patches by what the review did.`, { size: 12 }));

  let lx = 24, ly = 72;
  for (const o of PATCH_OUTCOMES) {
    const label = OUTCOMES[o].label;
    const w = 18 + label.length * 6.4;
    if (lx + w > width - 20) { lx = 24; ly += 18; }
    body.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${OUTCOMES[o].fill}"/>`, text(lx + 14, ly, label, { size: 11, color: TEXT }));
    lx += w + 12;
  }

  let y = ly + 30;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) body.push(text(scale(t), y - 6, pct(t), { anchor: "middle", size: 11 }));
  const top = y;
  const desc: string[] = [];
  for (const [model, name] of MODELS) {
    body.push(text(24, y + BAR / 2 + 4, name, { size: 12, color: TEXT, weight: 600 }));
    for (const effort of ARMS) {
      const outcomes = byModel[model][effort].patch_outcomes;
      const n = total(outcomes);
      body.push(text(LEFT - 10, y + BAR / 2 + 4, effort, { anchor: "end", size: 12, color: TEXT }));
      let acc = 0;
      for (const o of PATCH_OUTCOMES) {
        const x0 = scale(acc / n), x1 = scale((acc + outcomes[o]) / n);
        acc += outcomes[o];
        if (x1 <= x0) continue;
        body.push(`<rect x="${x0.toFixed(1)}" y="${y}" width="${(x1 - x0).toFixed(1)}" height="${BAR}" fill="${OUTCOMES[o].fill}" stroke="${SURFACE}" stroke-width="1"/>`);
        if (x1 - x0 >= MIN_LABEL) body.push(text((x0 + x1) / 2, y + BAR / 2 + 4, String(outcomes[o]), { anchor: "middle", size: 11, color: OUTCOMES[o].ink }));
      }
      desc.push(`${name} ${effort}: ${PATCH_OUTCOMES.map((o) => `${outcomes[o]} ${OUTCOMES[o].label.toLowerCase()}`).join(", ")}.`);
      y += BAR + GAP;
    }
    y += GROUP_GAP - GAP;
  }
  body.splice(1, 0, line(LEFT, top, LEFT, y - GROUP_GAP + GAP, GRID), line(RIGHT, top, RIGHT, y - GROUP_GAP + GAP, GRID));
  const height = y + 10;
  return svgDocument(width, height, TITLE, `100% stacked bars over the ${patches} wrong patches per cell. ${desc.join(" ")}`, body);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      findings: { type: "string", default: DEFAULT_OUT },
      out: { type: "string", default: join(FINDINGS, "artifact", "figures") },
    },
  });
  const findings = JSON.parse(readFileSync(values.findings!, "utf8"));
  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, "fig7-right-reason.svg"), fig7(findings.by_model));
  console.log("fig7-right-reason.svg");
}
