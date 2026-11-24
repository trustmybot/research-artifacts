# How Haiku 5.5 at High Effort Compares With Opus 5.5 at Medium Effort

Exploratory, post hoc analysis for the Sonnet and Haiku effort studies (`cr-effort-claude-sonnet-5.5`, `cr-effort-claude-haiku-5.5`). None of it was pre-registered, no OSF filing came before data collection, and every test below is descriptive. It uses no new model runs: only the 810 existing main-run reviews (Opus 5.5 rows from `cr-effort-claude-opus-5.5`).

## Summary

Haiku 5.5 at high effort shares many of its catches with Opus 5.5 at medium effort, but the data do not show the two to be close. Haiku high catches 26 of the 55 wrong patches against Opus medium's 29, a paired difference of −5.5 pp [−18.2, 5.5], and the paper's comparison on Youden's *J* gives a difference of −.094, 95% CI [−.285, .094] (supplement Table S17), whose lower limit lies far below the −.15 margin the study plan set for calling a smaller model non-inferior. The overlap that does exist has three sources. First, which patch is under review explains most of the variance in catches (η² = .56). The model and effort cell explains η² = .05, so every reviewer catches roughly the same reproducible defects and misses the same 17. Second, both reviewers settle almost every catch by running code, and about two thirds of those catches rest on the reviewer's own reproduction script, not on a failing existing test. Haiku high does more of this work than Opus medium: it takes about three more turns, runs two more scripts of its own and writes about three times as many output tokens. Third, the two disagree on 11 patches. Of the 10 of those read in full, 7 are cases where both saw the defect and differed only on whether it should block. The data cannot show that the two are equivalent, or that execution causes the catches. The planned repeat study, `cr-effort-claude-haiku-5.5-equiv`, settles the first question for about $18. An optional arm with the reviewer's shell tool (Bash) turned off would test the second for under $1.

## Questions and Candidate Explanations

The question: Haiku 5.5 at high effort (26 of 55 wrong patches caught, 3 of 35 false alarms) costs about 8% as much per review as Opus 5.5 at medium effort (29 of 55, 2 of 35; $0.008 against $0.095). Where do the two agree, why, and is the gap between them small enough to call them close? The analysis tests five candidate explanations for the overlap.

1. **Patch difficulty dominates.** Most of the variance comes from the patches, so any reasonably capable reviewer catches the same easy ones.
2. **Delegation to execution.** Both reviewers hand the decision to running code, so model strength matters less once a failure is visible.
3. **Haiku does less work but gets lucky.** Under this explanation the overlap is chance agreement on a small sample.
4. **Catches come from the existing test suite.** Under this explanation a reviewer only needs to run `runtests.py` and report what fails.
5. **The disagreements are detection gaps.** Under this explanation, where the two differ, one of them did not see the defect.

## Method

### Data

- **Opus 5.5 rows:** `papers/cr-effort-claude-5.5/artifact/data/results.csv`, main rows only (270 reviews), with each run's transcript and `run.json` from the study's run archive.
- **Sonnet 5.5 and Haiku 5.5 rows:** the 540 main-run reviews in a private archive held by the authors, available on request (branches `c4-c-smoke/<run id>`, harness commit `fa7afee`). For shard 4, the 6 runs completed in the original shard are primary, including run 29 (Haiku high, malformed). The remaining shard-4 runs come from the resume. This follows the scoring rule of the Sonnet and Haiku run record.
- **Issue coding:** `papers/cr-effort-claude-5.5/artifact/data/issue-requires-coding.csv`, a post hoc coding of whether the issue text asks for the behaviour that the failing SWE-ABS test checks (required, unclear or not required).

A **catch** is a fail verdict on one of the 55 wrong patches under the corrected labels (the `label` column of `papers/cr-effort-claude-5.5/artifact/data/labels.csv`, passed as `--labels`). A malformed verdict counts as a miss; the paper counts it as turning the patch away, so for Haiku high it reports 27 wrong patches turned away rather than 26 caught, and 4 false alarms rather than 3 (one malformed review on each side). Under the original SWE-ABS labels (60 wrong, 30 correct) the per-cell counts reproduce the table on the Sonnet and Haiku run record exactly; the corrected labels move 8 patches from wrong to correct and 3 from correct to wrong.

### Measures

- **Agreement:** exact McNemar test on discordant patches, the paired difference in catch rate with a Wilson-score style interval for paired proportions, and Cohen's κ. The κ intervals use a percentile bootstrap over patches (10,000 resamples, mulberry32 seed 20261107).
- **Variance decomposition:** two-way ANOVA without interaction on the 55 × 9 binary catch matrix (patch × cell), reporting η² per factor and the intraclass correlation (ICC) for patch. The response is binary, so the F tests are approximate. η² is the useful quantity here.
- **Work:** turns, tool calls, output and thinking tokens, and wall time from `run.json`. Counts per review come from the transcript's Bash calls, using the same command patterns as `harness/transcript.ts`: test-suite runs, runs of the reviewer's own code (inline Python, here-documents or scripts), and differential runs (the same probe against the parent commit, a stash or a base copy). Haiku high and Opus medium are compared on all 90 patches with paired Wilcoxon signed-rank tests, reporting the median paired difference with a bootstrap 95% CI and the rank-biserial correlation *r*.
- **Evidence coding:** every catch by Haiku high (25) and Opus medium (27) under the original labels was shuffled, stripped of model labels and coded by one coder into one of three classes. **Suite:** an existing Django test fails on the patch. **Own reproduction:** a script or test the reviewer wrote shows the defect, usually compared against the parent commit. **Reading only:** no execution behind the deciding finding. The 10 discordant patches under the original labels were then read on both sides to judge whether the reviewer that passed the patch had seen the defect. The coding was done before the label correction and was not redone: the corrected labels add 1 Haiku-high catch and 2 Opus-medium catches, all on the 3 patches that moved from correct to wrong. One of those 3 is a new discordant patch, which was not read.

An automated "saw a failure" measure from tool output was tried and dropped. It matched environment errors and failures already present on the parent commit, and it fired on 87% of Haiku-high reviews of correct patches. Execution is therefore reported only as behaviour (what was run). Evidence comes from the manual coding.

The analysis scripts are in `artifact/analysis/` and the derived data in `artifact/data/`; `artifact/README.md` gives the run commands. From `artifact/`, `node analysis/analyze.ts --reviews data/reviews.csv --labels ../../artifact/data/labels.csv --requires ../../artifact/data/issue-requires-coding.csv --codes data/manual-codes.json --key data/blind-key.json --out <results.json>` reproduces every number in this note from the committed data. Rebuilding the data needs the private transcripts: `node analysis/extract-vault.ts <vault repo> <vault dir>` extracts the Sonnet and Haiku runs, `node analysis/features.ts --opus ../../artifact/data/results.csv --gcs <opus runs dir> --vault <vault dir> --out data/reviews.csv --texts <review-texts.json>` writes the per-review table, and `node analysis/blind.ts <review-texts.json> data/blind-key.json <blind-catches.md>` writes the shuffled catches for evidence coding. No transcript text appears in this note.

## Results

### Haiku High Against Opus Medium, Patch by Patch

| Comparison | Both catch | Only first | Only second | Exact McNemar *p* | Difference in catch rate, pp [95% CI] | κ [95% CI] |
|---|---|---|---|---|---|---|
| Haiku high vs Opus medium | 22 | 4 | 7 | .549 | −5.5 [−18.2, 5.5] | .60 [.38, .78] |
| Opus medium vs Opus high | 28 | 1 | 2 | 1.000 | −1.8 [−7.3, 3.6] | .89 [.75, 1.00] |
| Haiku low vs Haiku high | 11 | 1 | 15 | .001 | −25.5 [−38.2, −12.7] | .40 [.19, .61] |

Opus medium and Opus high differ on 3 of the 55 wrong patches: 1 caught only at medium and 2 only at high.

- Haiku high against Opus high gives κ = .64, tied for fifth-highest of the 36 pairs of cells. Haiku medium against Haiku high gives κ = .52.
- Haiku high agrees with Opus more closely than Haiku medium agrees with Haiku high.
- For scale, `cr-effort-claude-opus-5.5`'s supplement reports 0 of 20 Opus-high verdicts flipping on a repeat run. Whether Haiku high is equally stable is unmeasured.

### Patch Difficulty Dominates

On the 55 × 9 catch matrix:

- Patch explains η² = .56, *F*(54, 432) = 11.51.
- The model and effort cell explains η² = .05, *F*(8, 432) = 6.40.
- The residual is η² = .39.
- The ICC for patch is .54.

| Cells catching the patch (of 9) | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| Patches | 17 | 4 | 6 | 2 | 5 | 3 | 4 | 3 | 5 | 6 |

The patches split into a group nobody catches (17) and a group most cells catch. Only 38 of the 55 wrong patches are caught by any cell.

The uncaught group is mostly patches whose failing test checks behaviour the issue does not ask for:

| Issue asks for the tested behaviour | Patches | Caught by no cell | Haiku high | Opus medium |
|---|---|---|---|---|
| Required | 6 | 0 | 4 | 5 |
| Unclear | 14 | 5 | 6 | 7 |
| Not required | 32 | 12 | 15 | 15 |
| No failing test | 3 | 0 | 1 | 2 |

The last row holds the 3 patches the label correction moved from correct to wrong. Every test passes on them and the defect is a concrete input no test checks, so there is no failing test whose behaviour the issue could ask for.

### What the Catches Rest On

Single coder, blind to model labels (writing style may still reveal the model). Wilson 95% CIs. The coded catches are those under the original labels (see Method).

| Evidence behind the catch | Haiku high (*n* = 25) | Opus medium (*n* = 27) |
|---|---|---|
| Existing test fails | 8, 32% [17, 52] | 8, 30% [16, 49] |
| Reviewer's own reproduction | 17, 68% [48, 83] | 18, 67% [48, 81] |
| Code reading only | 0, 0% [0, 13] | 1, 4% [1, 18] |
| Any execution | 25, 100% [87, 100] | 26, 96% [82, 99] |

- On the 21 patches both caught, the evidence class matches in 19 (90% [71, 97]).
- This corrects a line on the Sonnet and Haiku run record, "most catches are failures the tests expose". Both reviewers run the test suite in almost every review. About two thirds of catches, however, come from a probe the reviewer wrote itself, not from a failing existing test.

### How Much Work Each Does

Haiku high against Opus medium, all 90 patches, paired:

| Measure (median per review) | Haiku high | Opus medium | Paired difference [95% CI] | Rank-biserial *r* |
|---|---|---|---|---|
| Turns | 8.5 | 5 | 3 [3, 4] | .96 |
| Tool calls | 7.5 | 4 | 3 [3, 4] | .96 |
| Runs of own code | 2 | 0 | 2 [1, 2] | 1.00 |
| Differential runs | 2 | 0 | 1 [1, 2] | .89 |
| Test-suite runs | 1 | 2 | — | −.01 (*p* = .94) |
| Output tokens | 7,055 | 2,244 | 4,775 [3,761, 6,705] | 1.00 |
| Thinking tokens | 4,063 | 598 | 3,276 [2,584, 4,372] | 1.00 |
| Wall time (s) | 59 | 39 | 11.6 [9.4, 17.9] | .50 |

Mean cost per review over all 90 patches is $0.0078 for Haiku high and $0.0946 for Opus medium.

Share of all 90 reviews per cell that ran the reviewer's own code, which tracks catches within each model:

| Model | Low | Medium | High |
|---|---|---|---|
| Haiku 5.5: own code / catches | 49% / 12 | 64% / 19 | 83% / 26 |
| Opus 5.5: own code / catches | 12% / 18 | 29% / 29 | 31% / 30 |
| Sonnet 5.5: own code / catches | 22% / 18 | 21% / 18 | 39% / 26 |

These shares come from command patterns and undercount Opus. Opus more often folds a probe into a single compound command, or writes a test into `tests/` and runs it through `runtests.py`, which counts as a suite run. The manual coding above, which found equal shares of own-reproduction catches, is the better measure of evidence.

### Where They Disagree

The two disagree on 11 patches. Both reviews of each of the 10 patches discordant under the original labels were read in full; the eleventh, added by the label correction, was not.

| Patch (SWE-bench instance, submitting agent) | Caught by | The other reviewer | Issue asks for tested behaviour |
|---|---|---|---|
| django__django-13964 (SAGE OpenHands) | Opus medium | saw the defect, judged it non-blocking | not required |
| django__django-14376 (claude-4-opus tools) | Opus medium | saw the defect, judged it non-blocking | not required |
| django__django-15128 (trae doubao) | Opus medium | saw the defect, judged it non-blocking | unclear |
| django__django-15278 (Prometheus gpt5) | Opus medium | saw the defect, judged it non-blocking | required |
| django__django-13315 (Prometheus gpt5) | Opus medium | ran the case, judged the behaviour unchanged | not required |
| django__django-11848 (Refact Agent) | Opus medium | did not find the defect | required |
| django__django-11265 (claude-4-opus tools) | Haiku high | saw the defect, judged it non-blocking | required |
| django__django-16560 (trae doubao) | Haiku high | saw the defect, judged it non-blocking | not required |
| django__django-14999 (bloop) | Haiku high | did not find the defect | not required |
| django__django-15930 (Prometheus gpt5) | Haiku high | did not find the defect | not required |
| django__django-15280 (SAGE bash_only) | Opus medium | not read | no failing test |

- In 7 of the 10 disagreements read, both reviewers saw the defect and differed only on whether it should block. Four of those 7 involve behaviour the issue does not ask for, where blocking is a judgement call.
- Only 3 of the 10 read are differences in detection: 1 that Haiku high missed and 2 that Opus medium missed.

## What the Data Supports, Rules Out and Cannot Settle

**Supported (exploratory):**

- **Patch difficulty dominates.** Patch explains about 12 times the variance that model and effort explain, and Haiku high and Opus medium catch largely the same set.
- **Both delegate to execution.** At least 96% of the coded catches in both cells rest on code the reviewer ran, and the evidence class matches on 19 of the 21 shared catches.
- **Haiku buys its recall with effort.** Within Haiku, the share of reviews running own code and the number of catches rise together from low to high (12 → 26 catches). Haiku high runs more probes and thinks about seven times as long as Opus medium. At Haiku's price per token, this extra work still costs about a twelfth as much.
- **The remaining gap is mostly about the blocking threshold, not detection.** Seven of the 10 disagreements read fit this pattern.

**Ruled out:**

- **"Catches are mainly existing-suite failures."** About 30% are; the rest rest on reviewer-written reproductions.
- **"Haiku does less work."** It does more on every work measure (*r* ≥ .89, except test-suite runs, which are equal).
- **"The disagreements are mostly detection gaps."** Only 3 of the 10 read are.

**Cannot settle:**

- **Equivalence.** A difference of −5.5 pp [−18.2, 5.5] from one run per cell with 11 discordant patches does not exclude a gap of 10 pp or more in Opus medium's favour. Run-to-run noise on Haiku high is unmeasured. If it is as large as the Haiku high vs Opus medium discordance, the 11 splits are noise.
- **Causation.** The link between execution and catches is correlational: harder-working reviews may also be the ones on reproducible patches. Only an intervention on tool access settles whether execution produces the catches.
- **Label validity.** Even after the rule-based label correction, 32 of the 55 wrong labels rest on tests of behaviour that the issue does not ask for, and 12 of those are caught by no cell. The shared ceiling may partly be a property of the SWE-ABS labels, not of the reviewers.
- **Generality.** One benchmark slice (Django), one prompt and one coder for the evidence classes.

## Cheapest Study That Would Settle It

These are proposals only; nothing has been run. Both need an OSF filing and the Human's cost approval first.

1. **`cr-effort-claude-haiku-5.5-equiv` (already proposed).** Two more runs each of Haiku high and Opus medium on the 90 main patches, 360 reviews. At the observed means this costs $0.0078 × 180 + $0.0946 × 180 ≈ $1.40 + $17.03 ≈ **$18.4** in API spend, plus GCP time.
   - It measures run-to-run noise on both sides and allows a paired TOST (two one-sided tests, an equivalence test) with a pre-registered margin.
   - Power note from this data: with one run, the SE of the paired difference is about 6.0 pp (discordance rate 11/55). Eighty-percent power for a ±10 pp margin at α = .05 needs an SE of about 4.0 pp. That requires either about 125 wrong patches at the current discordance, or repeats that cut the per-patch discordance variance by about 56%.
   - Extending the wrong patches from 55 to 75, as the proposal allows, is therefore advisable. At the same rates it adds about $4.
2. **Optional causal arm: Haiku high with Bash disabled**, one run on the 90 main patches. Reviews without tool execution should cost no more than the $0.0078 mean, so **under $1**.
   - If catches fall toward the code-reading-only rate (0 of 25 coded catches here), execution is the mechanism behind Haiku's catches.
   - Opus medium with Bash disabled would cost about $8 and tests whether the stronger model degrades less without execution. It is worth adding only if the Haiku arm shows a large drop.
   - This revives part of the dropped `cr-notests` question at Haiku prices.

## Threats to Validity

- **Post hoc and exploratory.** The questions were posed after the results were known, and no correction for multiple comparisons is applied.
- **Single coder.** The evidence classes and the "saw the defect" judgements come from one coder. Model labels were stripped, but writing style (Haiku writes longer reviews) may reveal the model. A second coder on the 52 catches and 10 discordant pairs would give an inter-rater κ at no API cost.
- **Pattern-based work counts** undercount Opus's own-code runs (see above). The paired direction holds on turns, tool calls and tokens, which are exact.
- **Binary ANOVA.** η² on a 0/1 response is descriptive; a mixed logistic model would be the confirmatory form.
- **Selection of the comparison.** Haiku high vs Opus medium was singled out because it looked close on the original labels. A pair chosen because it looks close tends to show a larger gap on repeat runs (regression to the mean), and on the corrected labels the gap on Youden's *J* is already −.094 [−.285, .094].
