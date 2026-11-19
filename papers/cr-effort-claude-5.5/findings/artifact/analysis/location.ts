export interface LocationCodes {
  loc_file: 0 | 1;
  loc_line_or_function: 0 | 1;
  loc_in_patch_files: 0 | 1;
}

export const NO_LOCATION: LocationCodes = { loc_file: 0, loc_line_or_function: 0, loc_in_patch_files: 0 };

const SOURCE_EXTENSION = /^(py|pyi|pyx|sh|bash|js|jsx|mjs|cjs|ts|tsx|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|pl|lua|html)$/i;
const PATH_TOKEN = /(?<![\w.\/-])\/?(?:[\w.-]+\/)*[\w-][\w.-]*\.([A-Za-z0-9]+)(?![\w\/])/g;
const LINE_NUMBER = [
  /\blines?\s*[~#]?\d+/i,
  /\.[A-Za-z0-9]+:\d+/,
  /#?\bL\d{2,}\b/,
];
const DIFF_FILE = /^\+\+\+ (?:b\/)?(.+?)\s*$/;
const HUNK_HEADER = /^@@ [^@]* @@(.*)$/;
const DEFINED_NAME = /\bdef\s+([A-Za-z_]\w*)/g;
const CALLED_NAME = /([A-Za-z_]\w*)\s*\(/g;
const NOT_FUNCTIONS = new Set(["if", "elif", "while", "for", "return", "and", "or", "not", "in", "is", "with", "assert", "print", "lambda", "yield", "except"]);

export function patchFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = DIFF_FILE.exec(line);
    if (m && m[1] !== "/dev/null") files.add(m[1]);
  }
  return [...files];
}

export function patchFunctionNames(diff: string): Set<string> {
  const names = new Set<string>();
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    const changed = /^[+-](?![+-]{2} )/.test(line) ? line.slice(1) : null;
    for (const m of (header?.[1] ?? "").matchAll(DEFINED_NAME)) names.add(m[1]);
    if (changed === null) continue;
    for (const m of changed.matchAll(DEFINED_NAME)) names.add(m[1]);
    for (const m of changed.matchAll(CALLED_NAME)) if (!NOT_FUNCTIONS.has(m[1])) names.add(m[1]);
  }
  return names;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isCodeLike = (name: string) => name.includes("_") || /[a-z][A-Z]/.test(name);

function mentionsFunction(text: string, name: string): boolean {
  const word = escape(name);
  if (!new RegExp(`(?<![\\w])${word}(?![\\w])`).test(text)) return false;
  if (isCodeLike(name)) return true;
  return new RegExp(`(?<![\\w])${word}\\s*\\(|\\.${word}(?![\\w])|\`[^\`\\n]*(?<![\\w])${word}(?![\\w])[^\`\\n]*\``).test(text);
}

const samePath = (named: string, changed: string) =>
  named === changed || changed.endsWith(`/${named}`) || named.endsWith(`/${changed}`);

export function locationCodes(location: string, problem: string, diff: string): LocationCodes {
  const text = `${location}\n${problem}`;
  const changed = patchFiles(diff);
  const named = [...text.matchAll(PATH_TOKEN)].map((m) => ({ path: m[0], extension: m[1] }));
  const inPatch = named.some((n) => changed.some((c) => samePath(n.path, c)));
  const sourcePath = named.some((n) => SOURCE_EXTENSION.test(n.extension));
  const lineGiven = LINE_NUMBER.some((re) => re.test(text));
  const functionGiven = [...patchFunctionNames(diff)].some((name) => mentionsFunction(text, name));
  return {
    loc_file: sourcePath || inPatch ? 1 : 0,
    loc_line_or_function: lineGiven || functionGiven ? 1 : 0,
    loc_in_patch_files: inPatch ? 1 : 0,
  };
}
