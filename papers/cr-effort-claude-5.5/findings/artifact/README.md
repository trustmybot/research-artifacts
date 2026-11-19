# cr-effort-claude-5.5 Findings Artifact

This directory holds the data and code for the findings analysis (RQ6) of the cr-effort paper: what the Opus 5.5, Sonnet 5.5 and Haiku 5.5 reviewers flagged when they rejected a patch. It is built from the existing review transcripts only; no review was rerun.

The scripts need Node.js 24 or later, which runs TypeScript directly. Apart from the TOON decoder already in the repository's `package.json`, they have no package dependencies.

## Files

| Path | Contents |
|---|---|
| `analysis/extract.ts` | Reads every main-run review, checks it against the review list and the patch hash pins, and writes `data/findings.csv` and the private review records |
| `analysis/location.ts` | Computes the three location codes of each finding |
| `analysis/redact.ts` | Replaces patch code quoted in a finding with `[patch code elided]` |
| `analysis/gold-packets.ts` | Writes the private gold-drafting packet of each of the 55 wrong patches (prompt `../prompts/G1-gold-draft.md`) |
| `analysis/packets.ts` | Draws the pass C decoys, shuffles and cuts the private coder batches of passes T, M, C and A, and writes `data/blind-key.json` |
| `analysis/packet-lib.ts` | Prompt slot filling, the seeded shuffle and the hash-pinned patch and issue inputs shared by the two packet scripts |
| `analysis/collect.ts` | Parses the two coders' replies, checks them against the batches and the blind key, and writes the joined codes, the inter-coder agreement and the disagreements for the adjudicator |
| `analysis/settle.ts` | Applies the adjudicator's verdicts to the coder codes and writes the private settled codes and `data/adjudication-log.csv` |
| `analysis/analyze.ts` | Computes the RQ6 results from the settled codes and writes `outputs/findings.json` |
| `analysis/figures.ts` | Draws Figure 7, `figures/fig7-right-reason.svg`, from `outputs/findings.json` |
| `data/adjudication-log.csv` | One row per adjudicated code: pass, item, field, both coders' codes, the final code, its basis and the codebook rule cited |
| `outputs/findings.json` | The RQ6 results: right reason, patch outcomes, accepted reviews, finding types, false alarms, agreement, adjudication counts and sensitivity analyses |
| `data/findings.csv` | One row per finding of every `fail` or malformed review (217 `fail` and 15 malformed reviews across the nine model and effort cells); `pass` reviews have no rows |
| `data/blind-key.json` | One entry per coder item: its random code, pass, model, effort, instance, agent, label, rule and whether it is a pass C decoy; no review text |
| `data/gold-behaviours.json` | The settled reference behaviors of the 55 wrong patches (57 in all), keyed by instance and agent: per behavior its id, basis, failing tests, trigger, expected and actual outcome, statement and code region; per patch the ids contested, dropped and changed during checking. Patch code is elided as in `data/findings.csv` |

## `data/findings.csv`

Rows are ordered by model, effort, instance, submitting agent and finding index, so a rebuild from the same inputs gives a byte-identical file.

- `review_id` names one review as `<model>-<effort>-<instance_id>-<agent_id>`; `finding_id` adds the finding index.
- `label` and `rule` are the corrected patch label and its rule from `../../artifact/data/labels.csv` (`set = main`).
- `verdict_status` is `fail`, or `malformed` when the review's verdict block did not decode. A malformed review's last fenced block is parsed leniently, as non-strict TOON and then as JSON. When both fail, each top-level key of the block is decoded on its own as non-strict TOON, so one undecodable value, such as a stray `\"` escape in `feedback`, does not hide valid findings; this recovers the findings of 6 of the 15 malformed reviews. When that recovers no finding, the review has one row with `finding_index` 0, `n_findings` 0, empty `location` and `problem`, and all three location codes 0.
- `location` and `problem` are the reviewer's own text, with every run of 40 or more characters that matches an added line of the reviewed patch replaced by `[patch code elided]`.
- The location codes are 0 or 1:
  - `loc_file`: the text names a source path, or the basename of a file in the patch.
  - `loc_line_or_function`: the text gives a line number, or names a function or method that appears in the patch's changed lines or hunk headers.
  - `loc_in_patch_files`: the named file is one the patch changes.

The coder columns (finding class, type, subtype and the agreement fields) are added by a later task, once the coders have run.

## Private Inputs

The run records and the agent patches are private. The transcripts contain patch text with no licence for redistribution, and the review feedback, thinking and tool output are not released. They are kept in a private archive held by the authors and are available from the authors on request:

- the Opus 5.5 runs, one folder per batch as in the `runs/gcs/` mirror, and the patches in `runs/cache/<instance>/<agent>.diff`;
- the Sonnet 5.5 and Haiku 5.5 runs, read from the `fa7afee` shard branches of the private vault repository.

`extract.ts` also writes one private record per review (feedback, findings before redaction, and the final message of a malformed review with no recovered finding) to `reviews.jsonl` under `--private-out`. It refuses a `--private-out` inside the repository checkout.

## Rebuild `data/findings.csv`

With read access to the private inputs, run from the repository root:

```sh
node papers/cr-effort-claude-5.5/findings/artifact/analysis/extract.ts --runs <runs dir> --vault <vault repo> --private-out <dir outside the repo> --out papers/cr-effort-claude-5.5/findings/artifact/data
```

`<runs dir>` holds `gcs/` and `cache/`. The script stops with a non-zero exit, and writes nothing, if a review in `../../haiku-vs-opus/artifact/data/reviews.csv` has no run record or transcript, if a patch hash differs from its pin, if a verdict differs from the review list, or if the counts are not 217 `fail` and 15 malformed reviews.

## Rebuild the Gold and Coder Packets

The packets hold issue text, official fixes, agent patches, test output and the reviewers' full feedback, so they stay private: both scripts write them only under `--private-out`, refuse a `--private-out` inside the repository checkout, and the authors keep them with the other private inputs (the study runs use `runs/findings/`). Only `data/blind-key.json` is committed. With read access to the private inputs, run from the repository root:

```sh
node papers/cr-effort-claude-5.5/findings/artifact/analysis/gold-packets.ts --runs <runs dir> --private-out <dir outside the repo>
node papers/cr-effort-claude-5.5/findings/artifact/analysis/packets.ts --runs <runs dir> --vault <vault repo> --private-out <dir outside the repo> --out papers/cr-effort-claude-5.5/findings/artifact/data
```

`gold-packets.ts` writes `gold/<instance>.<agent>.md`, the round 1 prompt of `../prompts/G1-gold-draft.md` with its slots filled, and `gold/<instance>.<agent>.json`, the slot values, for each of the 55 wrong patches:

- The 50 patches shown wrong by a failing test have basis `test`. Their packets hold the issue, the official fix, the SWE-ABS test patch, the failing tests as the union over the three label-check runs with the number of runs each failed in, the traceback excerpts of those runs and the wrong patch.
- The five patches of rule L7 have basis `reading`. Their packets hold the issue, the official fix and the wrong patch, plus the SWE-ABS test patch, failing tests and excerpts only where the label check found a failing test.
- The failing tests and logs come from the label check in `<runs dir>/gcs/20261102t124549z-5e7b1da/label-check/` (`--label-check` overrides it). The issue and official fix come from `<runs dir>/cache/<instance>/dataset-row.json`, checked against `harness/checks/main-patches.json`. The SWE-ABS rows are fetched from the Hugging Face datasets server, checked against `harness/checks/label-check-inputs.json` and cached in `cache/swe-abs-rows.json` under `--private-out`; on a network that reaches the server through a proxy, set `NODE_USE_ENV_PROXY=1`.

`packets.ts` reads the reviews the way `extract.ts` does and writes one `batches/<pass>/<pass>-<nn>.json` per batch, with each item's random code and slot values, and, for passes T and C, `<pass>-<nn>.md`, the pass prompt with the codebook and the items filled in. Passes M and A need the settled gold behaviours, which do not exist yet, so their items hold `gold_behaviours` as `null` and their prompts are not rendered. Both coders get the same batches.

| Pass | Items | Batch size | Shuffle seed |
|---|---|---|---|
| T | the 232 `fail` and malformed reviews | 15 | 20261118 |
| M | the 205 rejections of the 55 wrong patches | 15 | 20261119 |
| C | the 27 rejections of correct patches and 27 decoys | 9 | 20261120 |
| A | the 290 accepted reviews of wrong patches | 15 | 20261121 |

The decoys are drawn with seed 20261118 from the 205 rejections of wrong patches, as many from each model and effort cell as that cell has false alarms. Shuffles and draws use mulberry32, as in `../../haiku-vs-opus/artifact/analysis/blind.ts`, so a rebuild from the same inputs gives byte-identical packets and key. Items show no model, effort, run name or review identifier. Each script stops with a non-zero exit, and writes no packet or key, if a hash pin fails or a count differs from the numbers above.

## Collect the Coder Codes

Coder A (Opus 5.5, high effort) and coder B (Sonnet 5.5, high effort) each answer every batch of passes T, M, C and A. `collect.ts` reads their replies, joins each item to `data/blind-key.json`, and computes agreement before adjudication (codebook Section 10). The replies quote the reviews, so all three outputs are private: the script refuses an `--out` inside the repository checkout, and the authors keep the outputs with the other private inputs. Run from the repository root:

```sh
node papers/cr-effort-claude-5.5/findings/artifact/analysis/collect.ts --replies <dir> --batches <dir> --out <dir outside the repo> [--resamples 2000] [--seed 20261118]
```

- `--replies` holds `<pass>/<batch>.A.md` and `<pass>/<batch>.B.md` for each pass T, M, C and A, one reply per coder and batch.
- `--batches` holds the `<pass>/<batch>.json` files that `packets.ts` writes.
- `--resamples` and `--seed` set the bootstrap; `--blind-key` overrides the default `data/blind-key.json`.

Each reply's last fenced `toon` block is decoded leniently, because some replies miscount the bracketed lengths; the item check below takes the place of the length check. A leading `ITEM ` on an item code is dropped, because the prompts show items as `ITEM <code>`.

The script stops with a non-zero exit, names the batch and the item, and writes nothing if a reply file is missing or does not decode, if a reply holds an item that is not in its batch or holds one item twice, or if a batch item is missing from `data/blind-key.json` or has another pass there. An item that is in the batch but absent from one coder's reply is not an error: it is listed in `missing`, kept in `codes.json` with that coder's codes as `null`, and left out of agreement and disagreements.

`codes.json` is a list with one record per pass and item:

- `pass`, `item` (the random code), `batch`, and the blind-key fields `model`, `effort`, `instance_id`, `agent_id`, `label`, `rule` and `is_decoy`;
- `A` and `B`, each coder's decoded item object as the pass prompt's Output section defines it, or `null` for a missing item;
- for pass M, `derived.A` and `derived.B`: the review-level code (`named` if some pair scores 2, `partial` if the best is 1, `other` if all are 0, `no_codable_finding` when the coder set it), `binary` (named = 1), `sensitivity` (a score of 1 or 2 = 1) and `feedback_named` (the highest feedback score, `null` with no feedback entries).

`agreement.json` holds:

- `codes`: per code, the number of coded pairs `n`, the number of items `n_items`, and `percent`, `kappa` (Cohen's κ) and `ac1` (Gwet's AC1), each as `{value, lower, upper}` with a 95% percentile bootstrap interval that resamples items, so the findings of a review stay together. The codes are the pass T class/type/subtype triple, `quality_flag` and `multi_claim` per finding and `reproduction` per review; the pass M review-level code, its binary form and `feedback_named`; the pass C `reality` and each reason flag; and the pass A `concern` and each feedback score. A code with no coded pair is `null`.
- `T_per_type`: per finding type, how many findings each coder gave it and the agreement on that type against all others.
- `T_unaligned`: the pass T findings, matched between coders by their number `n`, that only one coder returned; they are left out of the finding-level codes.
- `T_model_guess`: per coder, how often the model guess names the reviewer's model, with a 95% Wilson interval, against chance (1/3).
- `missing`: each item absent from one coder's reply, as `{pass, batch, coder, item}`.

`disagreements.json` lists one entry per field the adjudicator settles (codebook Section 10) on which the coders differ, as `{pass, item, field, code_A, why_A, code_B, why_B}`. The fields are `findings[<n>].class_type_subtype`, `findings[<n>].quality_flag`, `findings[<n>].multi_claim` and `reproduction` (pass T); `review_level` and `pairs[finding=<n>,gold=<G>].score` for the deciding findings, those that hold the highest pair score under either coder (pass M); `reality` and each reason flag (pass C); and `concern` and `feedback[gold=<G>].score` (pass A). The model guess is never listed. `why_A` and `why_B` are the coders' reasons for that entry, or `null` where the reply gives none for the field.

## Settle, Analyze and Draw Figure 7

The adjudicator (prompt `../prompts/J-adjudicate.md`) answers one disagreement per call. Its prompts and replies are private, kept with the other private inputs. Run from the repository root:

```sh
node papers/cr-effort-claude-5.5/findings/artifact/analysis/settle.ts --codes <collect out>/codes.json --j <j-coders dir> --gold <gold-settled.json> --out <dir outside the repo> [--log data/adjudication-log.csv]
node papers/cr-effort-claude-5.5/findings/artifact/analysis/analyze.ts --settled <settle out>/settled.json --agreement <collect out>/agreement.json [--findings data/findings.csv] [--out outputs/findings.json]
node papers/cr-effort-claude-5.5/findings/artifact/analysis/figures.ts [--findings outputs/findings.json] [--out figures]
```

- `--j` holds `prompts/<id>.order.json`, which records the disagreement and which coder was shown as X and which as Y, and `<id>.J.md`, the adjudicator's reply, whose last fenced `toon` block gives `final`, `basis` (X, Y or third) and `rule_cited`.
- `--gold` is the settled gold, one entry per wrong patch with its behaviours and the behaviours the gold check changed, dropped or left contested.

`settle.ts` writes `settled.json`, one record per item with its final codes, under `--out`, and refuses an `--out` inside the repository checkout. A code both coders gave is final. Where they differ, the adjudicator's final code is used, with X and Y mapped back to coders A and B through the order file; a final that is not the code of the coder its basis names is an error. The rest:

- The pass M review-level code is never adjudicated. It is derived again from the settled pair scores, as `collect.ts` derives it per coder, with its binary and sensitivity forms.
- `collect.ts` sends only the deciding pass M pairs to the adjudicator, and no pass M feedback scores. Where the coders differ on another pair or on a feedback score, the lower score is kept and tagged `lower_unadjudicated`; such a pair cannot change the review-level code.
- A finding, pair or feedback entry that only one coder returned, and an item missing from one coder's reply, keeps that coder's codes and is tagged `one_coder`.

The script stops with a non-zero exit, and writes nothing, if any disagreement other than the pass M review-level code has no J reply or a reply that does not parse, or if a scored gold behaviour is not in the settled gold. `data/adjudication-log.csv` holds no reasons, only the codes and the rule the adjudicator cited.

`analyze.ts` counts over the 55 wrong patches in each of the nine model and effort cells: each cell's rejections of them (pass M) and acceptances (pass A) must cover every patch exactly once. Shares carry 95% Wilson intervals. `outputs/findings.json` holds:

- `by_model.<model>.<effort>`: `right_reason` (the rejections, the patches rejected with the defect named as a share of the 55 patches and of the rejections, and the partial, other and no-codable-finding counts), `patch_outcomes` (the five Figure 7 categories, summing to 55), `accepted` (feedback naming the defect, partly naming it, and the concern codes), `findings_per_rejection` (from `data/findings.csv`), `finding_types` and `reproduction` (pass T, all `fail` and malformed reviews of the cell).
- A malformed rejection with no codable finding counts as rejected for another reason in `patch_outcomes`.
- `effort_steps`: per model, low to medium and medium to high, the patches named at the higher effort only (`gained`), at the lower only (`lost`), at both and at neither. No test is run.
- `false_alarms` (pass C rejections of correct patches, by cell, rule, reality and reason flag) and `decoy_crosscheck` (the decoys' reality against their pass M review-level code).
- `agreement` (a copy of `collect.ts`'s `agreement.json`), `adjudication` (per pass, the adjudicated codes and how many took coder A's, coder B's or a third code), `gold_check`, `blinding_guess` (the pass T model guess), and the `one_coder` and `lower_unadjudicated` counts.
- `sensitivity`: the named result again, counting a partial match as named (`two_or_one`), without the contested gold patches (`no_contested`), without malformed rejections (`no_malformed`), and without the five rule L7 patches (`no_L7`).

`figures.ts` draws one 100% stacked bar per model and effort cell, the 55 wrong patches by their outcome.
