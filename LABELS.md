# Patch labels and review outcomes

Every cr study that judges a code reviewer against SWE-bench patches labels each patch and scores each review with the rules below. A new study uses them as they are; a study that needs a change proposes it on its issue and logs it as a deviation.

## Ground truth

The official fix (the gold patch) is the ground truth, and it is the minimum bar:

- **Wrong:** the patch fails something the gold patch gets right.
- **Correct:** the patch does at least what the gold patch does: the same, the same with a flaw the gold patch shares, or better.

Behaving differently from the gold patch is not enough to be wrong. A test that pins one of the gold patch's quirks does not make a patch wrong. A gold behavior that the project later reversed upstream is still the bar: a reviewer can judge only against the code as it stands, not a future fix, and a later reversal can come from changes the reviewer could not see, such as new dependencies, Python versions or use cases. Overlay O5 marks such reviews.

Only the gold patch is the bar: whether the unchanged base also fails a test does not matter, inside or beyond the issue.

The tests are the SWE-ABS strengthened tests (OpenAgentEval/SWE-ABS), run on the candidate and on the gold patch. Stricter tests that catch real bugs beyond the issue are welcome: a patch that fails one stays wrong.

## Label rules

Apply the first group that fits. Any L1 or L2 failure wins over L3 and L4. Under L3 or L4, a reproduced concrete input where the gold patch is right and the patch is wrong makes the label wrong, as in L7.

| Rule | When | Label |
|---|---|---|
| **A valid test fails** | | |
| L1 | The failing test checks what the issue asks, and the gold patch passes it. Includes a patch that does not apply, does not import, or fixes only part of the issue. | wrong |
| L2 | The failing test checks an adjacent input or path, or an existing behavior the patch broke, and the gold patch gets it right. | wrong |
| **Only untrustworthy tests fail** | | |
| L3 | The test is broken: the gold patch fails it too, it does not load, it clashes with the environment (a duplicate model or table name, leaked state), or it is flaky. A human compares the patch with the gold patch: wrong only with a concrete input the gold patch gets right. | needs a human |
| L4 | The test checks an implementation detail: a private helper or attribute name the gold patch introduced, call structure or mock counts, an internal data shape, message text the issue does not specify, or a gold-patch quirk. | correct |
| **All tests pass** | | |
| L5 | The patch behaves like the gold patch or better. | correct |
| L6 | The patch has a real defect, and the gold patch has it too. | correct |
| L7 | The tests are too lenient: there is a concrete input where the gold patch is right and the patch is wrong, and no test checks it. Never on speculation. | wrong |

## Examples

One issue for all seven: `parse_age(" 42 ")` raises `ValueError`; it should return `42`. The gold patch is `return int(s.strip())`.

| Rule | Candidate patch | What the tests show | Label |
|---|---|---|---|
| L1 | `return int(s)` | `test_spaces`: `parse_age(" 42 ")` raises; gold returns 42 | wrong |
| L2 | `return int(s.replace(" ", ""))` | `test_inner_space`: `parse_age("4 2")` returns 42; gold raises, as before the fix | wrong |
| L3 | `return int(s.strip())` | `test_tabs` fails with `SyntaxError` in the test file; gold fails it too | needs a human |
| L4 | `return int(s.strip())` without gold's new helper `_clean(s)` | `test_uses_clean` asserts `_clean` is called; behavior is the same as gold | correct |
| L5 | `return int(s.strip())` | all pass | correct |
| L6 | `return int(s.strip())` | all pass; `parse_age("-5")` returns -5, and gold does too | correct |
| L7 | `return int(s.strip(" "))` | all pass; `parse_age("\t42")` raises, gold returns 42, and no test sends a tab | wrong |

## Review outcomes

Each review returns pass or fail. Scored against the label:

| | Review fails | Review passes |
|---|---|---|
| **Wrong patch** | catch | miss |
| **Correct patch** | false alarm | correct accept |

A missed wrong patch costs more than a false alarm, so recall on wrong patches comes first when a study picks a primary metric or recommends a setting.

## Overlays

Overlays describe a review without changing its score. A study reports their counts next to the outcome table.

| Overlay | When |
|---|---|
| O1 | A catch for the wrong reason: the review fails a wrong patch, but none of its findings is the real defect. |
| O2 | A false alarm that names a gold-shared defect or a gold-patch quirk. |
| O3 | A shallow pass: the review passes the patch with no reasoning (no thinking, or none about the change). |
| O4 | A malformed verdict: the review's output could not be read as pass or fail. |
| O5 | Later vindicated: the review's verdict or finding matches a behavior the project adopted upstream after the gold patch, against the gold patch. |

## Labels file

[`labels.csv`](labels.csv) holds the labels for the 90 Claude 5.5 effort patches (`set=main`) and the 3 sensitivity originals (`set=sensitivity`): the original stratum label, the rule, the corrected label and any O5 overlay. Every past and future study that scores reviews of these patches uses the corrected `label` column; a study that reports the original labels does so only next to the corrected ones.

## Source

Agreed in the authors' review of the Opus 5.5 effort study on 2026-11-08 and first applied in the Claude 5.5 effort paper (`papers/cr-effort-claude-5.5/`).
