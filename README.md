# Research artifacts

This repository holds the data, analysis code, figures and supplements for Trust My Bot's papers on AI code review, one folder per paper under [`papers/`](papers/); each release is an immutable tag.

| Paper | Folder | Release |
|---|---|---|
| How Much Effort Does an AI Code Reviewer Need? Evidence from Claude 5.5 Models on Plausible-but-Wrong Patches | [`papers/cr-effort-claude-5.5`](papers/cr-effort-claude-5.5) | `cr-effort-claude-5.5-v1.2` |

## Layout

- `papers/<paper>/`: the paper, its supplement and its artifact, whose `artifact/README.md` rebuilds every result, such as [`papers/cr-effort-claude-5.5/artifact/README.md`](papers/cr-effort-claude-5.5/artifact/README.md).
- [`harness/`](harness/): the review harness that ran the studies; see [`harness/README.md`](harness/README.md).
- [`LABELS.md`](LABELS.md) and [`labels.csv`](labels.csv): the patch labelling rules and the labels.
- `MANIFEST.json`: each file's SHA-256 and the source commit it was exported from.

## Running

Install Node.js 24, run `npm ci` at the repository root, then follow the paper's `artifact/README.md`. The bootstrap is seeded, so reruns give identical output.

## Not included

- Full transcripts. They contain patch text that is not licensed for redistribution, so they are kept private; they are available from the authors on request.
- Credentials and infrastructure settings. They come from a local, untracked config.

## License

- Code is under the MIT License; see [`LICENSE`](LICENSE). This covers [`harness/`](harness/), the TypeScript analysis scripts in each paper's folder, `package.json` and `package-lock.json`.
- Everything else, including the papers, supplements, figures, data, [`LABELS.md`](LABELS.md) and [`labels.csv`](labels.csv), is under Creative Commons Attribution 4.0 International; see [`LICENSE-CC-BY-4.0`](LICENSE-CC-BY-4.0).
- Third-party material, such as Django source and patch text, keeps its original license.
