# J: Adjudication

Frozen with [`../codebook.md`](../codebook.md) (Sections 6 and 10). Run by the adjudicator, Opus 5.5 at medium effort, without tools, in a fresh context per item. One run per disputed field: every code on which coders A and B disagree in passes T, M, C and A, and every gold point the checker holds after the drafter's rebuttal.

Blinding:
- The adjudicator never learns which coder gave which code. The two codes are labelled X and Y, in an order randomized per item by `collect.ts` and recorded in the adjudication log; no coder or model name appears.
- For a gold dispute, X and Y are the drafter's and the checker's versions, in random order, without saying which is which.
- The item packet is the same packet the coders saw, so it never shows the reviewer's model, its effort setting, the run name or any review identifier.
- `collect.ts` replaces any coder or model name that appears inside a reason with `[coder]` before the packet is sent.

## Slots

| Slot | Content |
|---|---|
| `{{codebook}}` | the full text of `codebook.md` |
| `{{pass_instructions}}` | the pass-specific part of the prompt the coders received (from the `PASS` line to the item list), or, for a gold dispute, the Rules and criteria of prompts G1 and G2 |
| `{{item}}` | the item packet, filled from that pass's item template, or the gold packet |
| `{{field}}` | the disputed field, e.g. `finding 2: class/type/subtype`, `pair finding 1 x G2: score`, `reality`, `concern`, `gold G1` |
| `{{allowed_codes}}` | the codes allowed for that field, copied from the pass prompt's Allowed Codes table |
| `{{code_x}}`, `{{why_x}}` | the first code shown and its reason |
| `{{code_y}}`, `{{why_y}}` | the second code shown and its reason |

For pass T, class, type and subtype are disputed together as one triple, written `F/F-LOG/cmp`. For a gold dispute, each code is the full behaviour (or `reject`), and `final` is `X`, `Y`, `reject`, or a third behaviour written as one statement string with its trigger, expected and actual parts.

## Allowed Codes

`final` must be `{{code_x}}`, `{{code_y}}`, or a third code from `{{allowed_codes}}`. A third code requires a cited codebook rule that rules out both X and Y.

## Prompt

````text
You are settling a disagreement between two independent coders in a research study. You do not know which model either coder is, which coder gave which code, or which model wrote the review. Do not try to work any of these out. Work only from this packet; do not use tools.

The codebook below is binding.
<codebook>
{{codebook}}
</codebook>

The instructions the coders received:
<pass_instructions>
{{pass_instructions}}
</pass_instructions>

The item:
<item>
{{item}}
</item>

The disputed field: {{field}}
Allowed codes for this field: {{allowed_codes}}
Code X: {{code_x}}, because: {{why_x}}
Code Y: {{code_y}}, because: {{why_y}}

Decide which code the codebook supports. Choose X or Y. Choose a third code only if a specific codebook rule rules out both; name that rule. Do not split the difference, and do not prefer a code because of how its reason is written.

Output
End your reply with one fenced toon block and nothing after it. Quote every string value, and inside quotes write a double quote as \", a backslash as \\ and a line break as \n. "basis" is X, Y or third. "rule_cited" names the codebook section or rule; it is required for third and recommended otherwise.

```toon
item: "ITEM CODE"
field: "{{field}}"
final: "..."
basis: "X"
rule_cited: "codebook section or rule"
why: "at most two sentences"
```
````
