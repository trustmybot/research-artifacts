# cr-effort-claude-haiku-5.5 Analysis Artifact

This directory holds the data and analysis code behind every number in `papers/cr-effort-claude-5.5/haiku-vs-opus/analysis.md`, the exploratory analysis comparing Haiku 5.5 at high effort with Opus 5.5 at medium effort, which share many catches but are not shown to be close.

The scripts need Node.js 24 or later, which runs TypeScript directly. They have no package dependencies.

## Files

| Path | Contents |
|---|---|
| `analysis/analyze.ts` | Agreement, variance decomposition, issue-requirement split, paired work measures and the manual evidence-coding summary; writes one JSON file and prints it |
| `analysis/features.ts` | Builds `data/reviews.csv` from the Opus 5.5 run directories and the extracted Sonnet 5.5 and Haiku 5.5 runs, counting test-suite, own-code and differential runs from each transcript's Bash calls |
| `analysis/extract-vault.ts` | Extracts the `fa7afee` Sonnet and Haiku shards from the private vault repository |
| `analysis/blind.ts` | Shuffles the Haiku-high and Opus-medium catches (seed 20261107), strips model labels and writes the key that maps blind codes to reviews |
| `data/reviews.csv` | One row per main-run review (810): verdict, label, cost, turns, tokens and Bash run counts; no transcript text |
| `data/manual-codes.json` | The evidence class coded for each blind catch: `S` existing test fails, `R` reviewer's own reproduction, `C` code reading only |
| `data/blind-key.json` | Maps each blind code to its model, effort, instance and submitting agent |

## Reproduce the Note's Numbers From the Committed Data

Run from this directory:

```sh
node analysis/analyze.ts --reviews data/reviews.csv --labels ../../artifact/data/labels.csv --requires ../../artifact/data/issue-requires-coding.csv --codes data/manual-codes.json --key data/blind-key.json --out results.json
```

`analyze.ts` scores each review on the corrected `label` in `../../artifact/data/labels.csv`, not on the `label` column of `reviews.csv`, and stops if a patch has no `main` row there or if its `original_label` differs from the raw `label`. The bootstrap uses the seed 20261107 and 10,000 resamples with a mulberry32 generator, so reruns give identical output. On the corrected labels Haiku high catches 26 of 55 wrong patches and Opus medium 29.

## Rebuild the Data From the Run Records

The transcripts contain patch text with no licence for redistribution, so they are private: the Opus 5.5, Sonnet 5.5 and Haiku 5.5 runs are kept in a private archive held by the authors and are available from the authors on request. The review texts and the blind packet built from them are not committed. With read access:

```sh
node analysis/extract-vault.ts <vault repo> <vault dir>
node analysis/features.ts --opus ../../artifact/data/results.csv --gcs <opus runs dir> --vault <vault dir> --out data/reviews.csv --texts <review-texts.json>
node analysis/blind.ts <review-texts.json> data/blind-key.json <blind-catches.md>
```

`<opus runs dir>` holds one folder per batch, `<batch_run_id>/runs/<run>/`, as in the `runs/gcs/` mirror. `blind.ts` writes the packet the coder read; `manual-codes.json` holds the codes assigned to it.
