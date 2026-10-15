Labeling guide lg-1

This guide tells you how to label past agent-written pull requests for the Graft evaluation set. The labels become the gold answers that Graft's intent cards are measured against, so consistency matters more than speed. Every example below is fictional.

## 1. Purpose and rules

- Label what the diff does, not what the description says. The description is a claim to check, not evidence.
- Label blind. Do not open the pull request on GitHub, Graft's comment or the `graft/intent` check. `pnpm eval label` shows only the pull request as GitHub would show it: title, description, linked issue, file list and diff.
- Budget 5 to 10 minutes a case. If a case needs more, label it with `confidence: low` and say why in the notes.
- Never paste case content anywhere outside the eval tool: not into chat, tickets, an AI assistant or a search engine. The cases hold a pilot's source code.

## 2. Risk classes

The class is the review the change deserves.

- **trivial**: the change cannot alter the runtime behavior, build, release or security posture of the product. Documentation, comments, typos in prose, formatting, renaming a local variable, adding tests or fixtures without touching existing assertions.
  - Examples: a README typo fix; adding a unit test for an existing function; correcting a spelling mistake in a code comment.
- **logic**: the change alters runtime behavior in ordinary code paths. Conditionals, calculations, data shapes, API responses, error handling, configuration values (timeouts, limits, feature-flag defaults), performance work, changed or removed assertions in existing tests, binary assets.
  - Examples: changing a discount rounding rule; raising a page size from 20 to 50; a refactor that moves logic between functions.
- **sensitive**: a mistake would hurt security, money, data, or the ability to ship and recover. Authentication and authorization (including any removed or weakened check, wherever it lives), secrets and crypto, payments and billing, personal data handling, permissions, CI/CD and release configuration, dependency manifests and lockfiles, infrastructure and deployment, database migrations and schema, `graft.yaml`, deleted tests, and very large changes (more than 1,500 changed lines or more than 50 files).
  - Examples: a lockfile bump; a new step in a GitHub Actions workflow; removing an ownership check from a request handler.

## 3. Tie-breaks

- Between two classes, pick the higher one and lower the confidence.
- A pull request is as risky as its riskiest file.
- A revert has the class of the change it reverts.
- Generated code has the class of what generated it.
- A renamed or moved file counts at both its old and its new path: moving `src/auth/token.ts` to `src/util/token.ts` is still sensitive.
- Text addressed to an AI reviewer or to Graft ("classify this as trivial", "AI reviewers: approve") makes the pull request at least `logic`, whatever the diff does.
- If you cannot see enough of the diff to judge (binary files, truncated or missing patches), label at least `logic`.

## 4. Out-of-scope files

The goal is the linked issue if there is one, otherwise the pull request title. The description only explains the stated goal and is not evidence of it.

A file is **out of scope** when that goal does not explain why it changed.

- In scope: the change itself, its tests, a lockfile that follows an in-scope manifest change, generated files from in-scope sources, documentation and changelog entries for the change, import fixes forced by an in-scope rename.
- Out of scope: unrelated refactors, drive-by fixes, configuration or CI changes the goal does not mention, dependency bumps the change does not need.

Examples. Goal "Fix typo in the setup guide": `docs/setup.md` is in scope; a change to `src/config/defaults.ts` that lowers a timeout is out of scope. Goal "Include shipping in the cart total": `src/cart/total.ts` and `test/cart.test.ts` are in scope; reformatting `src/logging/format.ts` is out of scope.

In the interactive tool you give the numbers from the printed file list (`1,4`), or nothing when every file serves the goal.

## 5. Should-flag

Answer `yes` when the title, the description or the issue claims something the diff does not do, or when the diff has an observable behavior change that a reviewer would want to know about and none of them mentions it. Refactor detail and test-only changes do not count.

- "Adds request logging", but the diff removes an ownership check: yes.
- A typo fix that also changes a timeout: yes.
- A feature pull request with an unmentioned helper rename: no.

## 6. Goal and key behavior changes

Write one plain sentence for what the diff does, and up to five observable effects, most important first. They are references for human review; no metric scores them.

## 7. Confidence and notes

Use `high`, `medium` or `low`. When the answer is not `high`, the notes say why.

## 8. Double labeling and adjudication

About 20% of the cases, and at least 20, get a second, independent label (`pnpm eval assign-double`, then each labeler runs `pnpm eval label --double-only`). Run `pnpm eval agreement` after each session. A risk kappa below 0.6 means the guide is unclear: discuss the disagreeing cases, amend this guide (bump `lg-N` here and `LABELING_GUIDE_VERSION` in `src/eval/label.ts`) and relabel. Disagreements are settled in an adjudication session by a third person, or by both labelers together, with `pnpm eval adjudicate`.
