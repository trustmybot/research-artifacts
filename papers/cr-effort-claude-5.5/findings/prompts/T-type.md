# T: Finding Type (Label-Blind)

Frozen with [`../codebook.md`](../codebook.md) (Sections 2-5). Run first, before passes M, C and A. Coder A is Opus 5.5 at high effort and coder B is Sonnet 5.5 at high effort; each codes every batch independently, without tools, in a fresh context per batch. Items: all 232 reviews with a `fail` or malformed verdict, on correct and wrong patches pooled and shuffled, in batches of 15.

Blinding: the packet never shows the reviewer's model, its effort setting, the run name, the review or finding identifiers of `findings.csv`, or the patch's label. Items carry random codes from `packets.ts`.

## Slots

| Slot | Content |
|---|---|
| `{{codebook}}` | the full text of `codebook.md` |
| `{{items}}` | the batch, one item template per review, in shuffled order |
| `{{item_code}}` | the item's random code |
| `{{problem_statement_1400}}` | the first 1,400 characters of the issue text |
| `{{candidate_patch}}` | the patch the review judged, as a diff |
| `{{feedback}}` | the review's feedback field, or `none parsed` |
| `{{findings}}` | the review's findings, one line each as `[n] location: ... \| problem: ...`, or `none parsed` |
| `{{final_message}}` | for a malformed review with no recovered finding, the reviewer's final message; otherwise `not needed` |

## Allowed Codes

| Field | Codes |
|---|---|
| `class` | `F`, `E`, `N` |
| `type` | F: `F-RES`, `F-CHK`, `F-INT`, `F-LOG`, `F-TIM`, `F-SUP`, `F-LRG`; E: `E-TXT`, `E-LNG`, `E-VIS`, `E-ORG`, `E-SOL`; N: `N-TST`, `N-QST`, `N-DSG`, `N-PRS`, `N-PRC`, `N-UNC` |
| `subtype` | the subtype codes listed under the type in codebook Section 3; `none` for F-TIM and every class N code |
| `quality_flag` | `none`, `performance`, `security`, `compatibility` |
| `multi_claim`, `unsure`, `no_codable_finding` | `true`, `false` |
| `reproduction` | `R2`, `R1`, `R0` |
| `model_guess` | `opus`, `sonnet`, `haiku`, `unsure` |

## Prompt

````text
You are coding the output of AI code reviewers for a research study. Another coder codes the same items independently. Work only from this packet; do not run code or use tools. Do not try to work out which model or setting wrote a review, except in the model_guess field.

The codebook below is binding. Apply its decision order and boundary rules exactly. If two codes still fit after the rules, choose the one the codebook names as the default and set unsure to true. Code what the review claims; do not judge whether it is true.

<codebook>
{{codebook}}
</codebook>

PASS T: FINDING TYPE.
Each item is one review of a patch: its feedback and its numbered findings, with the issue and the patch for context. You are not told whether the patch is correct and must not judge it.

For each finding give: class (F, E or N), type (a code from codebook Section 3, e.g. "F-LOG"), subtype (a subtype code listed under that type, or "none" where the codebook says so), quality_flag (none, performance, security, compatibility; codebook 3.4), multi_claim (codebook 3.5), unsure, and why.
For each review give: reproduction (R2, R1 or R0; codebook Section 5, judged from the findings and the feedback together) and model_guess (opus, sonnet, haiku or unsure).
If FINDINGS says "none parsed", first split the FINAL MESSAGE into finding-like claims (statements that the patch has a specific defect), number them from 1, copy each claim's words exactly (at most 40 words) into "claim", and code each. If there is none, return an empty findings list and set no_codable_finding to true. For parsed findings, set claim to null.

{{items}}

Output
Return one object per item, in the order given, using exactly these keys. Keep each "why" to at most two sentences and quote at most 15 words of the review in it. End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. The number in brackets must equal the number of entries.

```toon
items[1]:
  - item: "ITEM CODE"
    reproduction: "R0"
    model_guess: "unsure"
    no_codable_finding: false
    findings[1]:
      - n: 1
        claim: null
        class: "F"
        type: "F-LOG"
        subtype: "cmp"
        quality_flag: "none"
        multi_claim: false
        unsure: false
        why: "..."
```
````

## Item Template

`packets.ts` fills `{{items}}` with this template once per item, separated by a blank line.

```text
ITEM {{item_code}}
ISSUE (excerpt): {{problem_statement_1400}}
PATCH UNDER REVIEW:
{{candidate_patch}}
FEEDBACK:
{{feedback}}
FINDINGS:
{{findings}}
FINAL MESSAGE:
{{final_message}}
```
