import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [vault, out] = process.argv.slice(2);
const branches = execFileSync("git", ["-C", vault, "branch", "-r", "--format=%(refname:short)"], { encoding: "utf8" })
  .split("\n")
  .filter((b) => b.includes("fa7afee-models-sonnet-haiku"));
for (const branch of branches) {
  const id = branch.split("/").pop()!;
  const dest = join(out, id);
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["-C", vault, "archive", branch, `c4-effort/c4-c-smoke/${id}`], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dest, "--strip-components=3"], { input: tar });
  console.log(id);
}
