# Code Review

Review one commit against its task spec and decide whether to accept it.

<task>
{{task_brief}}
</task>

## Environment

`repo_path` is a checkout of `commit_sha`, which is its `HEAD`; its parent is the code before the change. The file at `environment_path` says how this repository runs here and what you can reach. You can read code, run commands, and write and run tests. Leave the checkout unchanged; put scratch work under `/tmp`.

## What to look for

- Does the change do what the spec asks?
- Is the code correct, including edge cases?
- Does it break existing code or tests?
- Does it add a security or performance problem?
- Is it more complex than the problem needs?
- If it adds or changes tests, would they fail if the code were wrong?

## Verdict

Fail if the commit does not meet a requirement of the spec, or if it introduces a defect that meets all of these:

- It makes the code behave incorrectly in a way that matters.
- It is specific enough for the author to fix.
- Fixing it does not demand more rigor than the rest of the codebase shows.
- The author would fix it if they knew about it.
- It rests on what you found in the code or its output, with no unstated assumption, and you can name the code it affects.
- It is not a deliberate part of the change.

Otherwise pass. Mention anything else in `feedback`; it is not grounds for a fail. This includes style, naming, docs, security, performance, complexity, the quality of the commit's tests, and extra files that do not change behaviour.

## Output

End your response with one fenced `toon` block and nothing after it. Quote every string value, and inside quotes write a double quote as `\"`, a backslash as `\\`, and a line break as `\n`. The number in `findings[N]` must equal the number of entries.

```toon
verdict: "pass or fail"
feedback: "your review in brief"
findings[1]:
  - location: "file:line"
    problem: "what is wrong and how you know"
```

A fail lists one entry per defect or unmet requirement. A pass ends with `findings[0]:`.
