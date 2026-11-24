# Supplement: How Much Effort Does an AI Code Reviewer Need?

This supplement holds the detail behind the paper [`paper.md`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/paper.md): the full procedure, every analysis and statistical test, the full list of deviations, the per-arm tables, the spend record, wall time by machine type, the exploratory Sonnet 5.5 and Haiku 5.5 replications (Section G), the counts of shallow passes (Section H) and the exploratory RQ6 findings coding (Section I). Supplement sections are lettered (A to I) and supplement tables numbered (Table S1 to S26); a numbered section or table, such as Section 4.9 or Table 2, is in [`paper.md`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/paper.md); references are listed there. Every Opus number below is a field of [`artifact/outputs/results.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/results.json) or a row of a file in [`artifact/data/`](https://github.com/trustmybot/research-artifacts/tree/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data), every Sonnet and Haiku number a field of [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json) or a row of [`haiku-vs-opus/artifact/data/reviews.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/haiku-vs-opus/artifact/data/reviews.csv), every label-check swap number a field of [`artifact/outputs/models-swap.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models-swap.json), every shallow-pass count a field of [`artifact/outputs/shallow-pass.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/outputs/shallow-pass.json), and the source is named under each table. [`artifact/README.md`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/README.md) explains how to reproduce them.

## A Full Procedure

### A.1 Sampling Frames and Exclusions

Tasks came from SWE-bench Verified, restricted to Django. Patches came from public agent submissions in the SWE-bench experiments repository. Labels came from the Verified and SWE-ABS tests in the SWE-ABS verdict file, with the SWE-ABS tests taken from the Hugging Face dataset `OpenAgentLab/SWE-Bench_Verified_ABS` at revision `79fc07a8f4ce5e3720e069948073f5f910b7577b`.

- **Wrong frame:** patches that pass the Verified tests and fail the SWE-ABS tests.
- **Correct frame:** patches that pass both, on an instance that SWE-ABS strengthened.

Three instances used for harness checks were excluded from both frames. Of the 20 instances of an earlier pilot check, the 14 with a wrong pilot patch were excluded from the wrong frame, and all 20 from the correct frame. As the plan allows, an issue with a correct pilot patch could still enter the wrong stratum with a different patch, and three did: `django__django-13516`, `django__django-15467` and `django__django-16950` ([`harness/checks/pilot-patches.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/pilot-patches.json)). Patches of 11 agents whose patch text is not public were excluded. That left 83 instances in the wrong frame and 70 in the correct frame.

A seeded ordered draw (seed 20261102) chose one patch per instance, uniformly among qualifying agents, with no agent supplying more than 10% of a stratum: 60 wrong patches, with positions 61 to 75 held as an extension, and 30 correct patches. A correct patch may share an instance with a wrong patch, so the 90 patches cover 68 distinct issues. These strata are the original labels; Section A.5 gives the corrected labels used in every primary analysis.

### A.2 Label Check

Before any review, each drawn patch and the reserve patches checked with it ran the Verified and SWE-ABS tests three times in a local container, at no API cost. The check excluded five patches; the four in the sample were replaced from the reserve of their stratum in seed order, and the fifth was a reserve patch that was never needed (Table S1). After the main run we found a parser error in the check: it read only the per-test status lines of the Django test log, so a failure that Django reports only in its failure summary, such as a failing subtest, was not counted. Re-run on the saved logs, the corrected check finds that three of the excluded wrong patches did reproduce their label and were replaced wrongly (Table S3, row 11); the other two exclusions stand ([`harness/checks/main-exclusions-corrected.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/main-exclusions-corrected.json)). Had the check been right, the sample would differ only in those three wrong patches; Section D.8 reviews them and reports the effect. One correct patch, `django__django-14053`, reported a local SWE-ABS failure, but no SWE-ABS test failed for it beyond those that also fail for the official fix, so the harness rule counted its label as reproduced and kept it ([`artifact/data/label-check-summary.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/label-check-summary.csv)). All 90 final patches reproduced their label in all three runs.

**Table S1.** Patches the label check excluded, their replacements and the corrected check.

| Instance | Agent | Stratum, draw position | Replaced by (draw position) | Corrected check |
|---|---|---|---|---|
| `django__django-11964` | `20250515_Refact_Agent` | Wrong, 35 | `django__django-12858` (76) | Label reproduced; wrongly excluded |
| `django__django-14017` | `20250515_Refact_Agent` | Wrong, 37 | `django__django-13964` (77) | Label reproduced; wrongly excluded |
| `django__django-11206` | `20251120_livesweagent_gemini-3-pro-preview` | Wrong, 45 | `django__django-15930` (78) | Label reproduced; wrongly excluded |
| `django__django-14007` | `20250623_warp` | Correct, 13 | `django__django-11815` (31) | Label did not reproduce: the SWE-ABS run reported no tests |
| `django__django-12125` | `20250522_tools_claude-4-opus` | Wrong reserve, 83 | Not needed | Label did not reproduce: the patch does not apply (it changes the binary `db.sqlite3`), so neither test set ran |

Sources: [`artifact/data/label-check-exclusions.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/label-check-exclusions.csv) (exclusions as recorded before the run), [`harness/checks/main-draw.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/main-draw.json) (draw positions and replacements) and [`harness/checks/main-exclusions-corrected.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/main-exclusions-corrected.json) (corrected check).

The patch text has no license for redistribution, so we publish instance identifiers, agent identifiers and hashes, not patch text.

### A.3 Reviewer Configuration

Every arm received the same setup; only the effort value differed.

- **Route and model.** Claude Code 2.1.311 in non-interactive mode (`claude -p`), model `claude-opus-5-5`, the arm's effort passed as `--effort low|medium|high`. The configuration was clean: no settings sources, no plugins, no session persistence, and summarized thinking display.
- **Prompt.** One generic review prompt ([`harness/review-prompt.md`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/review-prompt.md)) drawing on Google's code-review guide, the OpenAI Codex review rubric and Anthropic's Claude Code documentation. It asks whether the change does what the task asks, is correct including edge cases, breaks existing code or tests, adds security or performance problems, is more complex than needed, and whether changed tests would fail if the code were wrong. It fails a patch only for an unmet requirement or a functional defect that matters; style, security, performance and complexity remarks go in feedback and are not grounds for a fail.
- **Task statement.** The verbatim SWE-bench `problem_statement`, pinned by hash, delivered with the commit hash and paths in a brief encoded in Token-Oriented Object Notation (TOON). The benchmark's `hints_text` was withheld.
- **Code and tools.** The Django repository at the issue's base commit, with the candidate patch as one commit on top, under a fixed author and date so nothing identified the source agent. The reviewer could read files, run shell commands and write files (`Read`, `Bash` and `Write`).
- **What it could not see.** The benchmark's scoring tests, the official fix and the SWE-ABS tests, except changes the candidate patch itself contained; any label; the source agent's messages; and the network other than the model API. Preflight checks on the base commit enforced the first group before each model call, and an internal Docker network with an allowlist proxy enforced the network rule.
- **Verdict.** One fenced TOON block holding `verdict` (`pass` accepts, `fail` rejects), `feedback` and `findings`, decoded strictly. A malformed block counts as no verdict.
- **Effort delivery.** The CLI does not report the effort the model applied (`effective_effort` is empty, as the plan anticipated). A request capture before the run showed that each flag reaches the model request as the matching effort value.

### A.4 Environment and Run Order

Reviews ran in fresh per-instance SWE-bench containers, pinned by image digest, on Google Cloud Platform virtual machines. Each review had a $4 budget cap and a 60-minute timeout in every arm. Costs are list-price U.S. dollars computed by the CLI from token counts.

The main run took place on November 2 and 3, 2026. The first 2 patches (6 reviews) ran at harness commit 1adaa24 and the next 10 patches (30 reviews) at 64badb4, both on one e2-standard-4 machine. The remaining 78 patches (234 reviews) ran at commit a83c3e6, split across six e2-standard-2 machines (`provenance.rows_by_origin`). The model, CLI version, environment file and per-patch prompt hash were the same in all 270 reviews (`provenance.model_cli`, `provenance.environment_hashes`, `provenance.prompt_hash_per_patch_consistent`). All 270 reviews stopped normally (`provenance.stop_reasons`).

Of 323 model-call attempts in the main lineage and the repeat batch, 33 were not kept: 32 failed on the workspace usage limit and 1 stopped at preflight (`provenance.attempts_not_kept`).

The preregistered internal pilot was to inspect process data, not verdicts, on the first 10 main patches: the manipulation check, and whether the caps sat above the 95th percentile of cost and time at high effort. Its gate decision was not recorded (Table S3, row 3).

After the main run, 20 main patches (14 wrong and 6 correct by the original labels, 11 and 9 by the corrected labels, drawn with the published seed) were reviewed again at high effort, at harness commit 9d882cf, to measure run-to-run noise.

### A.5 Label Correction

After data collection, every label of the 90 main patches and of the three patches reviewed in Section D.8 was rechecked against seven written label rules, L1 to L7, agreed before any rescoring ([`LABELS.md`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/LABELS.md) at the repository root). The rules ask whether the failing SWE-ABS test checks what the issue asks (L1) or an adjacent input the official fix gets right (L2), whether the test is broken (L3, decided by a person), whether it checks only an implementation detail of the official fix (L4), whether the patch behaves like the official fix or shares its defect (L5, L6), and whether a concrete input exists that the official fix handles and the patch does not, though no test checks it (L7). Language-model agents applied the rules, and each of the three authors checked 30 of the 90 main patches; both the agents and the co-authors proposed changes, and the first author ruled on each one. [`artifact/data/labels.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/labels.csv) holds, per patch, the original label, the deciding rule and the corrected label.

**Table S2.** Label changes (`label_changes`).

| Set | Patches | Unchanged | Wrong to correct, L4 | Wrong to correct, L3 | Correct to wrong, L7 |
|---|---|---|---|---|---|
| Main | 90 | 79 | 7 | 1 | 3 |
| Label-check sensitivity (Section D.8) | 3 | 2 | 1 | 0 | 0 |

The corrected main sample has 55 wrong and 35 correct patches. The preregistration fixed the original labels, so the correction is a deviation (Table S3, row 13), and Section D.10 reports the original-label results. The false-alarm ceiling and the guardrail were set for 30 correct patches and kept unchanged for 35 (Section B.2). The label rules also define an overlay, O5, for a review whose verdict matches a behavior the project adopted upstream after the official fix; it marks 3 main patches and 1 sensitivity patch and changes no label.

## B Analyses and Statistical Tests

All tests and margins below were preregistered unless marked exploratory.

### B.1 Confirmatory Tests

- **H2 (primary), non-inferiority.** Paired difference in false success, medium minus high, with a Tango score 95% confidence interval; H2 holds if the upper limit is below .15. Sensitivity: Newcombe hybrid interval.
- **H1, superiority.** One-sided exact McNemar test on the wrong patches (55 by the corrected labels, 60 by the original labels), high against low. Sensitivity: mid-*p* McNemar.
- **H3, cost saving.** Ratio of geometric-mean cost, medium over high, with a paired bias-corrected and accelerated (BCa) bootstrap over patches (10,000 resamples, seed 20261102, mulberry32 generator); H3 holds if the upper limit is below .70. A Wilcoxon signed-rank test on paired log costs shifted by log(.70) gives its *p* value.
- **Multiplicity.** The three hypotheses form one family at one-sided α = .025 under the Holm correction. The plan changed from a fixed testing sequence to Holm at 12:51 UTC on November 2, 2026, before the OSF filing, and the filed plan at commit 9f4e941 carries the change.

### B.2 Limits on the Medium Conclusion

- **Guardrail:** fails if medium rejects more than *k* = 4 of the correct patches that high accepts.
- **Ceiling:** fails if medium or high rejects more than 6 correct patches (20% of the original 30).

Both limits were set when the sample had 30 correct patches. Under the corrected labels it has 35, and we kept *k* = 4 and the ceiling of 6 unchanged on purpose rather than rescale them after the data were in; as shares, 6 of 35 is 17% and the limits are slightly more lenient.

### B.3 Sample Size and Blinded Re-estimation

The plan specified that, after the first 30 wrong patches, a script would count only the patches on which medium and high disagreed and set the final number of wrong patches to min(75, max(60, ⌈7.85 *p̂*<sub>disc</sub> / .15²⌉)), where *p̂*<sub>disc</sub> is the observed share of discordant patches. The power analysis assumed 10% to 25% discordant patches. No such script ran during the main run; the analysis script computed the count after the run, with all verdicts open and on the original labels, the ones in force during the run (Table S3, row 12).

### B.4 Incomplete Reviews

The primary analysis counts a review with no usable verdict as no acceptance; a sensitivity analysis counts it as acceptance. No review was incomplete, so the two codings agree (`incomplete`, `malformed_verdicts`, `sensitivity_incomplete_as_accept`).

### B.5 Descriptive Analyses

- **Single proportions** carry 95% Wilson intervals.
- **Balanced agreement:** the mean of (1 − false success) and (1 − false alarm).
- **Incremental cost** between adjacent effort levels: extra cost per review, extra wrong patches caught, extra false alarms (`incremental`).
- **True success:** the share of accepted patches that are correct when a share *w* of incoming patches is wrong, for *w* = .167 (the share of passing Django patches that the released SWE-ABS verdicts reject, 1,162 of 6,973 by our count) and *w* = .5 (`true_success`).
- **Label-error sensitivity:** observed false success equals (1 − *e*) × true false success + *e* × P(accept | correct), where *e* is the share of wrong labels. We solved for true false success at *e* = .05, .10 and .20 (`label_error_sensitivity`). This shows how far label error could move the result; it does not estimate *e*.
- **Similarity to the official fix:** changed lines per file compared with the official fix and the test patch (`contamination.classes`, [`artifact/data/patch-similarity.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/patch-similarity.csv)).
- **Flip rate:** the share of repeated patches whose verdict at high effort changed, with a Wilson interval; and the root-mean-square log ratio of repeat cost to original cost (`repeats`).
- **Discrepancy tiers:** a patch is marked when any arm disagrees with its label. Tier 1 holds patches on which all three arms disagree with the label, tier 2 those on which the arms split, and tier 3 those on which all arms agree; a fixed random sample of tier 3 would enter any audit (`disagreement.discrepancy_tiers`).
- **Wall time** is compared only within one machine type (Table S14).
- **Agreement between coders**, and between the two recall-test runs, is Cohen's kappa.

### B.6 Exploratory Analyses

- **Issue-requirement coding (post hoc).** For each wrong patch, a single Claude Opus 5.5 coder read the issue text and the failing SWE-ABS tests with their output, and judged whether the issue requires the behavior those tests check: required, not required or unclear ([`artifact/data/issue-requires-coding.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/issue-requires-coding.csv)). The coder was blind to per-patch verdicts but not to the aggregate results. Wrong patches with no failing SWE-ABS test (the 3 that the label correction made wrong) form a fourth group, no failing test. We report false success by group and rerun H1 to H3 without the not-required group (`label_question`).
- **Memory coding.** Every main-run transcript was coded for whether the reviewer's memory of the upstream fix drove its decision. Coders saw the issue, the patch, the official fix and the reviewer's thinking, tool calls and answer, and did not see the effort arm, the label, the source agent or the cost. Twelve batches of Claude Opus 5.5 coders, the model under test, coded all 270 reviews; 60 reviews were coded twice to measure agreement. A review is flagged when memory of the fix was decisive in its thinking or appeared as a reason in its final answer. The preregistered sensitivity analysis drops every patch with any flagged review, because the comparison is paired (`memory`).
- **Recall test.** The model wrote the fix for each main issue from the issue text alone, with no repository and no tools, at high effort with adaptive thinking and at most 12,000 output tokens ([`harness/checks/recall.ts`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/recall.ts)). The score is the share of the official fix's changed lines it reproduced, counting only lines that do not already appear in the issue text. An issue is in the full-recall group when the run before the main run recovered all of those lines, and in the partial-recall group otherwise (`recall`, `recall.split`). The run after the main run measures how stable the grouping is (`recall_runs`).
- **Issue-text properties:** text patterns over the problem statement (`issue_properties`).
- **Not done:** the planned exploratory causal mediation analysis (Table S3, row 7).

## C Deviations From the Preregistration and the Study Plan

Table S3 lists every departure from the plans that we found in the run records. Rows 1 to 13 depart from the preregistered Opus plan; none changed the review prompt or the hypotheses, and none changed the patch list after it was frozen, though row 11 affected how the list was built. Row 13 corrected 11 labels after data collection. Rows 14 to 19 depart from the written study plan for the Sonnet and Haiku studies, which was approved before any paid run but never filed with a registry. Paper Table 2 shows the 12 rows that bear on how the results read; rows 1, 3, 5 and 12 (no effect on any result) and rows 9, 10 and 18 (administrative) appear here only.

Two terms recur. The *recall test* is a memory probe: the model gets only the issue text, with no code or tools, and writes the official fix; the score is the share of the fix's changed lines, not already in the issue text, that it reproduces, and a high score suggests that the model saw the fix in training. A *mediation analysis* tests whether effort lowers false success through a measured route, here more checking (more thinking, tool calls and test runs), rather than only showing that the two go together.

**Table S3.** Deviations from the preregistered Opus plan (rows 1 to 13) and from the Sonnet and Haiku study plan (rows 14 to 19), in full.

| # | What the plan said | What happened | Why it matters |
|---|---|---|---|
| 1 | All Opus reviews run on one kind of machine with one harness version; if a change is forced, it is assigned to patches at random. | The first 12 patches (36 reviews) ran on one e2-standard-4 machine at harness commits 1adaa24 and 64badb4; the other 78 patches (234 reviews) ran on six smaller e2-standard-2 machines at commit a83c3e6. The switch happened in patch order, not at random. | The model, CLI, prompt and container were the same throughout, so verdicts and cost should not depend on the machine. Wall time does, so it is reported by machine type (Table S14). |
| 2 | The three Opus reviews of each patch run one right after another, so that any change in the model over time affects all three efforts equally. | 32 attempts failed because the account hit its API spending limit (error 400, "You have reached your specified workspace API usage limits"; 11 low, 10 medium, 11 high, in shards 0, 3, 4 and 5). They were re-run in four later batches, started between 23:20 and 23:22 UTC, apart from the other reviews of the same patch. | For those 32 reviews, drift over time is not balanced across efforts. Three failed attempts had already cost $0.55, which is kept in the spend record. |
| 3 | After the first 10 patches, the run pauses; the authors check the pilot results and write down whether to stop or continue. | The run paused as set, at 19:59 UTC on November 2, 2026, after 12 patches (the 10 finished after the restart for the preflight bug in row 10, plus 2 from before it). It resumed on six machines about 8 minutes later, but nobody wrote the decision down. | The checks the pause was meant to support, that effort changes behavior and that no review hits the cost cap, pass on the full data, so the missing record changes no result. Cost and token data were visible at the pause; verdicts by effort were not. |
| 4 | The recall test, a memory probe in which the model writes the official fix from the issue text alone with no code or tools, runs on the 68 main issues before the main run and is reported. | It ran on time: batch `20261102t124549z-5e7b1da` scored 74 issues, including all 68 main issues, from 12:47 to 13:39 UTC on November 2, before the OSF filing at 14:46 UTC and the first main-run batch at 18:15 UTC. The run record did not report it, and the plan's spend total left out its $2.67. A second run on the 68 main issues, on November 3 at commit 3a31e6c with the same script, came after all 270 main reviews and the 20 repeats; a session spend guard stopped it after 14 issues and the other 54 ran next. The run record reported only this second run. | Neither run can affect a verdict, because the reviewer never saw them. The paper's recall split uses the run before the main run. The two runs put 9 of 67 issues in different recall groups (Table S8), so groupings by recall are noisy. |
| 5 | Each patch on which the reviewer and the label disagree is tagged with an audit priority when it runs, and any audit follows that order. | No priority was stored with the runs (`audit_tier` is empty on every run). The analysis script assigned the priorities after the run (Table S7), and no audit by priority was done. | None on the results. The label check done instead covers every patch, not only disagreements (row 13). |
| 6 | Before any review, record for each wrong patch whether the issue actually requires the behavior its failing SWE-ABS test checks. | This was coded only after the Opus run, by one Claude Opus 5.5 coder that did not see per-patch verdicts but knew the overall results. | The split by this coding is exploratory; a person should redo the coding. |
| 7 | An exploratory mediation analysis, with a sensitivity analysis for unmeasured confounding: does effort lower false success by making the reviewer check more? | Not done; no reason was recorded at the time. Behavior is reported only as the manipulation check, the evidence that effort changed what the reviewer did (paper Section 4.1). In hindsight the analysis would have added little: it needs sequential ignorability [15], which patch difficulty likely breaks, since a harder patch draws both more checking and a different verdict; and the 14 wrong patches whose Opus verdict differed between low and high are too few to estimate an indirect effect precisely. | The paper reports that more effort came with more checking, but makes no claim that the checking caused the better verdicts. |
| 8 | Coders who do not know the effort, label or cost flag Opus reviews in which memory of the upstream fix drove the verdict, at no API cost. | The coders were Claude Opus 5.5 (`claude-opus-5-5`), the model under test, working in 12 batches; no person checked their flags. | The flags are a model's judgment, and a coder of the same model may share the reviewer's blind spots about what it remembers. |
| 9 | 20 repeated Opus reviews at high effort, at about $2.40. | They ran at harness commit 9d882cf, which added the repeat mode, and cost $3.07. | None on the main results; the extra $0.67 is in the spend record. |
| 10 | Only the planned main-run batches call the model. | One review of a patch used to check the harness (`django__django-10097`, medium, $0.11) ran by mistake; one batch stopped before any model call ($0); and the first main batch stopped after 6 reviews on a bug in the preflight check, fixed in commit 64badb4. | None. The stray review is not study data; its cost is in the spend record. |
| 11 | A drawn patch is replaced only if its label fails to reproduce when both test suites run locally. | A bug in our label check read only Django's per-test status lines and missed failures that Django reports only in its failure summary at the end of the log, such as a failing subtest. Three wrong patches whose label did reproduce (`django__django-11964`, `django__django-14017`, `django__django-11206`) were therefore replaced by reserve patches. The OSF filing's count of 5 of 103 checked patches failing to reproduce inherits the bug; the correct count is 2 (Table S1). | The replacements followed the seeded reserve order, but the loss was not random: the excluded patches were one kind of wrong patch, those whose failure shows only in Django's failure summary, so the sample lacks that kind. After the main run all three models reviewed the three patches at every effort and accepted them in all 27 reviews; swapping them back in changes no hypothesis decision for any model, on the corrected or the original labels (Section D.8). |
| 12 | After the first 30 wrong patches, a script counts, without showing verdicts, the patches on which medium and high disagree, and sets the final sample size from that count. | No script ran during the main run, which went ahead with 60 wrong patches. The analysis script computed the count (`blinded_look`: 1 disagreement in 30) after the run, with all verdicts open; it first appears in the repository on November 3, 2026. | None on the sample: 1 disagreement in 30 gives ⌈7.85 × (1/30) / .15²⌉ = 12 wrong patches needed, so the rule keeps 60. The check was neither blind nor on time. |
| 13 | Labels are fixed before the run: wrong means the patch passes the original Verified tests and fails the strengthened SWE-ABS tests; correct means it passes both. | After data collection, every label was rechecked against seven written rules agreed before any rescoring (Section A.5). Eleven changed: 7 wrong patches became correct because the failing test checks an implementation detail the issue does not ask for (rule L4), 1 because the test is broken and a person found no input that the official fix handles and the patch does not (L3), and 3 correct patches became wrong because such an input exists (L7). The corrected labels, 55 wrong and 35 correct, are primary. The false-alarm ceiling of 6 and the guardrail of 4 were set for 30 correct patches and kept unchanged on purpose for 35. | Every rate and test moves, but no hypothesis decision does, for any model (Section D.10). For Opus under the original labels, false success at low is 43 of 60 (.717), H1 is supported (exact *p* = .0032), H2 is supported (*p* = .001) and H3 is not. Correcting labels after seeing the verdicts can bias them toward the reviewer; every label was checked, not only disagreements, the rules were fixed before rescoring, and labels moved both ways. |
| 14 | The Sonnet and Haiku studies are preregistered before data collection. | Their plan was approved on November 5, 2026, before the pilot and the main run, and treated as a preregistration, but it was never filed with a public registry. | A plan without a registry's time stamp is not a preregistration, even when it predates the data, so every Sonnet and Haiku test is exploratory. |
| 15 | The plan tests whether Sonnet at medium, then Haiku at medium, is about as good as Opus at medium (within 15 points on Youden's *J*, tested in a fixed order), plus a trend across efforts within each model and a coded test of one explanation for differences between the models. | After the main run, these hypotheses were set aside and the three Opus hypotheses were run on each model instead. The comparison with Opus at medium is reported descriptively (Table S17), and the coded test was not done. | No confirmatory claim compares models. Choosing analyses after seeing the data allows selective reporting, so both the plan's comparison and the Opus hypotheses are reported in full. |
| 16 | A review whose verdict block cannot be read is re-run once. | No review was re-run. The Opus plan's rule was applied instead: a malformed verdict counts as no acceptance, so it is not a false success on a wrong patch but is a false alarm on a correct one; counting it as acceptance is the sensitivity analysis (Table S16). The table on the run record counted a malformed verdict on a correct patch in neither column, so its false-alarm counts are one lower in five of the six settings. | 15 malformed reviews (Sonnet 10, Haiku 5) stay in the data. No hypothesis decision changes between the two ways of counting them. |
| 17 | The Sonnet and Haiku reviews run with the same harness version as the Opus run. | They ran three days later at `fa7afee`, the head of an unmerged pull request that added the model option and fixed the proxy address. The six Sonnet and Haiku reviews of a patch ran back to back in a shuffled order, but Opus was not re-run beside them. | Any change in the model service between November 2 and 5 is mixed up with the difference between models. The run records show the same CLI (2.1.311), container images, environment file, per-patch prompt and $4 cap as the Opus run, on the e2-standard-2 machine type. |
| 18 | Each review runs once. | Shard 4 of 5 was interrupted and resumed in a new batch. The 6 reviews that finished in the original shard are kept, including run 29 (Haiku, high, malformed); the resumed batch's re-run of run 29 is not kept, and the other shard-4 reviews come from the resumed batch. | None on the analyzed reviews; the re-run's cost is in the spend total (Table S18). |
| 19 | The Opus checks carry over to Sonnet and Haiku. | No sample-size check, repeated reviews, memory coding or recall test was run for Sonnet or Haiku, and their machine cost was not recorded. | Their run-to-run noise and the role of memory are unmeasured, so the recall split and the memory results are Opus only. Only API spend is reported, because these runs carry no study label in the billing data. |

Sources: [`artifact/data/attempts.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/attempts.csv), [`artifact/data/spend-ledger.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/spend-ledger.csv), [`artifact/outputs/results.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/results.json) (`provenance`, `disagreement.discrepancy_tiers`), [`artifact/data/recall-scores.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/recall-scores.csv) and [`artifact/data/recall-after-main.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/recall-after-main.csv). Times come from the batch run identifiers and the batches' run records.

## D Per-Arm Tables

### D.1 Reviewer Behavior

**Table S4.** Reviewer behavior by effort, with paired medians of the per-patch difference.

| Measure | Low | Medium | High | Paired median, high − low | Paired median, high − medium |
|---|---|---|---|---|---|
| Output tokens, median | 1,106 | 2,244 | 2,949 | 1,710 | 693 |
| Thinking tokens, median | 216 | 598 | 1,068 | 786 | 325 |
| Tool calls, median | 3 | 4 | 4 | 2 | 0 |
| Turns, median | 4 | 5 | 5 | 2 | 0 |
| Shell test runs, median | 1 | 2 | 2 | 1 | 0 |
| Shell test runs, mean | 1.33 | 2.23 | 2.62 | | |

*n* = 90 reviews per arm. High produced more output tokens than medium on 91% of patches and more thinking tokens on 83%. Source: `manipulation`.

### D.2 Cost and Wall Time

**Table S5.** Cost and wall time per review by effort.

| Measure | Low | Medium | High |
|---|---|---|---|
| Total cost (USD) | 3.97 | 8.52 | 10.81 |
| Mean cost | 0.044 | 0.095 | 0.120 |
| Geometric-mean cost | 0.040 | 0.081 | 0.101 |
| Median cost | 0.039 | 0.080 | 0.093 |
| 95th percentile cost | 0.081 | 0.203 | 0.261 |
| Maximum cost | 0.108 | 0.428 | 0.517 |
| Median wall time (min) | 0.37 | 0.65 | 0.82 |
| 95th percentile wall time (min) | 0.77 | 2.86 | 3.01 |
| Maximum wall time (min) | 1.13 | 20.38 | 20.63 |

*n* = 90 reviews per arm. List-price U.S. dollars. Wall time pools two machine types; Table S14 separates them. The largest review cost and the longest wall time sit far under the $4 and 60-minute caps, so the caps did not bind. Source: `cost`.

### D.3 Confirmatory Test Details

**Table S6.** Confirmatory tests with sensitivity versions.

| Hypothesis | Estimate | 95% CI | Test | *p* (one-sided) | Holm threshold | Supported |
|---|---|---|---|---|---|---|
| H1: high false success < low | Difference −.218 (*b* = 13, *c* = 1) | [−.350, −.101] Tango | Exact McNemar | .0009 (mid-*p* .0005) | .0083 | Yes |
| H2: medium false success ≤ high + .15 | Difference .018 (*b* = 2, *c* = 1) | [−.065, .108] Tango; [−.051, .087] Newcombe | Tango score, non-inferiority | .0052 | .0125 | Yes |
| H3: geometric-mean cost ratio medium/high < .70 | Ratio .798 | [.750, .849] BCa | Wilcoxon signed-rank on log ratio − log .70, *V* = 3138, *z* = 4.39 | > .999 | .025 | No |

Corrected labels. *n* = 55 wrong patches for H1 and H2 and 90 patches for H3. For H2, *b* counts wrong patches that medium accepts and high rejects, and *c* the reverse; for H1, *b* counts wrong patches that low accepts and high rejects. The conclusions are the same with the mid-*p* McNemar test (`holm_with_mid_p`) and under the original labels (Section D.10). Medium rejected no correct patch that high accepted (guardrail *k* = 4), and each arm rejected 2 of the 35 correct patches (ceiling 6) (`guardrail`, `ceiling`). The sample-size look did not run during the main run; computed afterwards on the original labels, the ones in force during the run (Table S3, row 12), medium and high disagreed on 1 of the first 30 wrong patches, which keeps the sample at 60 drawn wrong patches (`blinded_look`). Source: `hypotheses`, `holm`.

### D.4 Verdict Agreement and Discrepancy Tiers

The three arms gave the same verdict on 76 of the 90 patches (`disagreement.all_three_agree`). Low and high differed on 14 patches, low and medium on 11, and medium and high on 3. Across arms the reviewer accepted 187 patches and rejected 83 (`provenance.verdicts`).

**Table S7.** Patches by discrepancy tier.

| Label | Tier 1: all arms disagree with the label | Tier 2: arms split | Tier 3: all arms agree with the label |
|---|---|---|---|
| Wrong (55) | 24 (all three accept) | 14 | 17 (all three reject) |
| Correct (35) | 2 (all three reject) | 0 | 33 (all three accept) |
| Total (90) | 26 | 14 | 50 |

40 of 90 patches are marked as discrepancies under the corrected labels. The tiers were assigned by the analysis script after the run (Table S3, row 5). Source: `disagreement.discrepancy_tiers`.

### D.5 Recall Test, Both Runs

In the run before the main run the model named 93.6% of the files the fix changes. For one issue, `django__django-16527`, every changed line of the fix appears in the issue text, so it has no recall score. Per issue, the second run recovered more of the lines not in the issue on 11 issues, fewer on 7 and the same number on 50. The full-or-partial group changed for 9 of the 67 scored issues (58 of 67 agree, Cohen's κ = .72): 6 moved from partial to full recall and 3 from full to partial. These 9 issues carry 7 of the 54 grouped wrong patches (`recall_runs`). Every call in both runs completed and returned a parseable diff.

**Table S8.** Recall of the official fix from the issue text alone, in two runs on the 68 main issues.

| Measure | Before the main run | After the main run |
|---|---|---|
| Batch or commit | `20261102t124549z-5e7b1da` | 3a31e6c, local, in two parts |
| Date (UTC) | November 2, 12:47–13:39 | November 3 |
| Instances run | 74 (68 main) | 68 |
| Changed files named | 73/78 (93.6%) | 74/78 (94.9%) |
| Changed lines reproduced | 526/778 (67.6%) | 578/778 (74.3%) |
| Lines not in the issue text reproduced | 493/736 (67.0%) | 541/736 (73.5%) |
| Issues with all such lines recovered | 38 of 67 | 41 of 67 |
| Issues with none recovered | 2 of 67 | 3 of 67 |
| Cost for the 68 main issues (USD) | 2.33 | 2.36 |

Counts pool the 68 main issues. Agreement between runs was computed by joining the two tables on `instance_id`. Sources: [`artifact/data/recall-scores.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/recall-scores.csv) and `recall` (before); [`artifact/data/recall-after-main.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/recall-after-main.csv), written by [`harness/checks/recall-csv.ts`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/recall-csv.ts) (after); `recall_runs` (both runs and their agreement).

### D.6 Memory Coding Details

The coders judged that 237 of the 270 reviews mentioned or used knowledge of the upstream fix in some way. In one review memory was the sole basis of the verdict. Agreement between the two codings of 60 reviews was κ = .77 for the flag (53 of 60), κ = .91 for final reasons and κ = .82 for any mention. Reviews on fully recalled issues were flagged more often, 70 of 156 against 34 of 111 (`recall.flag_rate_by_group`).

**Table S9.** Memory flags and verdicts.

| Measure | Low | Medium | High | All arms |
|---|---|---|---|---|
| Reviews flagged | 41 | 37 | 29 | 107 of 270 |
| Wrong patches accepted, flagged reviews | | | | 34 of 48 (.71) |
| Wrong patches accepted, unflagged reviews | | | | 54 of 117 (.46) |
| Correct patches rejected, flagged reviews | | | | 3 of 59 |
| Correct patches rejected, unflagged reviews | | | | 3 of 46 |

Corrected labels. Source: `memory`, `memory.flagged_wrong_accepted`, `memory.flagged_correct_rejected`.

The sensitivity analysis without any patch that has a flagged review keeps 32 patches (25 wrong, 7 correct). On those, false success was .48 at low and .20 at medium and high, and false alarm 1 of 7 in each arm; H1 exact *p* = .0078, difference −.28, 95% CI [−.476, −.110]; H2 difference 0, 95% CI [−.133, .133], *p* = .0178; cost ratio .815 (`memory.rates_unflagged`, `memory.hypotheses_unflagged`).

### D.7 Issue-Requirement Subset

The coding covers the 52 wrong patches that fail an SWE-ABS test (6 required, 14 unclear, 32 not required). The 3 patches that the label correction made wrong pass every test, so they have no failing test to code and form their own group, kept in the subset below (`label_question.coding`). Without the 32 not-required patches, 23 wrong patches remain. H1: difference −.217, 95% CI [−.437, .010], exact *p* = .0625 (mid-*p* .0352). H2: difference .043, Tango 95% CI [−.143, .236], *p* = .114, upper limit above the .15 margin. H3: ratio .806, 95% CI [.744, .876] (`label_question.without_not_required.hypotheses`).

### D.8 Robustness Details

**Table S10.** False success corrected for label error at rate *e*.

| *e* | Low | Medium | High |
|---|---|---|---|
| 0 (observed) | .673 | .473 | .455 |
| .05 | .659 | .448 | .429 |
| .10 | .643 | .420 | .400 |
| .20 | .605 | .355 | .332 |

Corrected labels. Source: `label_error_sensitivity`.

One correct patch is line-for-line identical to the official fix, and one wrong patch contains a file identical to a file of the benchmark's test patch; no other patch is identical to the official fix in any file (`contamination.classes`, which uses the original strata). Without the identical correct patch, false alarm is 2/34 in each arm (`contamination.false_alarm_without_identical`).

Repeats at high effort: no verdict flipped (0 of 20, 95% Wilson CI [0, .161]). By the corrected labels they covered 11 wrong patches (6 accepted and 5 rejected both times) and 9 correct patches (8 accepted and 1 rejected both times). Repeat cost differed from the original by a median of $0.017, with a root-mean-square log cost ratio of .283 (`repeats`).

Label-check sensitivity: after the main run we reviewed the three wrongly excluded patches (Table S1) with Opus, Sonnet and Haiku at each effort, with the main run's prompt, seed and container image (27 reviews, $0.99, not in Table S13; [`artifact/data/label-check-sensitivity-reviews.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/label-check-sensitivity-reviews.csv)). All 27 reviews accepted the patch. We then put the three patches back in place of their replacements and reran the comparison of all three models. By the corrected labels, two of the three are wrong and `django__django-14017` is correct by rule L4; it replaces the wrong `django__django-13964`, while the wrong `django__django-11964` replaces `django__django-12858`, which is correct by rule L4, so each arm keeps 55 wrong and 35 correct patches. The replacements had drawn three rejections, all of wrong patches: Opus at medium and high on `django__django-13964`, and Haiku at high on `django__django-15930`. With the swap, Opus false success is .673, .491 and .473 at low, medium and high (from .673, .473 and .455; Table S10), and Haiku's at high is .527 (from .509); false alarm and Sonnet's rates do not change. No Holm decision changes for any model: Opus rejects H1 and H2 but not H3, Haiku rejects H1 and H3 but not H2, and Sonnet rejects H3 only, and with the mid-*p* also H1, as without the swap. For Opus, H1 has 12 patches that only low accepted and 1 that only high accepted (exact *p* = .002, from 13 and 1 with *p* < .001), H2 is unchanged (*b* = 2, *c* = 1, Tango 95% CI [−.065, .108], *p* = .005) and H3's cost ratio is .808 (from .798); Youden's *J* is .452 at medium and .470 at high (from .470 and .488). For Haiku, H1 has 15 and 1 discordant patches (from 16 and 1; exact *p* < .001 in both), H2 gives *p* = .272 (from .370) and H3's ratio is .483 (from .487). For Sonnet, H3's ratio is .617 (from .614). Δ*J* for Haiku at high against Opus at medium stays at −.094, now with 95% CI [−.279, .087] (Table S17: [−.285, .094]), so it still misses the −.15 non-inferiority margin. The swap was first computed on the original labels, before the label correction; there too no Holm decision changed, and Opus false success at medium and at high rose from .550 to .567 and Haiku's at high from .567 to .583. Source: [`artifact/outputs/models-swap.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models-swap.json) (`swap`; `by_model` on the corrected labels, `original_labels.by_model` on the original labels), written by `analysis/swap-sensitivity.ts` with the command in [`artifact/README.md`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/README.md). The three patches have no issue-requirement code, so the subsets in Section D.7 are not recomputed.

### D.9 Issue Text

Of the 68 issue texts, 8 mention an upstream pull request or commit, 9 contain an upstream reference in their last 300 characters, 9 propose a code change, 6 contain a traceback and 13 repeat a sentence (`issue_properties`). These properties were the same in every arm.

### D.10 Results Under the Original Labels

The preregistration fixed the original labels, 60 wrong and 30 correct (Table S3, row 13). Table S11 gives the main rates and tests under them; the hypothesis decisions match the corrected labels.

**Table S11.** Rates and confirmatory tests under the original labels.

| Measure | Low | Medium | High |
|---|---|---|---|
| False success (60 wrong) | 43 (.717) [.592, .815] | 33 (.550) [.425, .669] | 33 (.550) [.425, .669] |
| False alarm (30 correct) | 3 (.100) [.035, .256] | 4 (.133) [.053, .297] | 5 (.167) [.073, .336] |
| Balanced agreement | .592 | .658 | .642 |

| Hypothesis | Estimate | 95% CI | *p* (one-sided) | Holm threshold | Supported |
|---|---|---|---|---|---|
| H2: medium false success ≤ high + .15 | Difference 0 (*b* = 1, *c* = 1) | [−.074, .074] Tango; [−.055, .055] Newcombe | .001 (Tango) | .0083 | Yes |
| H1: high false success < low | Difference −.167 (*b* = 11, *c* = 1) | [−.286, −.065] Tango | .0032 (exact McNemar; mid-*p* .0017) | .0125 | Yes |
| H3: geometric-mean cost ratio medium/high < .70 | Ratio .798 | [.750, .849] BCa | > .999 (Wilcoxon) | .025 | No |

Under the original labels medium rejected no correct patch that high accepted and the most false alarms in an arm was 5 of 30, so both limits held. Medium, not high, had the highest balanced agreement. Source: [`artifact/outputs/results.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/results.json) (`original_labels`).

**Table S12.** Sonnet 5.5 and Haiku 5.5 (exploratory) under the original labels: rates on the 90 analyzed patches.

| Model | Measure | Low | Medium | High |
|---|---|---|---|---|
| Sonnet | False success (60 wrong) | 41 (.683) [.558, .787] | 39 (.650) [.524, .758] | 35 (.583) [.457, .699] |
| Sonnet | False alarm (30 correct) | 2 (.067) [.018, .213] | 4 (.133) [.053, .297] | 6 (.200) [.095, .373] |
| Sonnet | Balanced agreement | .625 | .608 | .608 |
| Haiku | False success (60 wrong) | 48 (.800) [.682, .882] | 39 (.650) [.524, .758] | 34 (.567) [.441, .684] |
| Haiku | False alarm (30 correct) | 2 (.067) [.018, .213] | 6 (.200) [.095, .373] | 5 (.167) [.073, .336] |
| Haiku | Balanced agreement | .567 | .575 | .633 |

Under the original labels Sonnet agreed best at low and Haiku at high. On the original labels of the 90 analyzed patches, the Holm decisions are H3 alone for Sonnet (H1: 9 patches that only low accepted and 3 that only high accepted, exact *p* = .073; H2: *b* = 6, *c* = 2, *p* = .0588; H3 ratio .614, *p* = .0002) and H1 and H3 for Haiku (H1: 15 and 1, exact *p* = .0003; H2 *p* = .1667; H3 ratio .487, *p* < .0001), the same as under the corrected labels. Neither limit was breached for either model under the original labels: medium rejected 2 (Sonnet) and 3 (Haiku) correct patches that high accepted, and the most false alarms in one setting was 6 for both, at the ceiling. Source: [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json) (`original_labels.by_model.<model>.rates`, `hypotheses`, `holm`, `guardrail`, `ceiling`).

## E Spend Record

Table S13 reconciles all model spend. The preregistered study plan ([osf.io/r8q2m](https://osf.io/r8q2m)) gives the spend as $29.87: $6.57 before the main run plus the main run's $23.30. That total leaves out the recall run on 74 instances before the main run, the cost of failed attempts, the stray review, and the repeats and second recall run, which came later. The run record reports the main run ($23.30), the repeats ($3.07) and the second recall run ($2.36) but gives no study total. The full spend is $38.63, under the study's $60 stop. With about $11.07 for the Sonnet and Haiku studies (Section G.5) and $0.99 for the 27 label-check sensitivity reviews (Section D.8), model API spend for the whole experiment was about $50.69. Google Cloud compute is billed separately and is not included; it was not recorded for this study, so only model API spend is reported.

**Table S13.** Model spend by item.

| Item | Batch | Reviews or instances | Cost (USD) |
|---|---|---|---|
| Minimum viable product reviews, before the bucket ledger | Not in the ledger | Not recorded | 0.44 |
| Smoke test, not study data | `b5c3571`, `559266a` | 9 reviews | 0.5546 |
| Pilot check, 20 patches outside the main draw | `8a29e2a` | 60 reviews | 5.0413 |
| Recall test, 20 probe instances | `8a29e2a` | 20 instances | 0.5378 |
| Recall test, 74 instances including the 68 main issues | `5e7b1da` | 74 instances | 2.6665 |
| Main run, kept reviews | `1adaa24`, `64badb4`, `a83c3e6` shards and resumes | 270 reviews | 23.2983 |
| Main run, attempts not kept | Same | 33 attempts | 0.5473 |
| Stray review of a check patch | `231252z` (`a83c3e6`, shard 0) | 1 review | 0.1073 |
| Batch stopped at preflight | `2724560` | 0 | 0 |
| Repeats at high effort | `9d882cf-r2` | 20 reviews | 3.0710 |
| Recall test after the main run, 68 main issues | 3a31e6c, local run, not in the ledger | 68 instances | 2.3638 |
| **Total in the ledger** | | | **35.8242** |
| **Total with the items not in the ledger** | | | **38.63** |

Batch names abbreviate the run identifiers in [`artifact/data/spend-ledger.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/spend-ledger.csv). The ledger total excludes the first and last rows. The $0.44 for the earliest reviews is inferred as the study plan's $6.57 pre-main spend minus the smoke test, pilot check and 20-instance recall test in the ledger; it has no batch record of its own. The second recall run ran outside the cloud batches; its cost is the sum of `cost_usd` in [`artifact/data/recall-after-main.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/recall-after-main.csv) ($2.363844). Sources: [`artifact/data/spend-ledger.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/spend-ledger.csv); `provenance.spend_by_batch`, `provenance.main_cost_kept`, `provenance.attempts_not_kept_cost` and `provenance.spend_total_recorded`; [`artifact/data/recall-after-main.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/recall-after-main.csv).

## F Wall Time by Machine Type

**Table S14.** Median wall time per review by machine type.

| Effort | e2-standard-4, *n* | e2-standard-4, median (min) | e2-standard-2, *n* | e2-standard-2, median (min) |
|---|---|---|---|---|
| Low | 12 | 0.44 | 78 | 0.34 |
| Medium | 12 | 0.68 | 78 | 0.63 |
| High | 12 | 1.21 | 78 | 0.80 |

The two machine types ran different patches (Table S3, row 1), so the columns are not a controlled comparison of machines. Source: `wall_by_vm`.

## G Exploratory Replications on Sonnet 5.5 and Haiku 5.5

### G.1 Procedure

The Sonnet 5.5 (`claude-sonnet-5-5`) and Haiku 5.5 (`claude-haiku-5-5`) studies reviewed the 90 main patches at low, medium and high effort with the Opus prompt, images and environment, 540 reviews in all. A free in-container probe first confirmed that each of the six settings sent the requested model and effort. A pilot on 10 patches outside the main draw ([`harness/checks/e-pilot-patches.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/harness/checks/e-pilot-patches.json), 60 reviews) returned 60 well-formed verdicts for $1.06 and is not in the results. A first main attempt failed its preflight check at no cost, because the proxy host name was too long; the fix is the only change from the pilot's harness to `fa7afee`. The main run then ran on November 5, 2026, on five e2-standard-2 machines, one shard each. Within each shard, the six reviews of a patch ran back to back in a shuffled order (`run_name` in [`haiku-vs-opus/artifact/data/reviews.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/haiku-vs-opus/artifact/data/reviews.csv)).

[`artifact/analysis/models.ts`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/analysis/models.ts) runs the Opus analysis (Sections B.1 and B.2) on each model, with the same seed and resample count, and writes [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json); its Opus rows reproduce `results.json`. It reads the corrected labels from [`artifact/data/labels.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/labels.csv) (`--labels`), and writes the original-label rates beside them (`original_labels`). A malformed verdict counts as no acceptance in the primary coding and as acceptance in the sensitivity coding (Table S3, row 16). The Holm family is the three hypotheses of one model.

### G.2 Rates and Agreement

**Table S15.** False success, false alarm, balanced agreement and Youden's *J* by model and effort, under the primary coding and the sensitivity coding of malformed verdicts. Rates carry 95% Wilson intervals; *J* carries a 95% interval built from the Wilson intervals by the method of variance estimates recovery (MOVER).

| Model | Effort | Malformed (wrong, correct) | False success | False alarm | Balanced agreement | *J* [95% CI] | Sensitivity: false success, false alarm, balanced agreement |
|---|---|---|---|---|---|---|---|
| Opus | Low | 0, 0 | 37 (.673) [.541, .782] | 2 (.057) [.016, .186] | .635 | .270 [.101, .408] | Same |
| Opus | Medium | 0, 0 | 26 (.473) [.347, .602] | 2 (.057) [.016, .186] | .735 | .470 [.287, .603] | Same |
| Opus | High | 0, 0 | 25 (.455) [.330, .585] | 2 (.057) [.016, .186] | .744 | .488 [.305, .619] | Same |
| Sonnet | Low | 1, 1 | 36 (.655) [.523, .766] | 2 (.057) [.016, .186] | .644 | .288 [.118, .427] | 37, 1, .649 |
| Sonnet | Medium | 4, 1 | 33 (.600) [.468, .719] | 3 (.086) [.030, .224] | .657 | .314 [.132, .458] | 37, 2, .635 |
| Sonnet | High | 2, 1 | 27 (.491) [.364, .619] | 3 (.086) [.030, .224] | .712 | .423 [.235, .562] | 29, 2, .708 |
| Haiku | Low | 0, 0 | 43 (.782) [.656, .871] | 2 (.057) [.016, .186] | .581 | .161 [.005, .293] | Same |
| Haiku | Medium | 1, 2 | 35 (.636) [.504, .751] | 7 (.200) [.100, .359] | .582 | .164 [−.032, .329] | 36, 5, .601 |
| Haiku | High | 1, 1 | 28 (.509) [.381, .636] | 4 (.114) [.045, .260] | .688 | .377 [.184, .522] | 29, 3, .694 |

Corrected labels: *n* = 55 wrong and 35 correct patches per row. Source: [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json) (`by_model.<model>.malformed`, `rates`, `rates_malformed_as_accept`, `youden`); the original-label rates are in `original_labels`.

All three efforts gave the same verdict on 66 patches for Sonnet and 62 for Haiku, and medium and high disagreed on 10 and 15 wrong patches (`disagreement`). Sonnet stayed within both limits: medium rejected 2 correct patches that high accepted (guardrail 4), and the most false alarms in one setting was 3 (ceiling 6). Haiku breached both: medium rejected 5 correct patches that high accepted, and gave 7 false alarms (`guardrail`, `ceiling`). The limits were set for 30 correct patches and kept unchanged for 35, as for Opus (Section B.2).

### G.3 Hypothesis Tests

**Table S16.** The Opus hypotheses run on each smaller model, with test statistics and the sensitivity coding (exploratory).

| Model | Test | Primary coding | Sensitivity coding |
|---|---|---|---|
| Sonnet | H2: medium − high, Tango 95% CI; Newcombe 95% CI; *p* | .109 (*b* = 8, *c* = 2) [−.004, .234]; [−.005, .217]; .2406 | .145 (*b* = 9, *c* = 1) [.041, .269]; [.033, .251]; .4667 |
| Sonnet | H1: high − low, 95% CI; exact *p*; mid-*p* | −.164 (*b* = 12, *c* = 3) [−.303, −.029]; .0176; .0106 | −.145 (*b* = 11, *c* = 3) [−.282, −.014]; .0287; .0176 |
| Sonnet | H3: ratio [BCa 95% CI]; Wilcoxon *V*, *z*, *p* | .614 [.573, .656]; 1171, −3.525, .0002 | Same |
| Sonnet | Holm | H3 rejected; H1 and H2 not (with mid-*p*, H1 is rejected too) | H3 rejected; H1 and H2 not (also with mid-*p*) |
| Haiku | H2: medium − high, Tango 95% CI; Newcombe 95% CI; *p* | .127 (*b* = 11, *c* = 4) [−.012, .269]; [−.011, .257]; .3704 | .127 (*b* = 10, *c* = 3) [−.001, .262]; [−.002, .249]; .3612 |
| Haiku | H1: high − low, 95% CI; exact *p*; mid-*p* | −.273 (*b* = 16, *c* = 1) [−.408, −.147]; .0001; .0001 | −.255 (*b* = 15, *c* = 1) [−.389, −.132]; .0003; .0001 |
| Haiku | H3: ratio [BCa 95% CI]; Wilcoxon *V*, *z*, *p* | .487 [.447, .531]; 465, −6.365, < .0001 | Same |
| Haiku | Holm | H1 and H3 rejected; H2 not | H1 and H3 rejected; H2 not |

Corrected labels, 55 wrong patches. *b* and *c* count discordant wrong patches as in paper Table 4. H3 uses all 90 patches and is unaffected by the coding of verdicts. Source: [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json) (`hypotheses`, `holm`, `holm_with_mid_p`, `hypotheses_malformed_as_accept`, `holm_malformed_as_accept`).

Without the 32 wrong patches coded as not requiring the failing behavior (`label_question.without_not_required`), 23 wrong patches remain. For Sonnet, the high-minus-low difference is −.130 (95% CI [−.361, .108], exact *p* = .2266), the H2 upper limit is .291 and the cost ratio .611. For Haiku, the difference is −.261 ([−.481, −.024], *p* = .0352), the H2 upper limit .282 and the cost ratio .505. False success by requirement group, low, medium and high: Sonnet required 1, 1, 1 of 6; unclear 8, 8, 8 of 14; not required 24, 22, 18 of 32; no failing test 3, 2, 0 of 3. Haiku required 5, 3, 2; unclear 9, 7, 7; not required 26, 23, 17; no failing test 3, 2, 2 (`label_question.by_group`).

### G.4 Comparison With Opus at Medium

**Table S17.** Each other setting against Opus at medium, on the 55 wrong patches and on Youden's *J* (descriptive, corrected labels). "Turned away" means the review did not accept the wrong patch. The study plan's cross-model goal was non-inferiority on *J* with a 15-point margin, which needs a lower limit above −.15.

| Setting | Turned away by both | By this setting only | By Opus medium only | Two-sided exact *p* | Δ*J* [95% MOVER CI] |
|---|---|---|---|---|---|
| Opus low | 18 | 0 | 11 | .001 | −.200 [−.345, −.047] |
| Opus high | 28 | 2 | 1 | 1 | .018 [−.105, .141] |
| Sonnet low | 16 | 3 | 13 | .0213 | −.182 [−.346, −.008] |
| Sonnet medium | 21 | 1 | 8 | .0391 | −.156 [−.312, −.005] |
| Sonnet high | 23 | 5 | 6 | 1 | −.047 [−.229, .132] |
| Haiku low | 10 | 2 | 19 | .0002 | −.309 [−.492, −.110] |
| Haiku medium | 16 | 4 | 13 | .049 | −.306 [−.508, −.108] |
| Haiku high | 22 | 5 | 7 | .7744 | −.094 [−.285, .094] |

Opus at medium turned away 29 wrong patches, Sonnet at high 28 and Haiku at high 27. Opus at high has the highest *J* (.488) and balanced agreement (.744) of the nine settings, just above Opus at medium. No smaller-model setting meets the non-inferiority goal: the lower limits run from −.508 to −.229. The Δ*J* interval combines paired Newcombe intervals [27] for the wrong and the correct patches by the MOVER method. Source: [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json) (`versus_opus_medium`).

### G.5 Behavior, Cost and Spend

**Table S18.** Medians per review by model and effort, low / medium / high.

| Measure | Sonnet | Haiku |
|---|---|---|
| Output tokens | 1,136.5 / 1,216.5 / 2,063 | 2,198.5 / 3,226 / 7,055 |
| Thinking tokens | 303 / 372.5 / 699 | 756 / 1,268.5 / 4,063 |
| Tool calls | 2.5 / 2 / 4 | 3 / 4 / 7.5 |
| Turns | 4 / 3.5 / 5 | 4 / 5 / 8.5 |
| Shell test runs | 1 / 1 / 1 | 1 / 1 / 1 |
| High above medium in output tokens (share of patches) | .978 | .967 |
| Mean cost (USD) | 0.0232 / 0.0272 / 0.0470 | 0.0023 / 0.0037 / 0.0078 |
| Largest cost (USD) | 0.0509 / 0.0688 / 0.1886 | 0.0065 / 0.0100 / 0.0274 |
| Wall time, median (min) | 0.278 / 0.322 / 0.500 | 0.316 / 0.458 / 0.987 |
| Wall time, longest (min) | 1.057 / 4.932 / 2.783 | 1.121 / 2.270 / 19.669 |
| Total cost, 90 reviews (USD) | 2.0882 / 2.4513 / 4.2299 | 0.2053 / 0.3298 / 0.6980 |

Source: [`artifact/outputs/models.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.2/papers/cr-effort-claude-5.5/artifact/outputs/models.json) (`manipulation`, `cost`). The largest cost and the longest wall time sit far under the $4 and 60-minute caps.

The analyzed reviews, 270 per model, cost $8.7694 for Sonnet and $1.2331 for Haiku, $10.0025 together (`by_model.<model>.total_cost`). The run record gives $10.01 for the main run including the resumed shard's uncounted re-run, $1.06 for the pilot and $0 for the probe and the failed first attempt, so the two studies spent about $11.07 on the model API. Google Cloud compute is not reported, because these runs carry no study label and the billing data cannot isolate them.

## H Shallow Passes

After the run, we counted passes that came with little visible checking, by three signals in the review records: no thinking tokens, at most one tool call, and no shell test run. The count is exploratory and was not preregistered. It uses only the per-review counts in [`haiku-vs-opus/artifact/data/reviews.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/haiku-vs-opus/artifact/data/reviews.csv); [`artifact/analysis/shallow-pass.ts`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/analysis/shallow-pass.ts) also checks that the 270 Opus rows there match the main-run rows of [`artifact/data/results.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/results.csv). The transcripts' stated reasons were not read. Table S19 gives the counts. The totals per signal do not depend on labels. The split by label below uses the corrected labels in [`artifact/data/labels.csv`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/data/labels.csv), joined to `reviews.csv` by instance and agent; [`artifact/outputs/shallow-pass.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/outputs/shallow-pass.json) holds this split in `by_model` and the split by the original labels in `original_labels.by_model`.

**Table S19.** Passes with each shallow signal by model and effort, as total (on correct patches, on wrong patches, by the corrected labels). A pass on a correct patch counts as agreement and a pass on a wrong patch as a false success. Shallow passes cluster at low effort for Opus and at low and medium for Sonnet, and every review without thinking was a pass, so part of the agreement on correct patches at those settings was not earned by a check.

| Model | Effort | All passes | No thinking | At most one tool call | No test run |
|---|---|---|---|---|---|
| Opus | Low | 70 (33, 37) | 18 (12, 6) | 12 (6, 6) | 17 (10, 7) |
| Opus | Medium | 59 (33, 26) | 1 (0, 1) | 0 | 0 |
| Opus | High | 58 (33, 25) | 0 | 0 | 0 |
| Sonnet | Low | 69 (33, 36) | 5 (4, 1) | 21 (12, 9) | 27 (16, 11) |
| Sonnet | Medium | 65 (32, 33) | 4 (3, 1) | 15 (6, 9) | 20 (8, 12) |
| Sonnet | High | 59 (32, 27) | 0 | 1 (0, 1) | 3 (2, 1) |
| Haiku | Low | 76 (33, 43) | 0 | 1 (1, 0) | 6 (4, 2) |
| Haiku | Medium | 63 (28, 35) | 0 | 0 | 1 (1, 0) |
| Haiku | High | 59 (31, 28) | 0 | 0 | 1 (0, 1) |

*n* = 90 reviews per row (35 correct, 55 wrong patches by the corrected labels). No review without thinking returned a fail or a malformed verdict. Reviews with at most one tool call returned one fail each for Sonnet at low and at medium, and none elsewhere. Reviews without a test run that did not pass: Opus 6, 3 and 1 at low, medium and high; Sonnet 7, 8 and 4 (one of Sonnet's low reviews was malformed); Haiku 3, 1 and 0. Source: [`artifact/outputs/shallow-pass.json`](https://github.com/trustmybot/research-artifacts/blob/cr-effort-claude-5.5-v1.0/papers/cr-effort-claude-5.5/artifact/outputs/shallow-pass.json) (`by_model.<model>.<effort>`).

## I Findings Coding (RQ6, Exploratory)

RQ6 was added after every result in the main paper was known, so it is exploratory for all three models. The codebook ([`findings/codebook.md`](findings/codebook.md)) holds every rule and [`findings/prompts/`](findings/prompts/) every prompt. Every number in this section comes from [`findings.json`](findings/artifact/outputs/findings.json); its keys are given with each table.

### I.1 Units and Passes

**Table S20.** *Units Coded.*

| Unit | n | Coded in |
|---|---|---|
| Wrong patches with reference behaviors | 55: 50 shown wrong by a failing strengthened test, 5 by reading the patch against the official fix (rule L7) | Reference drafting and check |
| Rejecting reviews, all patches (fail or malformed verdict) | 232: 217 fail, 15 malformed | Pass T, finding type |
| Rejections of the 55 wrong patches | 205: 196 fail, 9 malformed | Pass M, match |
| Rejections of correct patches (false alarms) | 27: 21 fail, 6 malformed | Pass C, claim |
| Decoys, drawn from the 205 and matched to the false alarms' model and effort counts | 27 | Pass C, claim |
| Accepted reviews of the 55 wrong patches | 290 | Pass A, accepted |

What each pass asks and shows:
- **Pass T** asks what kind of defect each finding claims, in the types of Mäntylä and Lassenius [24], and whether the review shows a reproduction. It shows neither the label nor the reference behaviors, and it ran first.
- **Pass M** scores each pair of a finding and a reference behavior, and of the feedback and each reference behavior: 2, the same underlying issue, adapted from ReviewBench [42] (the minimal fix for the finding would also remove the behavior); 1, partial; 0, other. A script derives the review-level code: named if some pair scores 2; partial if none scores 2 and some scores 1; otherwise other.
- **Pass C** codes the reality of each false alarm's main claim against the official fix: real within the issue, real but shared by the official fix, real but outside the issue, not real, or unverifiable. Unless the claim is real within the issue, it adds yes-or-no reason codes: misidentified issue, redundant and beyond the objective [23]; demands more than the issue asks [20]; and the reviewer's own environment failed. The false alarms are pooled and shuffled with the decoys, and the official fix is shown.
- **Pass A** codes the concern in the feedback of each accepted review: a specific functional concern (C2), vague hedging (C1) or none (C0). It also scores the feedback against each reference behavior on the pass M scale.

**Coders.** Coder A is Claude Opus 5.5 and coder B is Claude Sonnet 5.5, both at high effort. Each coded every item independently, in a fresh context per batch, from the same shuffled batches: 15 reviews per batch in passes T, M and A, and 9 in pass C. No packet showed the reviewer's model or effort, the run name or the review identifiers; items carried random codes.

**Adjudicator.** Claude Opus 5.5 at medium effort, in a fresh context. It saw the two codes as X and Y, in a random order per item, without coder or model names, and picked one of them, or a third code only when it cited the codebook rule that rules out both. It settled: class, type and subtype together, quality flag, multi-claim and reproduction (T); the pair scores of the deciding findings and the review-level code (M); reality and each reason code (C); concern and each feedback score (A).

### I.2 Reference Behaviors

Each reference behavior states one defect that makes a wrong patch wrong, in three parts: the trigger, what the official fix does, and what the patch does. For the 50 test-based patches, Claude Opus 5.5 at high effort drafted each behavior from the issue, the official fix, the strengthened test diff, the failing tests and traceback excerpts. For the 5 reading-based patches, it drafted from the patch, the official fix and the issue, plus the failing strengthened test for the two patches that have one; the trigger is a concrete input traced through both diffs. Claude Sonnet 5.5 at high effort checked every draft and returned accept, revise or reject. The drafter could rebut once and the checker then hold or concede; held disputes went to the adjudicator, and the patch was flagged contested.

**Table S21.** *Outcome of the Reference-Behavior Check.*

| Outcome | Behaviors | Patches |
|---|---|---|
| Changed after the check | 2 | 2 |
| Dropped | 1 | 1 |
| Contested and adjudicated | 1 | 1 |

Source: `gold_check`. The contested behavior rests on a strengthened test that the checker judged overfitted to an internal function signature of the official fix; the sensitivity analysis (Section I.8) drops that patch.

### I.3 Agreement Before Adjudication

**Table S22.** *Agreement Between Coder A and Coder B, Before Adjudication.* Bootstrap 95% intervals use 2,000 resamples of reviews (seed 20261118), so findings stay clustered within their review.

| Pass | Code | n | Percent [95% CI] | Cohen's κ [95% CI] | Gwet's AC1 [95% CI] |
|---|---|---|---|---|---|
| T | Class, type and subtype | 290 findings in 230 reviews | .786 [.732, .836] | .760 [.699, .815] | .776 [.717, .828] |
| T | Quality flag | 290 findings | .993 [.982, 1] | .872 [.594, 1] | .993 [.982, 1] |
| T | Multi-claim | 290 findings | .986 [.971, .997] | .771 [.456, .955] | .985 [.969, .996] |
| T | Reproduction | 232 reviews | .996 [.987, 1] | .968 [.883, 1] | .995 [.986, 1] |
| M | Review level, three values | 203 reviews | .887 [.842, .931] | .746 [.653, .828] | .867 [.810, .918] |
| M | Review level, named or not | 203 reviews | .956 [.926, .980] | .891 [.814, .953] | .925 [.873, .969] |
| M | Feedback named | 203 reviews | .877 [.828, .921] | .726 [.631, .817] | .855 [.796, .908] |
| C | Reality | 54 reviews | .926 [.852, .981] | .883 [.769, .972] | .912 [.823, .978] |
| C | Misidentified issue | 54 | .963 [.907, 1] | −.019 [−.047, 1] | .962 [.898, 1] |
| C | Redundant | 54 | 1 | 1 | 1 |
| C | Beyond the objective | 54 | .648 [.519, .778] | .205 [.013, .419] | .421 [.153, .660] |
| C | Demands more than the issue | 54 | .852 [.759, .944] | .575 [.289, .809] | .774 [.592, .919] |
| C | Environment failure | 54 | 1 | 1 | 1 |
| A | Concern | 289 reviews | .869 [.827, .907] | .773 [.708, .835] | .815 [.755, .870] |
| A | Feedback score | 297 pairs in 289 reviews | .848 [.807, .888] | .763 [.701, .824] | .778 [.715, .837] |

Source: `agreement.codes`. Pass M has 203 of 205 reviews and pass A 289 of 290 because three items lacked one coder's code (Section I.5); three findings could not be aligned between coders (`agreement.T_unaligned`). κ is low where one value is rare: for the misidentified-issue code it is near zero while percent agreement is .963, the case AC1 is meant to handle. The beyond-the-objective code agreed least on every measure.

**Per-type agreement (pass T).** κ by M&L type, with the findings coded with that type by coders A and B: logic .84 [.77, .90] (128, 133); interface .96 [.90, 1] (45, 42); check .84 [.73, .93] (41, 40); resource .80 [.64, .91] (26, 28); larger defects .68 [.43, .85] (21, 16); process note .59 (3, 7); test request .79 (16, 14). Types used one to six times by both coders agreed fully. Source: `agreement.T_per_type`, which holds every interval.

### I.4 Adjudication

**Table S23.** *Items Sent to the Adjudicator and Its Choices.*

| Pass | Items adjudicated | Chose coder A's code | Chose coder B's code | Third code |
|---|---|---|---|---|
| T | 69 | 38 | 30 | 1 |
| M | 31 | 18 | 13 | 0 |
| C | 33 | 14 | 19 | 0 |
| A | 83 | 59 | 23 | 1 |
| Total | 216 | 129 | 85 | 2 |

Source: `adjudication`. The adjudicator never learned which coder was which.

### I.5 Settling Rules Beyond the Codebook

These rules were set after coding (Table S26, rows 7 to 9) and are reported in full.
- **One coder only.** Three items lacked one coder's code: one item in match batch M-04 (coder B), one in match batch M-09 (coder A) and one in accepted batch A-10 (coder A). They were not rerun, and the other coder's code stands: 2 items, 2 pair scores and 2 feedback scores in pass M, and 1 item in pass A. In pass T, 3 findings coded by one coder only also stand (`one_coder`).
- **Lower score where the codebook sends nothing to adjudication.** The codebook sends only the pair scores of the deciding findings to the adjudicator. For other pair-score disagreements, the lower score stands, following the codebook's tie rule: 10 pair scores on findings that do not decide the review level, and 24 feedback scores in pass M (`lower_unadjudicated`). In all 10 pair cases both coders' highest score was the same, so no review-level code changed; the feedback scores feed only the feedback-named statistic.
- **Review level.** The 23 review-level disagreements in pass M were not adjudicated directly; each level was derived again from the settled pair scores.

### I.6 Blinding Check

In pass T each coder guessed which of the three models wrote each review, or answered unsure. Coder A guessed right on 69 of 232 reviews and answered unsure on 52, an accuracy of .297, 95% CI [.242, .359], against a chance rate of .333. Coder B answered unsure on all 232 (accuracy 0, 95% CI [0, .016]). The blinding held for coder A, and coder B gave no information. Source: `blinding_guess`.

### I.7 Per-Setting Detail

**Table S24.** *Outcome of Each Wrong Patch, Concern Codes and False Alarms by Setting.* Each row covers the 55 wrong patches; the five outcomes sum to 55.

| Model | Effort | Rejected, named | Rejected, partial | Rejected, other | Accepted, feedback named | Accepted, not named | Concern C2 / C1 / C0 | False alarms |
|---|---|---|---|---|---|---|---|---|
| Opus | Low | 12 | 2 | 4 | 11 | 26 | 22 / 3 / 12 | 2 |
| Opus | Medium | 21 | 3 | 5 | 12 | 14 | 16 / 1 / 9 | 2 |
| Opus | High | 22 | 3 | 5 | 14 | 11 | 16 / 2 / 7 | 2 |
| Sonnet | Low | 13 | 3 | 3 | 12 | 24 | 19 / 2 / 15 | 2 |
| Sonnet | Medium | 18 | 3 | 1 | 9 | 24 | 15 / 4 / 14 | 3 |
| Sonnet | High | 22 | 2 | 4 | 12 | 15 | 18 / 2 / 7 | 3 |
| Haiku | Low | 9 | 1 | 2 | 12 | 31 | 19 / 4 / 20 | 2 |
| Haiku | Medium | 12 | 1 | 7 | 13 | 22 | 20 / 2 / 13 | 7 |
| Haiku | High | 17 | 5 | 5 | 16 | 12 | 18 / 1 / 9 | 4 |

Sources: `by_model.<model>.<effort>.patch_outcomes`, `accepted.concern` and `false_alarms.by_cell`. Pooled, the concern codes are C2 163, C1 21 and C0 106. The median number of findings per rejection was 1 in every setting, and the mean ranged from 1.07 to 1.58 (`findings_per_rejection`).

Other pooled details:
- **False alarms by label rule:** behaves like the official fix (L5) 16; shares its defect (L6) 9; implementation-detail test (L4) 2 (`false_alarms.by_rule`).
- **Reproduction:** shown 216, partly shown 11, not shown 5, of 232.
- **Most frequent subtypes,** of 293 findings: other logic 55, comparison logic 52, variable check 35, parameter interface 26 and data resource 23. Every subtype count per setting is in `finding_types`.

### I.8 Sensitivity

**Table S25.** *Named Rejections Under Alternative Rules, as k of Patches (Share), at Low / Medium / High.* The main result is in Table 7.

| Model | Partial counts as named (55) | Contested patch dropped (54) | Malformed rejections dropped (55) | Reading-based patches dropped (50) |
|---|---|---|---|---|
| Opus | 14 (.25) / 24 (.44) / 25 (.45) | 12 (.22) / 21 (.39) / 22 (.41) | 12 (.22) / 21 (.38) / 22 (.40), unchanged | 12 (.24) / 20 (.40) / 19 (.38) |
| Sonnet | 16 (.29) / 21 (.38) / 24 (.44) | 13 (.24) / 18 (.33) / 22 (.41) | 13 (.24) / 16 (.29) / 21 (.38) | 13 (.26) / 17 (.34) / 20 (.40) |
| Haiku | 10 (.18) / 13 (.24) / 22 (.40) | 9 (.17) / 12 (.22) / 17 (.31) | 9 (.16) / 12 (.22) / 16 (.29) | 8 (.16) / 11 (.22) / 16 (.32) |

Source: `sensitivity.<variant>.<model>.<effort>`, which also gives the Wilson interval and the share of rejections for every cell. The contested patch was not a named rejection in any setting, so dropping it changes only the denominator, and no share by more than .01. Dropping the reading-based patches moves no share by more than .02, but Opus then falls from 20 to 19 between medium and high instead of rising.

### I.9 Deviations From the RQ6 Plan

**Table S26.** *Deviations From the RQ6 Coding Plan.*

| # | What the plan said | What happened | Why it matters |
|---|---|---|---|
| 1 | The paper's research questions are RQ1 to RQ5. | RQ6 was added after every other result was known. | RQ6 is exploratory for every model. |
| 2 | Exclude the five patches shown wrong by reading (rule L7). | All 55 patches were coded, the five with reading-based reference behaviors. | A sensitivity line drops them (Table S25). |
| 3 | Decoys come from the rejections of the earlier patch set (183). | They came from the 205 rejections of the 55 wrong patches. | None on the counts; the decoy pool matches the coded set. |
| 4 | The bootstrap uses 10,000 resamples. | It used 2,000. | Interval bounds carry slightly more Monte Carlo error. |
| 5 | Coders code "without tools". | The coding agents read each prompt and wrote each reply with file tools; tool use was audited only for the reference-behavior runs, whose drafting agents ran a character count. | Coders could in principle have read other files; we did not detect this, but the audit does not cover the coding passes. |
| 6 | Reference behaviors are settled before any coder sees a review. | Passes T and C started before they were settled. | Neither pass shows reference behaviors, so neither could use them. |
| 7 | A batch missing a coder's reply is rerun once. | Three items were not rerun. A lenient decoder read the replies, and a stray item prefix was stripped. | 2 items in pass M and 1 in pass A rest on one coder (Section I.5). |
| 8 | Disputed review levels go to the adjudicator. | The 23 review-level disputes were not sent; each level was derived again from the settled pair scores. | The level follows the codebook's derivation rule. |
| 9 | Not covered by the plan. | Disagreements that the codebook does not send to adjudication took the lower score (10 pair and 24 feedback scores). | No review-level code changed (Section I.5). |
| 10 | Release per-item coded tables, reference behaviors, false-alarm codes and coder run records, and analyze location, crosswalk, issue-requirement, label-rule and memory-flag cross-tabulations. | Partly done: the 57 reference behaviors of the 55 wrong patches and the reviewer findings are released with patch code elided, and the adjudication log and the blinding key, which quote no patch code, are released as well; the settled codes, false-alarm codes, coder run records and the cross-tabulations are deferred, not computed or released. | The aggregates cannot yet be recomputed from public data. |
| 11 | The adjudicator sees the reference behaviors in passes M and A. | A rendering bug left them out. All 239 adjudicator prompts were rendered again, and 7 pilot decisions were rerun. | Every reported decision comes from the corrected prompts. |
| 12 | Each check run writes its reply. | One checking agent wrote nothing on its first try and was rerun. | None. |
| 13 | Pass C coders cannot tell false alarms from decoys. | The codebook they saw describes the decoy design; only a hint about the expected result for decoys was removed. | Coders knew that decoys existed, though not which items they were. |
| 14 | The adjudicator defaults to Haiku 5.5. | Claude Opus 5.5 at medium effort was chosen before any adjudication. | A stronger adjudicator of the family under test (paper Section 6). |

**Orchestration.** The coders ran as Claude Code agents, one fresh agent per batch; each read its rendered prompt from a file and wrote its reply to a file (row 5).

### I.10 No Human Validation

No author or other person checked the reference behaviors, the codes or the adjudications. Agreement between coder A and coder B (Table S22) measures how consistent two models of the family under test are, not how accurate they are. Every RQ6 number is a model-coded estimate.

### I.11 Materials

The findings directory holds the codebook ([`findings/codebook.md`](findings/codebook.md)); the prompts for drafting and checking the reference behaviors, the four passes and the adjudicator ([`findings/prompts/`](findings/prompts/)); the analysis and settling code ([`findings/artifact/analysis/`](findings/artifact/analysis/)); the aggregate output ([`findings.json`](findings/artifact/outputs/findings.json)); Figure 7 ([`fig7-right-reason.svg`](findings/artifact/figures/fig7-right-reason.svg)); and a README describing each key ([`findings/artifact/README.md`](findings/artifact/README.md)). The settled reference behaviors, 57 across the 55 wrong patches, are in [`gold-behaviours.json`](findings/artifact/data/gold-behaviours.json), with each patch's contested, dropped and changed behaviors and with any run of 40 or more characters copied from the patch replaced by `[patch code elided]`. Every reviewer finding of the main reviews is released with the same elision ([`findings.csv`](findings/artifact/data/findings.csv)). Also released, with no patch code in them, are every code the adjudicator decided, with both coders' codes, the final code and the codebook rule cited ([`adjudication-log.csv`](findings/artifact/data/adjudication-log.csv)), and the key from each blinded item code to its model, effort and patch ([`blind-key.json`](findings/artifact/data/blind-key.json)). The settled per-item codes, the coder agreement records and the coder runs are kept private (Table S26, row 10).
