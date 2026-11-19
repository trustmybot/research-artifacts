# G1: Gold Drafting

Frozen with [`../codebook.md`](../codebook.md) (Section 6). Run by the drafter, Opus 5.5 at high effort, without tools, in a fresh context per patch. One run per wrong patch, all 55. Round 2 runs once per patch whose check (prompt G2) returned any `revise`, `reject` or missing test.

## Slots

Filled by `gold-packets.ts`. A slot with no content is filled with `none`.

| Slot | Content |
|---|---|
| `{{instance_id}}` | SWE-bench instance ID |
| `{{agent_id}}` | ID of the agent that submitted the patch |
| `{{basis}}` | `test` for the 50 patches shown wrong by a failing test; `reading` for the five patches shown wrong by reading the patch against the official fix |
| `{{problem_statement}}` | the issue text |
| `{{gold_patch}}` | the official fix, as a diff |
| `{{abs_test_patch}}` | the strengthened test diff (SWE-ABS); for a `reading` patch, only where a failing strengthened test exists |
| `{{tests_with_counts}}` | the failing tests, the union over the three label-check runs, each with the number of runs it failed in |
| `{{excerpts}}` | traceback excerpts (docstring, failing test frame, final error) from the three runs |
| `{{candidate_patch}}` | the wrong patch, as a diff |
| `{{g1_draft}}` | round 2 only: this prompt's round-1 reply |
| `{{g2_check}}` | round 2 only: the checker's reply |
| `{{round_1_rules}}` | round 2 only: the Rules block of round 1, verbatim |

## Prompt: Round 1

````text
You are writing the reference description of a software defect for a research study. You will not see any code review. Work only from this packet; do not use tools.

A candidate patch for a Django issue is wrong: on some input the official fix behaves correctly and the candidate patch does not. Your job: state, for each distinct defect, what goes wrong.

The packet's BASIS says how the patch was shown to be wrong:
- BASIS test: one or more strengthened tests (SWE-ABS) fail on the patch and pass on the official fix. Describe the defects those failing tests show.
- BASIS reading: no trustworthy test shows the defect. Find it by tracing a concrete input through the official fix and through the candidate patch. A failing strengthened test, if one is listed, may support the statement; cite it only if it shows the same defect.

Rules
1. Group by underlying issue: two tests (or two inputs) belong to the same behaviour if the same minimal change to the patch would fix both. Give each behaviour an ID: G1, G2, ...
2. For each behaviour write a statement of one to three sentences with three parts: TRIGGER (the input, state or call path that exposes it), EXPECTED (what the official fix does, per its diff and, for BASIS test, the test's assertion), ACTUAL (what the patch does: for BASIS test, per the traceback; for BASIS reading, per the patch's code).
3. For BASIS test, list every failing test in exactly one behaviour. For BASIS reading, list only the failing tests that show the behaviour, or none.
4. For BASIS reading, TRIGGER must be a concrete input (a value, a model definition, a call) on which you can show, from the two diffs, that the official fix is right and the patch is wrong. Never speculate. If you cannot show such an input with confidence, write your best statement, set "suspect": true and explain in "notes".
5. Name the code region the official fix changes for this behaviour as path::function.
6. Describe behaviour, not code. Do not copy more than 10 consecutive words from the candidate patch. Test names, docstrings and the official fix may be quoted.
7. If a test failed in fewer than 3 of the 3 runs, say so in "notes". If the traceback shows an error in the test itself or in the environment rather than in the patch's behaviour, set "suspect": true and explain.
8. Do not judge whether the issue requires the behaviour. Do not speculate beyond the packet.

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

Output
End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. The number in brackets must equal the number of entries. Use exactly these keys:

```toon
instance_id: "{{instance_id}}"
agent_id: "{{agent_id}}"
behaviours[1]:
  - id: "G1"
    basis: "test or reading"
    tests[1]: "test name as listed"
    trigger: "..."
    expected: "..."
    actual: "..."
    statement: "one to three sentences: trigger, expected, actual"
    code_region: "path::function"
    suspect: false
    notes: ""
```
````

## Prompt: Round 2 (Response to the Check)

The drafter sees the checker's reply once.

````text
You drafted the reference defect description below. A second, independent checker has reviewed it. Work only from this packet; do not use tools.

For each behaviour the checker marked "revise" or "reject", either accept the checker's version or rebut it with a reason grounded in the packet. For each test the checker reported as missing, add it to a behaviour or to a new behaviour, or rebut. Behaviours the checker accepted stay as they are. Apply the same rules as in your draft (copied below).

{{round_1_rules}}

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
YOUR DRAFT:
{{g1_draft}}
CHECKER'S REPLY:
{{g2_check}}

Output
End your reply with one fenced toon block and nothing after it, quoted as before. "response" is "accept" or "rebut". "final" holds the full behaviour you now stand by (your original for a rebuttal, the checker's replacement or your amended version for an acceptance); for an accepted "reject", set "final" to null.

```toon
instance_id: "{{instance_id}}"
responses[1]:
  - id: "G1"
    response: "accept or rebut"
    why: "at most two sentences"
    final:
      id: "G1"
      basis: "test or reading"
      tests[1]: "..."
      trigger: "..."
      expected: "..."
      actual: "..."
      statement: "..."
      code_region: "path::function"
      suspect: false
      notes: ""
```
````
