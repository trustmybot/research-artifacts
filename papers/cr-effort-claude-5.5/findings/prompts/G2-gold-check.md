# G2: Gold Check

Frozen with [`../codebook.md`](../codebook.md) (Section 6). Run by the checker, Sonnet 5.5 at high effort, without tools, in a fresh context per patch. Round 1 checks every draft from prompt G1, all 55 patches. Round 2 runs once per patch where the drafter rebutted a point; a point the checker holds goes to the adjudicator (prompt J), and the patch is flagged `contested`.

## Slots

Filled by `gold-packets.ts`. A slot with no content is filled with `none`. The packet slots are the same as in prompt G1.

| Slot | Content |
|---|---|
| `{{instance_id}}`, `{{agent_id}}`, `{{basis}}`, `{{problem_statement}}`, `{{gold_patch}}`, `{{abs_test_patch}}`, `{{tests_with_counts}}`, `{{excerpts}}`, `{{candidate_patch}}` | as in G1 |
| `{{g1_draft}}` | the drafter's round-1 reply |
| `{{g2_check}}` | round 2 only: this prompt's round-1 reply |
| `{{g1_response}}` | round 2 only: the drafter's round-2 reply |

## Prompt: Round 1

````text
You are checking a reference defect description written by another model for a research study. You will not see any code review. Work only from this packet; do not use tools.

The candidate patch is wrong: on some input the official fix behaves correctly and the patch does not. BASIS test means strengthened tests (SWE-ABS) fail on the patch and pass on the official fix. BASIS reading means no trustworthy test shows the defect, and the description must rest on a concrete input traced through both diffs.

For each behaviour in the draft, check:
(a) Coverage. BASIS test: every listed test is in the failing list, and every failing test is in exactly one behaviour. BASIS reading: every listed test is in the failing list and shows this behaviour.
(b) Grouping: tests or inputs share a behaviour only if one minimal change to the patch would fix them all.
(c) EXPECTED matches the official fix (and, for BASIS test, the test's assertion).
(d) ACTUAL matches the traceback (BASIS test) or follows from the candidate patch's code on the stated trigger (BASIS reading; trace it yourself).
(e) The statement names a concrete trigger and a concrete wrong outcome, specific enough that a reviewer's comment could be matched to it.
(f) It describes behaviour, copies no more than 10 consecutive words from the candidate patch, and says nothing about whether the issue requires it.
(g) code_region names the path::function the official fix changes for this behaviour.

For each behaviour return "accept", "revise" (give the full replacement behaviour) or "reject" (say why; use this when the behaviour is not a defect of the patch, for example a test or environment error). Also report any failing test the draft left out (BASIS test only).

Packet
INSTANCE: {{instance_id}}   PATCH: {{agent_id}}   BASIS: {{basis}}
ISSUE:
{{problem_statement}}
OFFICIAL FIX (diff):
{{gold_patch}}
STRENGTHENED TEST DIFF (SWE-ABS):
{{abs_test_patch}}
FAILING TESTS (union of 3 runs; runs failed of 3):
{{tests_with_counts}}
TRACEBACK EXCERPTS:
{{excerpts}}
CANDIDATE PATCH (diff):
{{candidate_patch}}
DRAFT:
{{g1_draft}}

Output
End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. The number in brackets must equal the number of entries. "failed_criteria" lists the letters (a)-(g) that failed, without parentheses. "replacement" is null unless the verdict is "revise".

```toon
instance_id: "{{instance_id}}"
checks[1]:
  - id: "G1"
    verdict: "accept, revise or reject"
    failed_criteria[0]:
    replacement: null
    why: "at most two sentences"
missing_tests[0]:
```

A "revise" gives "replacement" as a full behaviour with the keys id, basis, tests, trigger, expected, actual, statement, code_region, suspect and notes, as in the draft.
````

## Prompt: Round 2 (Response to a Rebuttal)

````text
You checked the reference defect description below, and its drafter has rebutted some of your points. Work only from this packet; do not use tools. Apply the same criteria (a)-(g) as in your check.

For each point the drafter rebutted, either "concede" (the drafter's version stands) or "hold" (your version stands; say which criterion the drafter's version still fails). Points the drafter accepted are settled and need no reply. A point you hold goes to an independent adjudicator.

Packet
INSTANCE: {{instance_id}}   PATCH: {{agent_id}}   BASIS: {{basis}}
ISSUE:
{{problem_statement}}
OFFICIAL FIX (diff):
{{gold_patch}}
STRENGTHENED TEST DIFF (SWE-ABS):
{{abs_test_patch}}
FAILING TESTS (union of 3 runs; runs failed of 3):
{{tests_with_counts}}
TRACEBACK EXCERPTS:
{{excerpts}}
CANDIDATE PATCH (diff):
{{candidate_patch}}
DRAFT:
{{g1_draft}}
YOUR CHECK:
{{g2_check}}
DRAFTER'S RESPONSE:
{{g1_response}}

Output
End your reply with one fenced toon block and nothing after it, quoted as before.

```toon
instance_id: "{{instance_id}}"
replies[1]:
  - id: "G1"
    reply: "concede or hold"
    failed_criteria[0]:
    why: "at most two sentences"
```
````
