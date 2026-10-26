# Evaluation set

[Docs index](../README.md) · [Intent cards](intent-cards.md) · [Pilots and gate](pilots-and-gate.md)

The evaluation set measures how good intent cards are before pilots rely on them: every prompt or risk-floor change runs against hand-labeled pull requests, and a committed synthetic set guards the floor in CI. The examples below use a fictional pilot (`acme`); replace the set path, repository, dates, installation ID, consent reference and labeler names with your own.

`pnpm eval <command>` measures the quality of the intent cards against hand-labeled pull requests and runs a synthetic set in CI. Nothing here changes the service: the tool lives in `src/eval/` and `src/bin/eval.ts`, never touches Graft's database and never writes into the repo (except the committed synthetic set and its baseline).

```sh
pnpm eval keygen                                   # new GRAFT_EVAL_KEY; keep it in the password manager, never in .env
export GRAFT_EVAL_KEY=...                          # the shell only
pnpm eval init --set ~/.graft-eval/pilot-acme --kind pilot --consent-ref "Acme agreement 2026-11-02" \
     --sensitive-paths 'services/billing/**'
pnpm eval export --set ~/.graft-eval/pilot-acme --repo acme/api --from 2026-06-01 --to 2026-09-30 \
     --auth app --installation-id 123 --sample 50 --dry-run      # drop --dry-run to write the cases
pnpm eval assign-double --set ~/.graft-eval/pilot-acme                # 20% (at least 20) get two labelers
pnpm eval label --set ~/.graft-eval/pilot-acme --as ada               # blind, interactive
pnpm eval agreement --set ~/.graft-eval/pilot-acme                    # Cohen's kappa; target risk >= 0.6
pnpm eval adjudicate --set ~/.graft-eval/pilot-acme --as judge
pnpm eval run --set ~/.graft-eval/pilot-acme                          # fake model: floor + a model that says "trivial"
pnpm eval run --set ~/.graft-eval/pilot-acme --live                   # the only way to reach the Anthropic API
pnpm eval purge --set ~/.graft-eval/pilot-acme --confirm pilot-acme   # when the pilot leaves
pnpm eval:ci                                       # the synthetic set against eval/baselines/synthetic.json
```

Run `pnpm eval` with no command for `run`; `pnpm eval frobnicate` prints the usage. Exit codes: 0 ok, 1 check failed, 2 usage or configuration error, 3 aborted (declined, over budget, rate-limit wait too long).

**Where the data lives.** A case set is a directory (`set.json`, `cases/`, and for pilots `cache/` and `runs/`). The committed synthetic set is `eval/synthetic/` (plaintext, fictional code only). A pilot set is `$GRAFT_EVAL_DIR/<setId>/` (default `~/.graft-eval`) and must be outside every git working tree: the tool walks up from the real path and refuses when it finds a `.git` entry. Files are written with mode 0600 and directories with 0700. Every file in a pilot set except `set.json` and the reports is a sealed AES-256-GCM envelope (`node:crypto`; a fresh random IV per write; the authentication tag is verified before any plaintext is returned; the AAD is `<setId>/<relative path>`, so a file moved to another set or renamed does not open). `GRAFT_EVAL_KEY` is the base64 of 32 random bytes; `set.json` stores only the first 8 hex characters of its SHA-256, to detect a wrong key early. Creating a pilot set needs `--consent-ref`, and `export` refuses a set without one. `purge` deletes the directory and appends `{setId, purgedAt, caseCount, by}` to `purge-log.jsonl`.

**Reports carry no code.** `report.json` and `report.md` (written to `<set>/runs/<runId>/`, or `--out`) hold case ids, classes, rule ids, counts, booleans, tokens and cost, never paths, titles, bodies, diffs or model prose. `pnpm eval show --set <dir> --case <id>` is the local way to read a case; everything it prints goes through `toTerminalSafe` because PR text may hold terminal escape sequences.

**Live runs.** `--live` needs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (with `ANTHROPIC_BASE_URL` for a gateway) or the federation variables; every model must have a price in `src/eval/pricing.ts`, so a gateway model ID such as `anthropic/claude-sonnet-5.5` needs an entry first. With a [provider registry](../configuration.md#model-providers) (`GRAFT_LLM_PROVIDERS` or `GRAFT_LLM_PROVIDERS_FILE`, read with the same rules as the server), `--live` calls the providers its roles name instead, and every role's model needs a price: the built-in table for `anthropic` providers, or the entry's `prices` (`{ input: 0, output: 0 }` for a local model). That is how a new model is checked against the saved baseline before it goes into a role. Without `--live` the key is ignored and no client is built. Before the first call the tool prints an upper-bound estimate and asks `Continue? [y/N]` (`--yes` skips the question; without a terminal and without `--yes` it exits 3). It refuses an estimate above `--max-cost-usd` (default 10), starts a case only if the money and tokens spent so far plus the estimate stay under `--max-cost-usd` and `--max-tokens` (the rest are `skipped_budget` and the report says `complete: false`), and caches results by (inputs, prompt fingerprint) in `<set>/cache/`. Prices are in `src/eval/pricing.ts` (`PRICING_VERIFIED_AT`); check them before a live run.

**Updating the synthetic baseline.** `pnpm eval:ci` compares the whole fake-model report (metrics and per-case rows) with `eval/baselines/synthetic.json` and checks `eval/thresholds.json`. A change to the floor, `combineRisk` or a synthetic case shows up as a diff; when it is intended, run `pnpm eval run --set eval/synthetic --save-baseline eval/baselines/synthetic.json` in the same pull request. The JSON Schemas in `eval/schema/` are generated from the zod schemas (`pnpm eval schema --write`) and a test fails when they drift. The labeling guide is `docs/phase-0/labeling-guide.md`.

The labeling guide is [docs/phase-0/labeling-guide.md](../phase-0/labeling-guide.md).

## Related

- Configuration: `GRAFT_EVAL_DIR`, `GRAFT_EVAL_KEY`, `GRAFT_EVAL_GITHUB_TOKEN`, `GRAFT_EVAL_DEBUG` in [configuration.md](../configuration.md#tool-and-shell-only-variables).
- Redaction rules, report and export details: [decisions.md, step 4](../decisions.md#step-4-evaluation-set).
- The step spec: [docs/phase-0/step-4-evaluation-set.md](../phase-0/step-4-evaluation-set.md).
