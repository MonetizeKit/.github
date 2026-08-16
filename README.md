# MonetizeKit org defaults & reusable workflows

Central home for org-wide GitHub configuration:

- `.github/workflows/reusable-sdk-ci.yml` — shared CI for SDK packages (commitlint advisory, lint/typecheck/test/build, package-entry guard, install smoke). Callers define their own `Required Checks Gate` aggregation job so branch-protection contexts stay stable.
- `.github/workflows/reusable-sdk-release.yml` — shared Changesets release with npm provenance. Callers pass `permissions: {contents: write, pull-requests: write, id-token: write}` and `secrets: inherit`.
- `PULL_REQUEST_TEMPLATE.md` — org default PR template.
- `profile/README.md` — org profile.
- `ops/metrics-baseline.json` — SDLC baseline metrics captured 2026-08-15, before the Phase 1 pipeline changes landed (see the SDLC remediation plan). Used to prove value of the agentic-delivery rollout.

## Versioning

Consumers pin by tag: `MonetizeKit/.github/.github/workflows/reusable-sdk-ci.yml@v1`.
Rollback across the fleet = re-point the `v1` tag; individual repos can pin a SHA.

## Adoption order (canary rule)

types → embed → node/cli/react → apps. Each repo adopts via its own PR that must pass the existing `Required Checks Gate`.
