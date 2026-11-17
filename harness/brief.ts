import { encode } from "@toon-format/toon";

const SLOT = "{{task_brief}}";
const REPO_PATH = "/testbed";

export type BriefInput = {
  commitSha: string;
  problemStatement?: string;
  environmentPath?: string;
  diff?: string;
  authorsNote?: string | null;
};

export type Brief = {
  commit_sha: string;
  repo_path: string;
  environment_path?: string;
  spec?: string;
  diff?: string;
  authors_note?: string;
};

export function buildBrief({
  commitSha,
  problemStatement,
  environmentPath,
  diff,
  authorsNote = null,
}: BriefInput): Brief {
  return {
    commit_sha: commitSha,
    repo_path: REPO_PATH,
    ...(environmentPath === undefined ? {} : { environment_path: environmentPath }),
    ...(problemStatement === undefined ? {} : { spec: problemStatement }),
    ...(diff === undefined ? {} : { diff }),
    ...(authorsNote === null ? {} : { authors_note: authorsNote }),
  };
}

export function fillBriefSlot(template: string, brief: Brief): string {
  const slotAt = template.indexOf(SLOT);
  if (slotAt === -1) throw new Error(`template has no ${SLOT} slot`);
  const before = template.slice(0, slotAt);
  const after = template.slice(slotAt + SLOT.length);
  // Only the template is scanned: Django issue text can legitimately contain `{{ value }}`.
  if (`${before}${after}`.includes("{{")) throw new Error(`template has a slot other than one ${SLOT}`);
  return `${before}${encode(brief)}${after}`;
}
