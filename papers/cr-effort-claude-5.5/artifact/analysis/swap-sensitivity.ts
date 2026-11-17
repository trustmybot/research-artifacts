import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { labelChanges, readCsv, readLabels, type Row } from "./lib.ts";
import { compareModels, METHOD, readRequiresCoding, summarize } from "./models.ts";

const { values } = parseArgs({ options: { reviews: { type: "string" }, sensitivity: { type: "string" }, labels: { type: "string" }, requires: { type: "string" }, draw: { type: "string" }, out: { type: "string" } } });
if (!values.reviews || !values.sensitivity || !values.labels || !values.requires || !values.draw || !values.out) {
  console.error("usage: node swap-sensitivity.ts --reviews <reviews.csv> --sensitivity <label-check-sensitivity-reviews.csv> --labels <labels.csv> --requires <issue-requires-coding.csv> --draw <main-draw.json> --out <models-swap.json>");
  process.exit(2);
}
const CELLS_PER_PATCH = 9;

type PatchRef = { instance_id: string; agent_id: string };
interface Replacement { dropped: PatchRef; replacement: PatchRef; }
const patchKey = (p: PatchRef | Row) => `${p.instance_id}|${p.agent_id}`;
const cellKey = (r: Row) => `${r.model}|${r.effort}`;

const reviews = readCsv(values.reviews);
const sensitivity = readCsv(values.sensitivity);
const reviewedKeys = new Set(sensitivity.map(patchKey));
const replacements: Replacement[] = JSON.parse(readFileSync(values.draw, "utf8")).replacements;
const swaps = replacements.filter((r) => reviewedKeys.has(patchKey(r.dropped)));
const unmatched = [...reviewedKeys].filter((k) => !swaps.some((s) => patchKey(s.dropped) === k));
if (unmatched.length) throw new Error(`no replacement in ${values.draw} for ${unmatched.join(", ")}`);

const swappedIn = new Map<string, Map<string, Row>>();
for (const s of swaps) {
  const rows = sensitivity.filter((r) => patchKey(r) === patchKey(s.dropped));
  const byCell = new Map(rows.map((r) => [cellKey(r), r]));
  if (rows.length !== CELLS_PER_PATCH || byCell.size !== CELLS_PER_PATCH) throw new Error(`expected ${CELLS_PER_PATCH} sensitivity reviews for ${patchKey(s.dropped)}, got ${rows.length}`);
  const replaced = reviews.filter((r) => patchKey(r) === patchKey(s.replacement));
  if (replaced.length !== CELLS_PER_PATCH) throw new Error(`expected ${CELLS_PER_PATCH} reviews of ${patchKey(s.replacement)}, got ${replaced.length}`);
  swappedIn.set(patchKey(s.replacement), byCell);
}
const swapped = reviews.map((r) => {
  const byCell = swappedIn.get(patchKey(r));
  if (!byCell) return r;
  const row = byCell.get(cellKey(r));
  if (!row) throw new Error(`no sensitivity review for ${cellKey(r)} in place of ${patchKey(r)}`);
  return row;
});

const labels = readLabels(values.labels, swapped, ["main", "sensitivity"]);
const comparison = compareModels(
  { reviews: swapped, labels, requiresByKey: readRequiresCoding(values.requires) },
  { uncodedRequires: "skip", originalLabelsInFull: true },
);
const results = {
  generated_from: [values.reviews, values.sensitivity, values.labels, values.requires, values.draw],
  ...METHOD,
  label_changes: labelChanges(values.labels),
  swap: swaps.map((s) => ({ swapped_in: patchKey(s.dropped), in_place_of: patchKey(s.replacement) })),
  skipped: "label_question: the swapped-in patches have no issue-requirement code",
  ...comparison,
};
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify(results, null, 2) + "\n");
console.log(summarize(comparison.by_model));
