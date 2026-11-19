# C: Claims in Rejections (False Alarms Pooled with Decoys, Label-Blind)

Frozen with [`../codebook.md`](../codebook.md) (Section 8). Run after pass T. Coder A is Opus 5.5 at high effort and coder B is Sonnet 5.5 at high effort; each codes every batch independently, without tools, in a fresh context per batch. Items: the 27 rejections of correct patches (false alarms) and 27 decoys drawn from the rejections of wrong patches, pooled and shuffled, in batches of 9.

Blinding: the packet never shows the reviewer's model, its effort setting, the run name, the review or finding identifiers of `findings.csv`, the patch's label, or whether the item is a decoy. Items carry random codes from `packets.ts`. No gold behaviour is shown.

## Slots

| Slot | Content |
|---|---|
| `{{codebook}}` | the full text of `codebook.md` |
| `{{items}}` | the batch, one item template per review, in shuffled order |
| `{{item_code}}` | the item's random code |
| `{{problem_statement}}` | the full issue text |
| `{{candidate_patch}}` | the patch the review judged, as a diff |
| `{{gold_patch}}` | the official fix, as a diff |
| `{{feedback}}` | the review's feedback field, or `none parsed` |
| `{{findings}}` | the review's findings, one line each as `[n] location: ... \| problem: ...`, or `none parsed` |
| `{{final_message}}` | for a malformed review with no recovered finding, the reviewer's final message; otherwise `not needed` |

## Allowed Codes

| Field | Codes |
|---|---|
| `main_finding` | the number of a finding (or recovered claim), or `0` if there is no codable claim |
| `reality` | `real_in_scope`, `real_shared`, `real_outside_issue`, `not_real`, `unverifiable` |
| `false_positive_issue`, `redundant`, `out_of_scope`, `overcorrection`, `environment_artifact` | `true`, `false` |
| `open` | a label of at most five words, or `""` |
| `unsure` | `true`, `false` |

## Prompt

````text
You are coding the output of AI code reviewers for a research study. Another coder codes the same items independently. Work only from this packet; do not run code or use tools. Do not try to work out which model or setting wrote a review.

The codebook below is binding. Apply its rules exactly. If two codes still fit after the rules, choose the one the codebook names as the default and set unsure to true. Code what the review claims; judge truth only where this pass asks for it.

<codebook>
{{codebook}}
</codebook>

PASS C: IS THE REJECTION'S MAIN CLAIM REAL?
Each item is a review that rejected a patch, with the issue, the patch and the official fix. Some of these patches are correct and some are wrong; you are not told which.
1. main_finding: the number of the finding the rejection rests on (the first listed, unless the feedback names another as decisive).
2. reality of that finding's claim, judged against what the official fix does (codebook Section 8a): real_in_scope, real_shared, real_outside_issue, not_real or unverifiable.
3. The reason codes (codebook Section 8b), each true or false: false_positive_issue, redundant, out_of_scope, overcorrection, environment_artifact. If none of them covers the reason, write a label of at most five words in "open"; otherwise leave "open" empty. If reality is real_in_scope, set every reason code to false and leave "open" empty.
Reason from the code and the issue; do not assume the official fix is perfect, but use its behaviour as the reference for "real_shared".
If FINDINGS says "none parsed", first split the FINAL MESSAGE into finding-like claims (statements that the patch has a specific defect), number them from 1, copy each claim's words exactly (at most 40 words) into "claims", and choose the main finding among them. If there is none, set main_finding to 0, reality to "unverifiable", every reason code to false, and say so in "why". For parsed findings, return an empty claims list.

{{items}}

Output
Return one object per item, in the order given, using exactly these keys. Keep "why" to at most two sentences and quote at most 15 words of the review in it. End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. The number in brackets must equal the number of entries.

```toon
items[1]:
  - item: "ITEM CODE"
    claims[0]:
    main_finding: 1
    reality: "not_real"
    false_positive_issue: true
    redundant: false
    out_of_scope: false
    overcorrection: false
    environment_artifact: false
    open: ""
    unsure: false
    why: "..."
```

A recovered claim is written as `- n: 1` and `claim: "..."` under `claims[k]:`.
````

## Item Template

`packets.ts` fills `{{items}}` with this template once per item, separated by a blank line.

```text
ITEM {{item_code}}
ISSUE:
{{problem_statement}}
PATCH UNDER REVIEW:
{{candidate_patch}}
OFFICIAL FIX:
{{gold_patch}}
FEEDBACK:
{{feedback}}
FINDINGS:
{{findings}}
FINAL MESSAGE:
{{final_message}}
```
