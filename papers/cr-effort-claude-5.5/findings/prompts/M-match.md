# M: Right Reason (Rejections of Wrong Patches)

Frozen with [`../codebook.md`](../codebook.md) (Sections 6 and 7). Run after pass T and after the gold is settled. Coder A is Opus 5.5 at high effort and coder B is Sonnet 5.5 at high effort; each codes every batch independently, without tools, in a fresh context per batch. Items: all 205 rejections (`fail` or malformed) of the 55 wrong patches, shuffled, in batches of 15.

Blinding: the packet never shows the reviewer's model, its effort setting, the run name, or the review or finding identifiers of `findings.csv`. Items carry random codes from `packets.ts`. Every item is a wrong patch, so the label cannot be hidden in this pass. The packet does not say whether the gold is test-based or reading-based.

## Slots

| Slot | Content |
|---|---|
| `{{codebook}}` | the full text of `codebook.md` |
| `{{items}}` | the batch, one item template per review, in shuffled order |
| `{{item_code}}` | the item's random code |
| `{{problem_statement_1400}}` | the first 1,400 characters of the issue text |
| `{{gold_behaviours}}` | the settled gold behaviours of the patch, one line each as `G1: <statement> (code region: <path::function>)` |
| `{{candidate_patch}}` | the patch the review judged, as a diff |
| `{{feedback}}` | the review's feedback field, or `none parsed` |
| `{{findings}}` | the review's findings, one line each as `[n] location: ... \| problem: ...`, or `none parsed` |
| `{{final_message}}` | for a malformed review with no recovered finding, the reviewer's final message; otherwise `not needed` |

## Allowed Codes

| Field | Codes |
|---|---|
| `score` (finding pairs and feedback) | `2` same underlying issue, `1` partial, `0` other (codebook Section 7) |
| `no_codable_finding`, `unsure` | `true`, `false` |

The review-level code (`named`, `partial`, `other`, `no_codable_finding`) and `feedback_named` are derived by `collect.ts` from the scores; coders do not write them.

## Prompt

````text
You are coding the output of AI code reviewers for a research study. Another coder codes the same items independently. Work only from this packet; do not run code or use tools. Do not try to work out which model or setting wrote a review.

The codebook below is binding. Apply its rules exactly. If two scores still fit after the rules, choose the lower score and set unsure to true. Code what the review claims; judge truth only where this pass asks for it.

<codebook>
{{codebook}}
</codebook>

PASS M: DID THE REJECTION NAME THE DEFECT?
Each item is a review that rejected a patch, with the reference description of the defect or defects that make the patch wrong (G1, G2, ...). Score every (finding, behaviour) pair with the scale in codebook Section 7:
2 = same underlying issue: the finding states the behaviour's trigger and wrong outcome, or its direct code cause in a way that implies the trigger. Check: would the minimal fix for the finding also remove the behaviour?
1 = partial: right trigger or right code region but missing or wrong consequence; or a generic claim that covers the behaviour without stating it.
0 = other: anything else. Same location alone is 0. A true claim about a different defect is 0.
Different wording, line numbers or framing do not lower a score. Ignore the verdict and the review's confidence. Then score the FEEDBACK text against each behaviour the same way, separately.
If FINDINGS says "none parsed", first split the FINAL MESSAGE into finding-like claims (statements that the patch has a specific defect), number them from 1, copy each claim's words exactly (at most 40 words) into "claims", and score each as a finding. If there is none, set no_codable_finding to true and return empty claims and pairs. If FEEDBACK also says "none parsed", return an empty feedback list. For parsed findings, return an empty claims list.

{{items}}

Output
Return one object per item, in the order given, using exactly these keys. Give one pair for every finding and every behaviour, and one feedback entry for every behaviour. Keep each "why" to at most two sentences and quote at most 15 words of the review in it. End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. The number in brackets must equal the number of entries.

```toon
items[1]:
  - item: "ITEM CODE"
    no_codable_finding: false
    claims[0]:
    pairs[1]:
      - finding: 1
        gold: "G1"
        score: 2
        unsure: false
        why: "..."
    feedback[1]:
      - gold: "G1"
        score: 0
        unsure: false
        why: "..."
```

A recovered claim is written as `- n: 1` and `claim: "..."` under `claims[k]:`.
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
FINDINGS:
{{findings}}
FINAL MESSAGE:
{{final_message}}
```
