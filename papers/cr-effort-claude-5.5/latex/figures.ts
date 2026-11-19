import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sources = [join(here, "..", "artifact", "figures"), join(here, "..", "findings", "artifact", "figures")];
const target = join(here, "figures");
mkdirSync(target, { recursive: true });

for (const source of sources) {
  const svgs = readdirSync(source).filter((name) => name.endsWith(".svg")).sort();
  if (svgs.length === 0) {
    console.error(`no SVG figures in ${source}`);
    process.exit(1);
  }
  for (const name of svgs) {
    const out = join(target, `${basename(name, ".svg")}.pdf`);
    execFileSync("rsvg-convert", ["-f", "pdf", "-o", out, join(source, name)], { stdio: "inherit", timeout: 60_000 });
    console.log(`${name} -> ${out}`);
  }
}
