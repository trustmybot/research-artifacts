**Version: frozen for RQ6 on 2026-11-18, before any gold or coder run. Source: discussion 3775 on issue 294, as amended by discussions 3777, 3779 and 3780 (the later entry wins). Nothing in this file changes after the freeze; a change is a deviation and is logged as one.**

# RQ6 Codebook: What the Reviews Named

This codebook is binding for every coding pass of the findings analysis (RQ6) and for the adjudicator. It is shown in full to every coder.

**RQ6 (exploratory, post hoc).** When a reviewer rejected a plausible-but-wrong patch, did it name the defect that makes the patch wrong? What kinds of defects did its findings report? What did its false alarms claim? And when it accepted a wrong patch, had it already noticed the defect?

**Terms.**
- *Finding*: one entry in a review's `findings` list, with a `location` and a `problem` text.
- *Feedback*: the review's free-text `feedback` field.
- *Gold behaviour*: the reference statement of one defect of a wrong patch (G1, G2, ...), written before any coder sees a review (Section 6).
- *Official fix*: the patch that resolved the issue in the project; it is the reference for correct behaviour.
- *Decoy*: a rejection of a wrong patch mixed into the false-alarm set, so that membership in the set does not reveal a patch's label.
- *Adjudication*: settling a disagreement between two coders by a third, independent judgement.
- *Crosswalk*: a table that maps each of our codes to the nearest code in another published scheme.

## 1. Units and Passes

The base is the same as for the paper's other research questions: all 55 wrong patches, every rejection of them, and every accepted review of them.

| Unit | n | Coded in |
|---|---|---|
| Wrong patches with gold behaviours | 55 (50 shown wrong by a failing test; five shown wrong by reading the patch against the official fix, rule L7 in [LABELS.md](../../../LABELS.md)) | gold drafting and check |
| Rejections with findings (`fail`) or with a malformed verdict, all patches | 232 reviews (217 `fail`, 15 malformed) | pass T |
| Rejections of the 55 wrong patches | 205 (196 `fail`, 9 malformed) | pass M |
| Rejections of correct patches (false alarms) | 27 (21 `fail`, 6 malformed) | pass C |
| Decoys | 27, drawn from the 205 rejections of wrong patches, matched to the false alarms' model and effort counts | pass C |
| Accepted reviews of the 55 wrong patches (`pass`) | 290 | pass A |

| Pass | Question | Label shown | Gold shown |
|---|---|---|---|
| T, finding type | What kind of defect does each finding claim? Does the review show a reproduction? | no | no |
| M, match | Does any finding, or the feedback, name a gold behaviour? | implied (every item is a wrong patch) | yes |
| C, claim | Is the rejection's main claim real, and if not, why was the patch rejected? | no (false alarms pooled with decoys) | no; the official fix is shown |
| A, accepted | Did the accepting review's feedback raise a concern or name a gold behaviour? | implied | yes |

Pass T runs first, so the gold cannot shape type codes. Passes M, C and A follow.

**What a coder never sees.** No packet shows the model or the effort setting that produced a review, the run name, or the review identifiers of the findings table. Items carry random codes. A coder must not try to infer the reviewer's model or effort, except in the `model_guess` field of pass T, which measures how well this blinding held.

## 2. General Rules

- **Source of the type scheme.** Mäntylä and Lassenius (2009), Sections 4.1-4.3, Fig. 2 and Tables 4-18 (abbreviated M&L below), read in the authors' accepted manuscript. Type definitions in quotation marks are quoted from M&L. Every subtype is one row of the M&L table cited under its type. The paper's tables give only row labels and counts, so subtype definitions in quotation marks are quoted from the authors' companion description of each row (Mäntylä & Lassenius, 2013). Anything neither source gives is marked "(ours)", and all examples are ours.
- **Code the claim, not its truth.** A wrong claim about a missing None check is still Check. Truth is judged only in pass C.
- **One code per finding.** If a finding makes two or more claims, code the claim stated first and set `multi_claim: true`.
- **Class decision (M&L Section 4.1.2).** A claim is *functional* (class F) if it says that some input, state or sequence of calls produces a wrong output, a wrong exception, a wrong side effect or a crash. It is *evolvability* (class E) if it concerns only how the code reads, is organized or could be changed. It is *not a defect claim* (class N) if it claims no defect (Section 3.3). When unsure between F and E, choose F, as M&L did.
- **Decision order for functional claims.** Apply the first type that fits: Timing, Support, Interface, Larger defects, Check, Resource, then Logic as the default. The boundary rules in Section 4 override this order where they apply.
- **Unsure.** If two codes still fit after the decision order and the boundary rules, choose the one the codebook names as the default (F over E; Logic among functional types; `other` among subtypes) and set `unsure: true`.

## 3. Codes

### 3.1 Functional Defects (Class F)

Each type lists its subtype codes. Write the type code in `type` and the subtype code in `subtype`. Each subtype is one row of the M&L table named under its type. Scope notes marked "(ours)" adapt a row to this study.

**F-RES, Resource.** "Mistakes made with data, variables, or other resource initialization, manipulation, and release." Includes a wrong default or initial value, mutating a shared or cached object, state not reset, a file, connection or cursor not closed, a wrong value stored. Excludes a wrong value that comes from a wrong formula or condition (Logic). Subtypes: M&L Table 14.

| Subtype | M&L row (Table 14) | Definition | Example claim (ours) |
|---|---|---|---|
| `init` | Variable initialization | "Defects where variables are left uninitialized prior to use." (Ours:) Python raises an error on reading an unassigned name, so this row also takes a variable, attribute or default that starts with a wrong value. | "`limit` defaults to 0, so every query returns no rows" |
| `mem` | Memory management | "A defect where a mistake is made in handling the system memory." (Ours:) includes unbounded caches and objects kept alive too long. | "The new module-level cache is never cleared, so it grows with every request" |
| `data` | Data and resource manipulation | "Defects related to manipulating or releasing data or other resources," for example "not releasing database cursor, and mistakes in data modification." | "The patch mutates the caller's `options` dict, so the second call sees the first call's values" |

**F-CHK, Check.** "Validation mistakes or mistakes made when detecting an invalid value." Includes a missing or wrong guard for None, empty, wrong type, out-of-range or special values; an unchecked return value or exception; a validation that accepts invalid or rejects valid input. Excludes conditions that choose between two valid behaviours (Logic). Subtypes: M&L Table 15.

| Subtype | M&L row (Table 15) | Definition | Example claim (ours) |
|---|---|---|---|
| `ret` | Check function | "When a function is called there is also a need to check that the value returned is valid and that no error occurred." | "`get_backend()` may return None, and the result is used without a check" |
| `var` | Check variable | "There is a need to check variable"; such variables were often "function parameters, or loop control variables." | "`parse_age(None)` raises AttributeError instead of a clear error" |
| `input` | Check user input | "The need to validate user input." | "The form now accepts a negative quantity" |

**F-INT, Interface.** "Mistakes made when interacting with other parts of the software, such as an existing code library, a hardware device, a database, or an operating system." Includes a wrong or missing call to another component's API (the Django ORM, a database backend, the Python standard library, the OS); wrong, missing or extra arguments; violating a called API's contract. Excludes the patch's own internal logic (Logic). Subtypes: M&L Table 16.

| Subtype | M&L row (Table 16) | Definition | Example claim (ours) |
|---|---|---|---|
| `call` | Function call | "A function call to another part of the system or class library is incorrect or missing." | "Calls `connection.cursor()` where `connection.chunked_cursor()` is needed, so the result is loaded at once" |
| `param` | Parameter | "A function call or other interaction mechanism has an incorrect or missing parameter." | "`json.dumps` is called without `cls=DjangoJSONEncoder`, so dates raise TypeError" |

**F-LOG, Logic.** "Defects made with comparison operations, control flow, and computations and other types of logical mistakes." Includes a wrong condition, operator or ordering; a wrong computation; a correct operation done too soon or too late; an inefficient algorithm whose cost changes behaviour; a case handled by a wrong branch. Excludes missing guards (Check) and missing whole features (Larger defects). Logic is the default functional type. Subtypes: M&L Table 17.

| Subtype | M&L row (Table 17) | Definition | Example claim (ours) |
|---|---|---|---|
| `cmp` | Compare | "A mistake in a comparison statement," for example "the wrong element is compared, a required comparison is missing, or the wrong type of comparison is made." | "`>` should be `>=`, so a value equal to the limit is rejected" |
| `comp` | Compute | "Computations produce incorrect results." | "Uses `replace` where `strip` is needed, so inner spaces are removed" |
| `loc` | Wrong location | "A correct operation is performed, but it is done too soon or too late." | "The escaping runs before the template is rendered, so the output is escaped twice" |
| `alg` | Algorithm/performance | "An inefficient algorithm is used." (Ours:) coded here only when the claim says the inefficiency changes behaviour, such as a timeout; otherwise see Section 3.4. | "The new nested loop is quadratic in the number of rows, so the admin page times out on large tables" |
| `other` | Other | Any other logic defect; M&L's examples include "missing an entire comparison statement and the required logic to handle the particular case." | "Aware datetimes now take the naive branch" |

**F-TIM, Timing.** "Defects that are possible only in multithread applications where concurrently executing threads or processes use shared resources." Includes races, thread-local or async shared-state errors, deadlocks. Excludes single-threaded ordering mistakes (Logic). M&L found no timing defects and give no subtype table.

| Subtype | M&L row | Definition | Example claim (ours) |
|---|---|---|---|
| `none` | none (no table) | Any timing defect (ours). | "Two requests can both pass the existence check and insert the same row" |

**F-SUP, Support.** Defects that "relate to support systems and libraries or their configurations." Includes settings or configuration defaults, Python or database version compatibility, dependency versions, build or packaging. Excludes a wrong call into a library (Interface). M&L found no support defects and give no subtype table. The two subtypes are ours, built on the examples in M&L Section 4.3.1: "version control and build-management system configurations can introduce defects. Similarly, using the wrong version of an external library can cause defects."

| Subtype | M&L row | Definition | Example claim (ours) |
|---|---|---|---|
| `cfg` | none (ours) | A setting, configuration default, or build or packaging configuration is wrong or ignored (ours). | "The patch ignores `USE_TZ = False`" |
| `ver` | none (ours) | The code breaks on a supported Python, database or library version (ours). | "`str.removeprefix` does not exist on Python 3.8, which this release supports" |

**F-LRG, Larger defects.** Defects that "cannot be pinpointed to a single, small set of code lines … functionality is missing or implemented incorrectly and such defects often require additional code or larger modifications to the existing solution." Includes a requirement or case from the issue that the patch does not address at all; an approach that is wrong as a whole; a defect in code the patch did not touch. Excludes anything a small, local edit to the patched lines would fix (Section 4, rule 2). Subtypes: M&L Table 18.

| Subtype | M&L row (Table 18) | Definition | Example claim (ours) |
|---|---|---|---|
| `compl` | Completeness | "A feature is partially implemented." (Ours:) includes an approach that is wrong as a whole. | "The issue asks for all whitespace, but tab characters are not handled at all" |
| `gui` | GUI | "Defects in the user interface code relating to the consistency of the user-interface, and to the options made possible to the user in each situation." (Ours:) in this study, admin pages, rendered forms and templates. | "The new admin action is offered on the change list but not on the change form, unlike every other action" |
| `outside` | Check outside code | "Defects that required that part of the application code that was not under review to be checked, as it was likely to contain incorrect code based on the current review." | "The serializer in `core/serializers/json.py`, which the patch does not touch, still drops the new field" |

### 3.2 Evolvability Defects (Class E)

Group definitions are from M&L Section 4.2; the groups and subgroups follow M&L Fig. 2 and Tables 4, 5 and 9. Expect this class to be nearly empty: the reviewer prompt allowed a `fail` only for functional defects or unmet requirements. Each subtype code is its M&L row label in snake_case, except that every "Other" or "Others" row is coded `other`.

**E-TXT, Documentation, textual.** Documentation "is information in the source code that communicates the intent of the code to humans (e.g., commenting and naming of software elements, such as variables, functions, and classes)"; the textual subgroup is the documentation that the language does not enforce (M&L Section 4.2.1). Subtypes: M&L Table 6.

| Subtype | M&L row (Table 6) | Definition | Example claim (ours) |
|---|---|---|---|
| `naming` | Naming | "Problems relating to software element (=methods, classes, variables, etc) names." | "`get_user` actually creates a user; rename it" |
| `comments` | Comments | "Problems in code comments." | "The docstring still says None is returned" |
| `debug_info` | Debug info | "Problems with debugging messages"; in M&L all such defects "requested more information on the error condition." | "The error message does not say which field failed" |
| `other` | Others | "Other Textual Defects that could not be placed to other defect classes." | "The changelog entry describes a different change" |

**E-LNG, Documentation, supported by language.** Documentation issues "that are currently embedded in and enforced by modern programming languages, whose main purpose is mostly documentation," such as declaring a variable immutable or limiting a method's scope (M&L Section 4.2). Subtypes: M&L Table 7.

| Subtype | M&L row (Table 7) | Definition | Example claim (ours) |
|---|---|---|---|
| `element_type` | Element type | "The software element is with wrong type (only cases not causing runtime failure)." (Ours:) in Python, includes type hints. | "The return annotation says `str` but the function returns bytes" |
| `immutable` | Immutable | "Not declaring variable to be immutable when it should have been or declaring it immutable when it should have not been." | "Use a tuple for this constant" |
| `visibility` | Visibility | "Software element (e.g. method, variable, class) has too much or too restricted visibility." | "This helper is internal; prefix it with an underscore" |
| `void_parameter` | Void parameter | "Using empty brackets instead of keyword 'void' as parameter." (Ours:) a C idiom with no Python counterpart, so this code is not expected to occur. | none possible in Python |
| `element_reference` | Element reference | "Referring to software element with incomplete name"; in M&L, all cases were a missing `this` for instance variables or methods. | "Refer to the class attribute as `cls.registry`, not through the module-level alias" |

**E-VIS, Visual representation.** "Defects hindering program readability for the human eye." Subtypes: M&L Table 8.

| Subtype | M&L row (Table 8) | Definition | Example claim (ours) |
|---|---|---|---|
| `bracket_usage` | Bracket usage | "Incorrect usage of brackets or braces." | "Add parentheses to make the precedence of `and` and `or` explicit" |
| `indentation` | Indentation | "Incorrect indentation." | "The continuation line is not aligned with the opening bracket" |
| `blank_line_usage` | Blank line usage | "Blank Line Usage is incorrect"; it "also included cases in which lines were split at incorrect positions." | "Two blank lines are needed before the class" |
| `space_usage` | Space usage | "The usage of the blank space character in the code." | "Add spaces around `=` in this assignment" |
| `grouping` | Grouping | "The grouping of code elements," so that closely related elements sit together; M&L Section 4.2.2 describes it as "the omission of blank lines to group logical code segments." | "Put the new helper next to the other parsing helpers" |
| `long_line` | Long line | "A long code statement was contained in an excessively long single line." | "This line exceeds the project's line length" |

**E-ORG, Structure, organization.** Structure "indicates the source code composition eventually parsed by the compiler into a syntax tree"; the organization subgroup "consists of defects that can be fixed by applying structural modifications to the software" (M&L Sections 4.2 and 4.2.3). Subtypes: M&L Table 10.

| Subtype | M&L row (Table 10) | Definition | Example claim (ours) |
|---|---|---|---|
| `move_functionality` | Move functionality | "The need to move functions, part of functions, or other functional elements to a different class, file, or module." | "Move this parsing into the form's `clean` method" |
| `long_subroutine` | Long subroutine | "Function, procedure or method is of excessive length and functionality." | "`handle()` is now 200 lines; split it" |
| `dead_code` | Dead code | "Code that is not executed or used in the software." | "The old branch below can never run" |
| `duplication` | Duplication | "Code that is duplicated." | "These two blocks are identical" |
| `complex_code` | Complex code | "A piece of code that is difficult to comprehend." | "This nested conditional can be flattened" |
| `statement_issues` | Statement issues | "These require splitting, combining or otherwise reorganizing a statement inside a function." | "Split this long boolean return into separate conditions" |
| `consistency` | Consistency | "The need to keep code consistent in a sense that similar code elements operate in a similar fashion and are more or less symmetrical." | "The other backends implement this method the other way round" |
| `other` | Others | "Other Organization defects." | "The new file is in the wrong package" |

**E-SOL, Structure, solution approach.** "Solution approach defects require an alternative implementation method"; they "are not about reorganizing existing code but rethinking the current solution and implementing it in a different way" (M&L Section 4.2.3). Subtypes: M&L Table 11.

| Subtype | M&L row (Table 11) | Definition | Example claim (ours) |
|---|---|---|---|
| `semantic_duplication` | Semantic duplication | "Syntactically different code blocks with equal intent"; in M&L it includes functionality "already implemented in some other place." | "`django.utils.text.slugify` already does this" |
| `semantic_dead_code` | Semantic dead code | "Code fragments that are executed, but they do not serve any meaningful purpose and/or have no effect on the result." | "This check can never fail, because the value was validated above" |
| `change_function` | Change function | "Need to change a certain function call to another when the program used old or deprecated functions." | "`assertEquals` is a deprecated alias; use `assertEqual`" |
| `use_standard_method` | Use standard method | "Defects where a standardized way of working should be used," such as "predefined constants rather than magic numbers." | "Use `HTTPStatus.NOT_FOUND` instead of the number 404" |
| `create_new_functionality` | Create new functionality | "Need of new functionality to ensure evolvability," such as new functionality or classes. | "Extract a helper so both views share this logic" |
| `minor` | Minor | "Implementation changes, but the defects are easier to fix and seemed less important than those categorized under Other." | "Return early instead of setting a flag" |
| `other` | Others | "A wide range of defects that truly represent the Alternative Approach in its most fruitful form"; M&L's examples include "a simpler and more efficient way" of keeping records and "caching numeric values rather than recomputing them." | "This could be cached instead of recomputed on every call" |

### 3.3 Not a Defect Claim (Class N)

Ours, adapted from Turzo and Bosu (2024, Table 1). M&L have no code for these; their Table 13 excludes test definitions from the defect types. Class N codes have no subtype: write `subtype: "none"`.

| Code | Name | Use when the finding | Example (ours) |
|---|---|---|---|
| N-TST | Test request | asks for tests, or says tests are missing or inadequate, without claiming a behaviour defect in the code | "No test covers the empty-string case" |
| N-QST | Question | asks for clarification and claims no defect | "Is the change to the default intentional?" |
| N-DSG | Design discussion | discusses design direction and claims no defect | "A setting might be a better home for this than a class attribute" |
| N-PRS | Praise | compliments the code | "Clean, minimal fix" |
| N-PRC | Process or scope note | concerns the patch as a submission (unrelated files, stray debug files, missing changelog) or the review itself (could not run tests) | "The patch adds an unrelated `reproduce.py` at the repository root" |
| N-UNC | Uncodable | its claim cannot be determined from the text | "See above" |

### 3.4 Quality Flag (All Classes)

`quality_flag` is one of `none`, `performance`, `security` or `compatibility`. It is recorded in addition to the type, for comparison with schemes that have separate performance and security types.
- A performance claim is typed F-LOG `alg` if it changes behaviour (for example a timeout), and E-SOL `other` otherwise. M&L place every inefficient algorithm under Logic, Algorithm/performance, and list more efficient alternatives under Solution approach, Others; the split by behavioural effect is ours.
- A security claim is typed by its mechanism (usually F-CHK `input`).
- A compatibility claim (an older Python, database or library version; a public API changed for existing callers) is typed by its mechanism (usually F-SUP `ver` or F-INT).

### 3.5 Multi-Claim Flag

`multi_claim` is `true` if the finding makes two or more distinct defect claims, each of which would need its own fix; only the first is coded. A claim and its consequence, or a claim and its evidence, are one claim.

## 4. Boundary Rules

M&L give no boundary rules. These are ours, fixed before coding, and they override the decision order in Section 2.

1. **Check vs Logic.** Code Check if the faulty or missing code exists to detect an invalid, special or exceptional value: a None, empty, type or range test, a try/except, a validation that raises. Code Logic if the faulty condition chooses between two valid behaviours.
   - "`parse_age(None)` raises AttributeError instead of a clear error" is Check `var`.
   - "Uses `replace` where `strip` is needed, so inner spaces are removed" is Logic `comp`.
2. **Logic or Check vs Larger defects: the pinpoint rule** (from M&L's "cannot be pinpointed").
   - Picture the smallest fix that would resolve the claim. If it changes or adds lines in one contiguous region of one function the patch already touches, the defect can be pinpointed: code Logic, Check, Resource or Interface.
   - If the fix needs new code in a function or file the patch did not touch, or a new code path for a whole case the issue describes that the patch never handles, code Larger defects `compl`.
   - If the claim is about code outside the patch, code Larger defects `outside`.
   - A finding that only says "does not fully implement the issue", without naming a case, is Larger defects `compl` with `unsure: true`.
3. **Check vs Larger defects.** A missing guard for one special value inside a path the patch handles is Check. A whole input category the patch never addresses (for example "tab characters are not handled at all", when the issue asks for all whitespace) is Larger defects `compl`.
4. **Resource vs Logic.** Code Resource if the claim is about *what state* is initialized, stored, mutated or released. Code Logic if it is about *how a value is computed or chosen*.
5. **Interface vs Logic.** Code Interface only if the claimed fix changes a call to another component or that call's arguments. Errors in the patch's own branching are Logic.
6. **Functional vs Test request.** "The tests don't cover X" is N-TST. "X is broken (and untested)" is functional.

## 5. Location and Reproduction

**Location** is computed by script (`artifact/analysis/location.ts`), not by coders. Each code is 0 or 1:
- `loc_file`: the location or problem text names a source path, or the basename of a file in the patch diff;
- `loc_line_or_function`: it gives a line number, or a function or method name that appears in the patch's changed lines or hunk headers;
- `loc_in_patch_files`: the named file is one the patch changes.

**Reproduction** is coded once per review in pass T, from the findings and the feedback together.
- **R2:** reports a concrete input and an observed output, or a command the reviewer ran and its result, showing the claimed defect.
- **R1:** reports running existing tests or a command, without an observed result tied to the claim.
- **R0:** code reading only.

## 6. Gold Behaviours

A gold behaviour is a statement of one defect that makes a wrong patch wrong, in three parts: TRIGGER (the input, state or call path that exposes it), EXPECTED (what the official fix does), and ACTUAL (what the patch does). Each names the code region the official fix changes for it, as `path::function`. Gold statements describe behaviour, not the patch's code, and never copy more than 10 consecutive words from the patch.

- **Test-based gold** (50 patches). Drafted from the issue, the official fix, the strengthened test diff (SWE-ABS), the failing tests (the union over the three label-check runs, with the number of runs each failed) and traceback excerpts. Tests that fail for the same underlying issue are merged into one behaviour: two tests share a behaviour if the same minimal change to the patch would make both pass.
- **Reading-based gold** (the five patches of rule L7). Drafted from the patch, the official fix and the issue text, plus the failing strengthened test where one exists (two of the five patches). TRIGGER is a concrete input on which the official fix is right and the patch is wrong, shown by tracing the input through both diffs. It is never speculative. The paper states that these five statements rest on reading the patch against the official fix, not on a failing test, and reports every RQ6 result also without these five patches.
- **Drafter:** Opus 5.5 at high effort (prompt G1). **Checker:** Sonnet 5.5 at high effort (prompt G2), which checks every draft and returns accept, revise (with full replacement text) or reject for each behaviour, plus any failing test the draft left out.
- **Settling a revise or reject.** The drafter sees the checker's reply once and accepts or rebuts each point. If the drafter rebuts, the checker sees the rebuttal once and holds or concedes. If the checker holds, the adjudicator (Section 10) decides, and the patch is flagged `contested`. A sensitivity analysis drops contested patches.
- A patch keeps at least one behaviour. If every behaviour of a patch would be removed, the patch goes to the adjudicator and is flagged `contested`.
- Gold is drafted and checked before any coder sees a review.

## 7. Right-Reason Scale (Passes M and A)

**Matching rule.** Adapted from ReviewBench's methodology, Section 6.2 (Zhou & Carderera de Diego, 2026). Two descriptions match "if they describe the same underlying issue, even if their messages, line ranges, or framing differ"; "two findings at the exact same location do not match if they describe different issues". The coder reasons about "what a minimal fix would look like".

Each (finding, gold behaviour) pair, and each (feedback, gold behaviour) pair, is scored 2, 1 or 0:

| Score | Rule |
|---|---|
| **2, same underlying issue** | The finding states the gold's triggering condition (input, state or path) and its wrong outcome, *or* states the direct code cause in a way that implies that condition. Test: the minimal fix that resolves the finding would also remove the gold behaviour (make the failing test pass; for reading-based gold, make the patch give the official fix's result on the gold's trigger). |
| **1, partial** | The right condition or the right code region, but the consequence is missing or wrong; or a generic claim ("may not handle X-type inputs") that covers the gold without stating it. |
| **0, other** | Anything else, including the same location with a different issue, and true claims about a different defect. |

- Different wording, line numbers or framing do not lower a score.
- Ignore the verdict and the review's stated confidence.
- A finding of any class, including class N, is scored on what it says.
- If two scores still fit after these rules, give the lower one and set `unsure: true`.
- A malformed review with no recovered finding is coded from its final message: the coder splits it into finding-like claims, as in pass T, and scores each claim as a finding.

**Worked examples** (the toy issue from [LABELS.md](../../../LABELS.md), never a study item). Issue: `parse_age(" 42 ")` raises; it should return 42. The patch is `return int(s.replace(" ", ""))`. Gold G1: for an input with an inner space, such as `"4 2"`, the official fix raises ValueError as before, but the patch returns 42.

| Finding | Score | Why |
|---|---|---|
| "`parse_age('4 2')` now returns 42 instead of raising" | 2 | same condition, same wrong outcome |
| "`replace` strips inner spaces too; use `strip`" | 2 | direct code cause; the same minimal fix |
| "`replace` is risky here; consider another approach" | 1 | right region, no consequence |
| "line 3 of `parse_age` needs attention" | 0 | location only |
| "negative ages are not rejected" | 0 | a different issue, which the official fix shares |

**Review-level codes** (pass M, derived by script from the pair scores):
- `named`: some finding scores 2 on some gold behaviour;
- `partial`: no 2, at least one 1;
- `other`: all findings 0;
- `no_codable_finding`: a malformed review with no recoverable claim.

The binary form treats `named` as 1 and everything else as 0. The sensitivity count treats 2 or 1 as named. Separately, `feedback_named` records the highest feedback score over the gold behaviours.

**Per-patch outcome** (each of the 55 wrong patches in each model and effort cell falls in exactly one):
1. rejected and named;
2. rejected, partial;
3. rejected for another reason (including no codable finding);
4. accepted, but the feedback scored 2 on some gold behaviour (seen but accepted);
5. accepted, defect not named.

**Primary right-reason result.** Per cell, k of 55 wrong patches rejected with a finding scored 2, reported as a plain share with a 95% Wilson interval (Wilson, 1927). The secondary result divides the same k by that cell's rejections of the 55. No metric name is used. The nearest published analogues are ReviewBench's grounded recall (Zhou & Carderera de Diego, 2026) and CR-Bench's Known-Defect Detection Rate (Pereira et al., 2026); neither name is adopted, because our gold comes from tests and reading, and our unit is the patch.

## 8. Pass C Codes (False Alarms and Decoys)

Pass C is label-blind: the 27 false alarms and 27 decoys are pooled and shuffled. The official fix is shown.

**Main finding.** The first listed finding, unless the feedback names another as decisive. For a malformed review with no recovered finding, the coder splits the final message into claims, as in pass T, and chooses among them; if there is none, the main finding is 0 and reality is `unverifiable`.

**(a) Reality of the main claim**, judged against the official fix's behaviour. Do not assume the official fix is perfect, but use its behaviour as the reference.

| Code | Meaning |
|---|---|
| `real_in_scope` | The claimed defect occurs, the issue covers it, and the official fix behaves correctly. |
| `real_shared` | It occurs, and the official fix behaves the same way (overlay O2 in [LABELS.md](../../../LABELS.md)). |
| `real_outside_issue` | It occurs but is outside what the issue asks, and the official fix does not share it. |
| `not_real` | The claimed behaviour does not occur. |
| `unverifiable` | Cannot be decided from the packet. |

If both `real_shared` and `real_outside_issue` fit, code `real_shared`.

**(b) Reason codes.** Each is a separate yes/no code; mark all that apply. They are applied only when (a) is not `real_in_scope`; otherwise all are no.

| Code | Meaning | Source |
|---|---|---|
| `false_positive_issue` | "an issue … that was actually misidentified" | Lin et al., 2026, Table 3 |
| `redundant` | asks for something the patch or the existing code already does | Lin et al., 2026 |
| `out_of_scope` | "beyond the objective" of the change | Lin et al., 2026 |
| `overcorrection` | demands more than the issue asks | Jin & Chen, 2026 |
| `environment_artifact` | the reviewer's own run failed for reasons unrelated to the patch | ours |
| `open` | a label of at most five words for a reason none of the above covers | open coding (Braun & Clarke, 2006) |

New open labels go to the Human before they appear in the paper.

**(c) Type of the main finding.** Taken from pass T; it is not recoded in pass C. For a claim recovered from a final message, the pass T claim with the same words supplies the type; if none matches, the type is reported as unlinked.

## 9. Pass A Codes (Accepted Wrong Patches)

Pass A codes the feedback of an accepting review only.
- `concern`, for all 290:
  - **C2:** the feedback names a specific functional concern, but the review passes;
  - **C1:** vague hedging only;
  - **C0:** none.
- `feedback_score` per gold behaviour (2, 1 or 0, as in Section 7), for all 290.
- If two concern codes still fit, give the lower one and set `unsure: true`.

## 10. Coders, Adjudication and Agreement

**Coders.** Coder A is Opus 5.5 at high effort and coder B is Sonnet 5.5 at high effort. Both code every item independently, without tools, in a fresh context per batch, from the same shuffled batches: 15 reviews per batch in passes T, M and A, and 9 in pass C. Each batch records the coder's model ID, effort, client version, date and batch ID.

**Adjudication.**
- The adjudicator is Opus 5.5 at medium effort, in a fresh context, blinded to which coder gave which code. The two codes are shown as X and Y in an order randomized per item, without coder or model names, and the order is logged.
- Every item where coders A and B disagree on a reported code goes to the adjudicator: class, type and subtype (settled together as one triple), quality flag and multi-claim (pass T); reproduction (pass T); each pair score of the deciding findings and the review-level code (pass M); reality and each reason code (pass C); concern and each feedback score (pass A). For pass M, the deciding findings are those that set the review-level code under either coder. The model guess is not adjudicated.
- Gold disputes that the drafter and checker do not settle (Section 6) go to the same adjudicator, with the two versions shown as X and Y.
- The adjudicator sees the item packet, this codebook, the pass instructions and the two codes with their reasons. It picks X or Y, or a third code only when it cites the codebook rule that rules out both. It does not split the difference.
- Every decision is logged per item, with the basis (X, Y or third) and the rule cited.

**Agreement.**
- Cohen's κ (Cohen, 1960) and Gwet's AC1 (Gwet, 2008) for every code, each with a bootstrap 95% CI, plus raw percent agreement, all computed before adjudication. The bootstrap resamples reviews, so findings stay clustered within their review.
- Codes covered: class, type and subtype, quality flag and multi-claim (T); reproduction (T); review-level match at three levels and binary, and feedback match (M); reality and each reason code (C); concern and feedback match (A).
- κ is interpreted with Landis and Koch (1977). Per-type agreement is also reported, because language-model coders do worst on rare M&L types (Nguyen et al., 2025).
- Decoys coded `real_in_scope` in pass C are compared with their pass M codes, descriptively.
- The accuracy of the pass T model guess is reported against chance (one in three).

**No human validation.** No co-author checks the gold, the codes or the adjudications. The paper says so in its threats to validity.

## 11. Crosswalk

Type level, for comparison only; nothing is coded twice.

| M&L (ours) | Beller et al. (2014) / SWR-Bench (Zeng et al., 2025) | Turzo and Bosu (2024) / Lin et al. (2026) | CR-Bench (Pereira et al., 2026), Beizer categories via M&L Table 12 |
|---|---|---|---|
| Resource | Resource / F.3 | Resource | Data |
| Check | Check / F.4 | Validation | no counterpart in M&L Table 12 (nearest: Structural) |
| Interface | Interface / F.1 | Interface | Interface, Integration and System |
| Logic | Logic / F.2 | Logical | Structural |
| Timing | not in Beller or SWR-Bench | Timing | Concurrency |
| Support | Support / F.5 | Support | no counterpart in M&L Table 12 |
| Larger defects | Larger defects / F.6 (SWR-Bench redefines F.6 as unmerged suggestions, so only the label matches) | Functional defect | Requirements, Features and Functionality |
| Textual | Textual / E.1.1 | Documentation; Naming convention | Coding |
| Supported by language | Language-supported / E.1.2 | Documentation (nearest) | Coding |
| Visual representation | Visual representation / E.2 | Visual representation | Coding |
| Organization | Organization / E.3.1 | Organization of the code | Coding |
| Solution approach | Solution approach / E.3.2 | Solution approach | Coding |
| N-TST Test request | E.3.2 (SWR-Bench files added tests there) | Testing (Lin only) | Test |
| N-QST, N-DSG, N-PRS | not coded (change-based schemes) | Question; Design discussion; Praise | none |
| Pass C `not_real` | removed in Beller | False positive | none |

Notes:
- Turzo and Bosu's "Alternate output" has no M&L counterpart; such findings are coded by their behavioural claim.
- The CR-Bench column is approximate and many-to-one, because CR-Bench uses Beizer's categories through a later source that we did not read. It is reported only for the type distribution, never per finding.

## References

Beller, M., Bacchelli, A., Zaidman, A., & Juergens, E. (2014). Modern code reviews in open-source projects: Which problems do they fix? In *Proceedings of the 11th Working Conference on Mining Software Repositories* (pp. 202–211). ACM. https://doi.org/10.1145/2597073.2597082

Braun, V., & Clarke, V. (2006). Using thematic analysis in psychology. *Qualitative Research in Psychology*, *3*(2), 77–101. https://doi.org/10.1191/1478088706qp063oa

Cohen, J. (1960). A coefficient of agreement for nominal scales. *Educational and Psychological Measurement*, *20*(1), 37–46. https://doi.org/10.1177/001316446002000104

Gwet, K. L. (2008). Computing inter-rater reliability and its variance in the presence of high agreement. *British Journal of Mathematical and Statistical Psychology*, *61*(1), 29–48. https://doi.org/10.1348/000711006X126600

Jin, H., & Chen, H. (2026). *Are LLMs reliable code reviewers? Systematic overcorrection in requirement conformance judgement* (arXiv:2603.00539). arXiv. https://doi.org/10.48550/arXiv.2603.00539

Landis, J. R., & Koch, G. G. (1977). The measurement of observer agreement for categorical data. *Biometrics*, *33*(1), 159–174. https://doi.org/10.2307/2529310

Lin, H. Y., Liang, M., Thongtanunam, P., & Tantithamthavorn, K. (2026). *Is agentic code review helpful? Mining developers' feedback to CodeRabbit reviews in the wild* (arXiv:2607.03316v2). arXiv. https://doi.org/10.48550/arXiv.2607.03316

Mäntylä, M. V., & Lassenius, C. (2009). What types of defects are really discovered in code reviews? *IEEE Transactions on Software Engineering*, *35*(3), 430–448. https://doi.org/10.1109/TSE.2008.71

Mäntylä, M. V., & Lassenius, C. (2013). *Code review defects* (Version 1) [Online appendix to Mäntylä & Lassenius, 2009]. figshare. https://doi.org/10.6084/m9.figshare.689805.v1

Nguyen, L., Liu, C., Lin, H. Y., & Thongtanunam, P. (2025). *Exploring the potential of large language models in fine-grained review comment classification* (arXiv:2508.09832). arXiv. https://doi.org/10.48550/arXiv.2508.09832

Pereira, K., Sinha, N., Ghosh, R., & Dutta, D. (2026). *CR-Bench: Evaluating the real-world utility of AI code review agents* (arXiv:2603.11078). arXiv. https://doi.org/10.48550/arXiv.2603.11078

Turzo, A. K., & Bosu, A. (2024). What makes a code review useful to OpenDev developers? An empirical investigation. *Empirical Software Engineering*, *29*, Article 6. https://doi.org/10.1007/s10664-023-10411-x

Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference. *Journal of the American Statistical Association*, *22*(158), 209–212. https://doi.org/10.1080/01621459.1927.10502953

Zeng, Z., Shi, R., Han, K., Li, Y., Sun, K., Wang, Y., Yu, Z., Xie, R., Ye, W., & Zhang, S. (2025). *SWR-Bench: Assessing LLM performance in real-world code review comment generation* (arXiv:2509.01494v2). arXiv. https://doi.org/10.48550/arXiv.2509.01494

Zhou, M., & Carderera de Diego, A. (2026, October 5). *ReviewBench: An open benchmark for AI code review*. The GitHub Blog. Methodology read at https://github.com/review-bench/ReviewBench/blob/ffcb8d304c1d25caac1dee656b07ae3c1170bf04/docs/METHODOLOGY.md
