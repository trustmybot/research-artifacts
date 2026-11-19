export const ELIDED = "[patch code elided]";
export const MIN_RUN = 40;

export function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
    .map((line) => line.slice(1).replace(/\r$/, ""));
}

function patchWindows(diff: string): Set<string> {
  const windows = new Set<string>();
  for (const line of addedLines(diff)) {
    for (let i = 0; i + MIN_RUN <= line.length; i++) windows.add(line.slice(i, i + MIN_RUN));
  }
  return windows;
}

// Every character of a matching MIN_RUN-character window lies in a run of at least MIN_RUN characters
// copied from an added line, so the elided spans are the union of the matching windows.
export function redactor(diff: string): (text: string) => string {
  const windows = patchWindows(diff);
  return (text: string) => {
    const covered = new Uint8Array(text.length);
    for (let i = 0; i + MIN_RUN <= text.length; i++) {
      if (windows.has(text.slice(i, i + MIN_RUN))) covered.fill(1, i, i + MIN_RUN);
    }
    let out = "";
    for (let i = 0; i < text.length; ) {
      if (!covered[i]) { out += text[i++]; continue; }
      const start = i;
      while (covered[i]) i++;
      const span = text.slice(start, i);
      out += span.match(/^\s*/)![0] + ELIDED + span.match(/\s*$/)![0];
    }
    return out;
  };
}

export const redact = (text: string, diff: string): string => redactor(diff)(text);
