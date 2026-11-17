import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "artifact", "figures");
const target = join(here, "figures");
mkdirSync(target, { recursive: true });

const svgs = readdirSync(source).filter((name) => name.endsWith(".svg")).sort();
if (svgs.length === 0) {
  console.error(`no SVG figures in ${source}`);
  process.exit(1);
}
for (const name of svgs) {
  const out = join(target, `${basename(name, ".svg")}.pdf`);
  execFileSync("rsvg-convert", ["-f", "pdf", "-o", out, join(source, name)], { stdio: "inherit" });
  console.log(`${name} -> ${out}`);
}
