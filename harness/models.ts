export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type Model = (typeof MODELS)[number];
export const DEFAULT_MODEL: Model = "claude-opus-5-5";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const MODELS_USAGE = `a comma list of distinct models from ${MODELS.join(", ")}, each optionally :${EFFORTS.join(", :")}`;

export interface ModelCell {
  model: Model;
  effort: Effort | null;
}

const SHORT_NAMES: Record<Model, string> = {
  "claude-opus-5-5": "opus",
  "claude-sonnet-5-5": "sonnet",
  "claude-haiku-5-5": "haiku",
};

export function isModel(value: string): value is Model {
  return (MODELS as readonly string[]).includes(value);
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

export function shortModel(model: Model): string {
  return SHORT_NAMES[model];
}

function parseCell(entry: string): ModelCell | null {
  const [model, effort, ...rest] = entry.split(":");
  if (!isModel(model) || rest.length > 0) return null;
  if (effort === undefined) return { model, effort: null };
  return isEffort(effort) ? { model, effort } : null;
}

export function parseModels(value: string): ModelCell[] | null {
  const cells = value.split(",").map(parseCell);
  if (cells.some((cell) => cell === null)) return null;
  const parsed = cells as ModelCell[];
  if (new Set(parsed.map((cell) => cell.model)).size !== parsed.length) return null;
  return MODELS.flatMap((model) => parsed.filter((cell) => cell.model === model));
}

export function formatCell(cell: ModelCell): string {
  return cell.effort === null ? cell.model : `${cell.model}:${cell.effort}`;
}
