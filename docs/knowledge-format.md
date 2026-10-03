# Knowledge format

What a precedent contains, how it is identified and versioned, and how to write one that stays useful.

Precedents and candidates are stored as rows in the SQLite database in your data folder (`runtime/precedent-loop.sqlite`). The database is the only original copy; there are no knowledge files to edit by hand. All changes go through candidates and your review in the Hub.

## Types

| Type | Use it for |
|---|---|
| `MEMORY` | One reusable judgment: a decision, a root cause, a lesson, a pitfall |
| `SKILL` | A verified, repeatable procedure: trigger, prerequisites, steps, verification, when to stop |
| `DOCUMENT` | Reference material with natural sections |

When in doubt, use `MEMORY`.

## Scopes

- **`WORKSPACE`** — knowledge about one registered project. This is the default.
- **`GLOBAL`** — knowledge that is useful in a completely different project *and* can be stated without this project's name, paths or domain terms.

If a piece of knowledge touches both, split it into a global precedent and a project one.

## Fields

| Field | Rule |
|---|---|
| Title | 1–300 characters |
| Summary | 1–4,000 characters; should agree with the conclusion in the body |
| Retrieval terms | 3–16 terms, each 2–64 characters, compared without regard to case, duplicates removed. No line breaks or sentence punctuation (`。！？；，、` or `; ! ?`), and no trailing `.`. |
| Body | Markdown, up to 256,000 bytes |

Type and scope are fixed when a precedent is created. A revision keeps them; a different type or scope needs a new candidate.

### Retrieval terms

Recall matches each query as a literal, case-insensitive substring. A match in the title ranks highest, then the summary or retrieval terms, then the body. Retrieval terms are the words someone would use to look for this precedent later:

- code identifiers: class, table, endpoint, error code or file names;
- the domain names people actually use, synonyms and abbreviations.

Prefer specific identifiers or compound terms such as `currentVersion`, `candidate_update` or `候选版本冲突`. Avoid lone common words (`current`, `operator`, `PENDING`) and words shared by many precedents: they match short, generic queries and push more relevant items out of the 8-item recall budget.

## Identity, numbers and versions

- Each precedent has an ID made of `ast` followed by digits, and a **knowledge number** shown in the Hub. Each candidate has a `cnd` ID and is shown as **candidate #N**. Numbers are never reused.
- Every accepted revision increases the precedent's version. The database keeps the current content and the previous version, and the Hub shows the difference between them.
- A revision candidate is bound to the version it was prepared from. If the precedent changes before you accept, the candidate must be prepared again.

## Candidates

A candidate is either **new** knowledge or a **revision** of an existing precedent. Its status is one of:

| Status | Meaning |
|---|---|
| Pending (待处理) | Waiting for your review |
| Deferred (已暂存) | Set aside; you can come back to it |
| Accepted | Published as a precedent or applied as a revision |
| Rejected | Not used; the approved precedent is unchanged |

A precedent can have at most one pending or deferred candidate at a time. Changes on the same topic are merged into that candidate. Candidates are never returned by recall. See [Review workflow](review-workflow.md).

## Deletion

Deleting a precedent in the Hub marks it as deleted. It disappears from recall, reads and Hub lists, while recall and usage history are kept. Deletion is refused while the precedent has a pending or deferred candidate. There is no restore action.

## Writing good precedents

A precedent should make sense on its own, months later, to an agent that has never seen the original conversation. It should answer:

- **What is the conclusion?** Say whether it is a rule, a historical observation, or how something was implemented at a certain point.
- **When does it apply?** Project, environment, preconditions — and the main cases where it does not.
- **Why?** The reasons and the cost of the choice. Do not invent alternatives that were never considered.
- **What supports it?** What was actually verified, how, and what was not. Keep only the smallest excerpt that lets someone check the judgment; label excerpts, paraphrases, inferences and examples as such.
- **What must be re-checked before reusing it?** The few facts that decide whether it still holds.

Do not record workflow states that change quickly, such as "pending merge", "uncommitted", "not installed", "awaiting release", build IDs or the current branch. Write implementation and verification status as dated, checkable facts, for example "implemented on 2026-10-04 in commit abc1234".

A quick test: hide every link, path and line number in the text. If the conclusion, conditions and reasons still make sense, the precedent is self-contained. If all that is left is "see file X", fill in the meaning.

Suggested body structure for a `MEMORY`:

```markdown
## Conclusion and when it applies
## Reasons and trade-offs
## Evidence and verification
## Re-check before reuse
```

Merge or drop sections that do not apply. `SKILL` bodies follow trigger → prerequisites → steps → verification → stop conditions. `DOCUMENT` bodies use whatever sections suit the material.

The full content rules that agents and the AI import follow are in the [knowledge content model](../apps/server/resources/knowledge-content-model.md).
