export const MODELS = [["opus", "Opus 5.5"], ["sonnet", "Sonnet 5.5"], ["haiku", "Haiku 5.5"]] as const;
const PREREGISTERED_MODEL = "opus";
export const modelLabel = (model: (typeof MODELS)[number][0]) =>
  `${MODELS.find(([m]) => m === model)![1]} (${model === PREREGISTERED_MODEL ? "preregistered" : "exploratory"})`;
export const ARMS = ["low", "medium", "high"] as const;
export const SURFACE = "#fcfcfb";
export const TEXT = "#0b0b0b";
export const MUTED = "#52514e";
export const GRID = "#e4e3df";
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"];
const FONT = "font-family=\"system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif\"";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export const pct = (x: number) => `${Math.round(x * 100)}%`;

export const text = (x: number, y: number, s: string, o: { size?: number; color?: string; anchor?: string; weight?: number } = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${o.size ?? 12}" fill="${o.color ?? MUTED}" text-anchor="${o.anchor ?? "start"}"${o.weight ? ` font-weight="${o.weight}"` : ""}>${esc(s)}</text>`;

export const line = (x1: number, y1: number, x2: number, y2: number, color = GRID, width = 1, opacity = 1) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ""}/>`;

export const marker = (shape: number, x: number, y: number, color: string) => {
  const ring = `stroke="${SURFACE}" stroke-width="2"`;
  if (shape === 0) return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="${color}" ${ring}/>`;
  if (shape === 1) return `<rect x="${(x - 5).toFixed(1)}" y="${(y - 5).toFixed(1)}" width="10" height="10" rx="1.5" fill="${color}" ${ring}/>`;
  return `<path d="M${x.toFixed(1)},${(y - 6.5).toFixed(1)} L${(x + 6).toFixed(1)},${(y + 4.5).toFixed(1)} L${(x - 6).toFixed(1)},${(y + 4.5).toFixed(1)} Z" fill="${color}" ${ring}/>`;
};

export const svgDocument = (width: number, height: number, title: string, desc: string, body: string[]) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d" ${FONT}>`,
    `<title id="t">${esc(title)}</title>`,
    `<desc id="d">${esc(desc)}</desc>`,
    `<rect width="${width}" height="${height}" fill="${SURFACE}"/>`,
    ...body,
    "</svg>",
  ].join("\n") + "\n";
