# MonetizeKit org defaults & reusable workflows

Central home for org-wide GitHub configuration:

- `.github/workflows/reusable-sdk-ci.yml` — shared CI for SDK packages (commitlint advisory, lint/typecheck/test/build, package-entry guard, install smoke). Callers define their own `Required Checks Gate` aggregation job so branch-protection contexts stay stable.
- `.github/workflows/reusable-sdk-release.yml` — shared Changesets release with npm provenance. Callers pass `permissions: {contents: write, pull-requests: write, id-token: write}` and `secrets: inherit`.
- `.github/workflows/reusable-pr-review.yml` — shadow-mode Claude PR reviewer (four batched lenses, schema-validated findings, one advisory comment). Callers invoke it with `continue-on-error: true` and `secrets: inherit`, outside their `Required Checks Gate`. It reads the caller's `REVIEW.md` when present and resolves its model from `agent-policy.json`.
- `.github/workflows/reusable-stage-gate.yml` + `scripts/stage-gate/evaluate.mjs` + `schemas/stage-gate.schema.json` — publishes `Stage Gate / <stage>` on a stage head by aggregating every observing loop declared in the caller's `.github/stage-gate.json` (check runs on the head, nightly workflow runs with a soak, fleet branch heads, drift-clear). Required signal failed → red; not reported → in progress; advisory signals never gate. Observer verdicts are never read from check runs: a `check-run`/`branch-head` signal is the job named `name` in the newest run of exactly the signal's declared `workflow` path for the stage SHA (`?head_sha=`), from this repository's own code, not a pull request; a workflow with no such run or job for the SHA is not reported; `workflow-run` observers count only runs of their path on the target repository's default branch. The verdict is minted only from the caller's default branch (config read from there too; other refs evaluate without publishing) and the evidence artifact is named `stage-gate-<stage>-<sha>-<conclusion>`, which is what the promoter reads. Runbook: [`docs/engineering/stage-gate.md`](https://github.com/MonetizeKit/app-monetizekit-monorepo/blob/main/docs/engineering/stage-gate.md).
- `.github/workflows/reusable-promote.yml` + `scripts/promote/run.mjs` — one hop of the promotion chain, read from the stage gate and nothing else: `development -> delivery` opens/updates the promotion PR and enables auto-merge when `Stage Gate / development` is green; `delivery -> main` opens/updates a prepared PR (changelog draft, loop-by-loop gate evidence, review findings across the included feature PRs) when `Stage Gate / delivery` is green plus an optional soak (counted from when the head landed on the branch), and never merges. The verdict is not read from the check run (any workflow with `checks: write` can mint one) but from the newest run of the caller's `gate_workflow` (default `.github/workflows/stage-gate.yml`) on the default branch, from this repository, that uploaded a `stage-gate-<stage>-<sha>-<conclusion>` artifact for this head; the check run is quoted for humans only. Callers grant `actions: read` and pass `source`, optionally `soak_minutes`, `changelog_command`, `dry_run`, and the `GH_PAT` secret so the PR's own CI runs. Runbook: [`docs/engineering/promotion.md`](https://github.com/MonetizeKit/app-monetizekit-monorepo/blob/main/docs/engineering/promotion.md).
- `.github/workflows/reusable-promotion-guard.yml` + `scripts/promote/guard.mjs` — the `promotion-guard` check on PRs into `delivery`/`main`: passes only when the head is the upstream stage (`development` → `delivery`, `delivery` → `main`) **and lives in this repository** — a fork branch merely named `development` fails; a `promotion-override` label passes an audited same-repository hotfix with a warning. Add it to branch protection on both branches.
- `agent-policy.json` + `schemas/agent-policy.schema.json` — the single source of truth for every agent role in the fleet: provider, pinned model ID, fallback, gateway route, budget, allowed tools, data classes, autonomy tier per environment, quorum, human gate, owner, review date. Workflows resolve model IDs from here; a contract test in the monorepo fails on any model ID outside the policy.
- `schemas/review-findings.schema.json` — the deterministic finding shape emitted by the shadow reviewer and the stage review.
- `schemas/metrics-policy.json` — reviewer burn-in thresholds (min PRs, acceptance rate, false-block rate) consumed by the SDLC metrics loop to graduate lenses from shadow to gate.
- `ops/metrics-baseline.json` — SDLC baseline metrics captured 2026-08-15, before the pipeline changes landed. The continuous successor is the SDLC metrics loop in the monorepo.
- `PULL_REQUEST_TEMPLATE.md` — org default PR template.
- `profile/README.md` — org profile.

## SDLC plan

The assessment, promotion chain, loop inventory, tranches and indicators for
the AI-native SDLC live in the monorepo:
[`docs/engineering/ai-native-sdlc-plan.md`](https://github.com/MonetizeKit/app-monetizekit-monorepo/blob/main/docs/engineering/ai-native-sdlc-plan.md).
Agent roles and delegation are explained in
[`docs/engineering/agent-delegation-architecture.md`](https://github.com/MonetizeKit/app-monetizekit-monorepo/blob/main/docs/engineering/agent-delegation-architecture.md).

## Versioning

Consumers pin by tag: `MonetizeKit/.github/.github/workflows/reusable-sdk-ci.yml@v1`.
Rollback across the fleet = re-point the `v1` tag; individual repos can pin a SHA.
`agent-policy.json` is fetched by callers from the same `v1` tag, so a policy
change becomes effective fleet-wide when `v1` moves.

## Adoption order (canary rule)

types → embed → node/cli/react → design-system → apps. Each repo adopts via its own PR that must pass the existing `Required Checks Gate`.
