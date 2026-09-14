# MonetizeKit org defaults & reusable workflows

Central home for org-wide GitHub configuration:

- `.github/workflows/reusable-sdk-ci.yml` — shared CI for SDK packages (commitlint advisory, lint/typecheck/test/build, package-entry guard, install smoke). Callers define their own `Required Checks Gate` aggregation job so branch-protection contexts stay stable.
- `.github/workflows/reusable-sdk-release.yml` — shared Changesets release with npm provenance. Callers pass `permissions: {contents: write, pull-requests: write, id-token: write}` and `secrets: inherit`.
- `.github/workflows/reusable-pr-review.yml` — shadow-mode Claude PR reviewer (four batched lenses, schema-validated findings, one advisory comment). Callers invoke it with `continue-on-error: true` and `secrets: inherit`, outside their `Required Checks Gate`. It reads the caller's `REVIEW.md` when present and resolves its model from `agent-policy.json`.
- `.github/workflows/reusable-promote.yml` — stage promotion (`development -> delivery` auto-merge when the stage gate is green; `delivery -> main` agent-prepared, human-approved PR). Callers pass the stage pair and gate check name.
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
