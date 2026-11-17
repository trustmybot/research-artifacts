import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (tex: string) => tex.split("\n").map((line) => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n");
const tex = stripComments(readFileSync(join(here, "main.tex"), "utf8"));
const bib = readFileSync(join(here, "references.bib"), "utf8");

const matches = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]);
const splitKeys = (groups: string[]) => groups.flatMap((g) => g.split(",")).map((k) => k.trim()).filter(Boolean);

const bibEntries = [...bib.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g)].map((m) => ({ type: m[1], key: m[2], body: m[3] }));
const bibKeys = new Set(bibEntries.map((e) => e.key));
const citeKeys = new Set(splitKeys(matches(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g, tex)));
const graphics = matches(/\\includegraphics\s*(?:\[[^\]]*\])?\{([^}]*)\}/g, tex);
const labels = new Set(matches(/\\label\{([^}]*)\}/g, tex));
const refs = new Set(matches(/\\(?:ref|autoref|pageref|cref|Cref|eqref)\{([^}]*)\}/g, tex));

const graphicExists = (path: string) => ["", ".pdf", ".png", ".jpg"].some((ext) => existsSync(join(here, path + ext)));

const biblatexOnlyFields = ["date", "journaltitle", "eprinttype", "urldate", "titleaddon", "eid"];
const biblatexCommands = ["parencite", "textcite", "printbibliography", "addbibresource", "autocite"];
const fieldPresent = (body: string, field: string) => new RegExp(`(^|\\n)\\s*${field}\\s*=`, "i").test(body);

const proseOnly = tex
  .replace(/\\url\{[^}]*\}/g, "")
  .replace(/\\(?:code|texttt)\{[^}]*\}/g, "")
  .replace(/\\(?:label|ref|cite[a-z]*)\{[^}]*\}/g, "");
const internalIds = [...proseOnly.matchAll(/\b(?:(?:cr|swe|bro|guard|sys)-[a-z]+-claude-(?:opus|sonnet|haiku)-[0-9.]+(?:-[a-z]+)?|(?:cr|swe|bro|guard|sys)-[a-z]+-(?:opus|sonnet|haiku)[0-9.]+|C[1-5]-[A-Z])\b/g)].map((m) => m[0]);

const errors = [
  ...(/\\documentclass(?:\[[^\]]*\])?\{acmart\}/.test(tex) ? [] : ["main.tex must use \\documentclass{acmart}"]),
  ...(/\\bibliographystyle\{ACM-Reference-Format\}/.test(tex) ? [] : ["main.tex must set \\bibliographystyle{ACM-Reference-Format}"]),
  ...(/\\bibliography\{references\}/.test(tex) ? [] : ["main.tex must load \\bibliography{references}"]),
  ...biblatexCommands.filter((c) => new RegExp(`\\\\${c}\\b`).test(tex)).map((c) => `biblatex command in main.tex: \\${c}`),
  ...[...citeKeys].filter((k) => !bibKeys.has(k)).map((k) => `citation key not in references.bib: ${k}`),
  ...[...bibKeys].filter((k) => !citeKeys.has(k)).map((k) => `bib entry never cited (paper.md numbering assumes every entry is cited): ${k}`),
  ...bibEntries.flatMap((e) => biblatexOnlyFields.filter((f) => fieldPresent(e.body, f)).map((f) => `biblatex-only field "${f}" in ${e.key}`)),
  ...bibEntries.filter((e) => /\\enquote/.test(e.body)).map((e) => `\\enquote in ${e.key}; BibTeX needs \`\`...''`),
  ...graphics.filter((g) => !graphicExists(g)).map((g) => `graphics file missing: ${g}`),
  ...[...refs].filter((r) => !labels.has(r)).map((r) => `reference to undefined label: ${r}`),
  ...[...new Set(internalIds)].map((id) => `internal study ID in paper text (allowed only inside a repo path or link): ${id}`),
];

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`class: acmart with ACM-Reference-Format and BibTeX`);
console.log(`citations: ${citeKeys.size} keys, all in references.bib, every entry cited (${bibKeys.size} entries)`);
console.log(`graphics: ${graphics.length} files, all present`);
console.log(`refs: ${refs.size} labels referenced, all defined (${labels.size} labels)`);
console.log(`internal IDs: none outside paths and links`);
