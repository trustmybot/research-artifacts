# A: Accepted Wrong Patches

Frozen with [`../codebook.md`](../codebook.md) (Sections 7 and 9). Run after pass T and after the gold is settled. Coder A is Opus 5.5 at high effort and coder B is Sonnet 5.5 at high effort; each codes every batch independently, without tools, in a fresh context per batch. Items: all 290 accepted (`pass`) reviews of the 55 wrong patches, shuffled, in batches of 15.

Blinding: the packet never shows the reviewer's model, its effort setting, the run name or any review identifier. Items carry random codes from `packets.ts`. Every item is a wrong patch, so the label cannot be hidden in this pass. The packet does not say whether the gold is test-based or reading-based.

## Slots

| Slot | Content |
|---|---|
| `{{codebook}}` | the full text of `codebook.md` |
| `{{items}}` | the batch, one item template per review, in shuffled order |
| `{{item_code}}` | the item's random code |
| `{{problem_statement_1400}}` | the first 1,400 characters of the issue text |
| `{{gold_behaviours}}` | the settled gold behaviours of the patch, one line each as `G1: <statement> (code region: <path::function>)` |
| `{{candidate_patch}}` | the patch the review judged, as a diff |
| `{{feedback}}` | the review's feedback field |

## Allowed Codes

| Field | Codes |
|---|---|
| `concern` | `C2` names a specific functional concern but still passes; `C1` vague hedging only; `C0` none (codebook Section 9) |
| `score` (feedback against each behaviour) | `2` same underlying issue, `1` partial, `0` other (codebook Section 7) |
| `unsure` | `true`, `false` |

## Prompt

````text
You are coding the output of AI code reviewers for a research study. Another coder codes the same items independently. Work only from this packet; do not run code or use tools. Do not try to work out which model or setting wrote a review.

The codebook below is binding. Apply its rules exactly. If two codes still fit after the rules, choose the lower code (C1 over C2, C0 over C1; the lower score) and set unsure to true. Code what the review claims; do not judge whether it is true.

<codebook>
{{codebook}}
</codebook>

PASS A: DID AN ACCEPTING REVIEW NOTICE THE DEFECT?
Each item is a review that accepted a patch, with the reference description of the defect or defects that make the patch wrong (G1, G2, ...). Code its FEEDBACK only.
1. concern (codebook Section 9): C2 = names a specific functional concern but still passes; C1 = vague hedging only; C0 = none.
2. Score the feedback against each reference behaviour with the codebook Section 7 scale:
2 = same underlying issue: the feedback states the behaviour's trigger and wrong outcome, or its direct code cause in a way that implies the trigger. Check: would the minimal fix for the concern also remove the behaviour?
1 = partial: right trigger or right code region but missing or wrong consequence; or a generic remark that covers the behaviour without stating it.
0 = other: anything else, including no concern at all.
Different wording or framing does not lower a score. Ignore the verdict and the review's confidence.

{{items}}

Output
Return one object per item, in the order given, using exactly these keys, with one feedback entry for every behaviour. Keep each "why" to at most two sentences and quote at most 15 words of the review in it. End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. The number in brackets must equal the number of entries.

```toon
items[1]:
  - item: "ITEM CODE"
    concern: "C1"
    unsure: false
    why: "..."
    feedback[1]:
      - gold: "G1"
        score: 1
        unsure: false
        why: "..."
```
````

## Item Template

`packets.ts` fills `{{items}}` with this template once per item, separated by a blank line.

```text
ITEM {{item_code}}
ISSUE (excerpt): {{problem_statement_1400}}
REFERENCE BEHAVIOURS:
{{gold_behaviours}}
PATCH UNDER REVIEW:
{{candidate_patch}}
FEEDBACK:
{{feedback}}
```
