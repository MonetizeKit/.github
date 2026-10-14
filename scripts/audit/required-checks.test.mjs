// node --test scripts/audit/
import { test } from "node:test";
import assert from "node:assert/strict";

import YAML from "yaml";

import { GITHUB_ACTIONS_APP_ID, auditBranch, emittersOf, normaliseExpression, parseUses, triggersOf, uncheckedNeeds } from "./required-checks.mjs";

const REPO = "MonetizeKit/app-monetizekit-monorepo";
const pinned = (context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID });
const wf = (path, source) => ({ path, workflow: YAML.parse(source) });
const codes = (findings, level = "error") => findings.filter((finding) => finding.level === level).map((finding) => finding.code).sort();

// The monorepo's ci.yml before the event split: a deployment_status trigger,
// an event-conditioned gate, and a need the gate script never reads.
const OLD_CI = wf(".github/workflows/ci.yml", `
name: CI
on:
  push:
    branches: [main]
  pull_request:
  deployment_status:
  schedule:
    - cron: "0 6 * * *"
jobs:
  lint:
    if: \${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  required-interactive-delivery:
    name: Required Interactive Delivery Gate
    if: \${{ always() && github.event_name == 'deployment_status' }}
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  required-checks:
    name: Required Checks Gate
    runs-on: ubuntu-latest
    if: \${{ always() && (github.event_name == 'pull_request' || github.event_name == 'push') }}
    needs: [lint, required-interactive-delivery]
    steps:
      - run: check_result "lint" "\${{ needs.lint.result }}"
`);

const NEW_CI = wf(".github/workflows/ci.yml", `
name: CI
on:
  push:
    branches: [main, delivery, development]
  pull_request:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  required-checks:
    name: Required Checks Gate
    runs-on: ubuntu-latest
    if: \${{ always() }}
    needs: [lint]
    steps:
      - run: check_result "lint" "\${{ needs.lint.result }}"
`);

const PREVIEW = wf(".github/workflows/preview-e2e.yml", `
name: Preview E2E
on:
  deployment_status:
  workflow_dispatch:
jobs:
  paired:
    if: \${{ github.event.deployment_status.state == 'success' }}
    uses: ./.github/workflows/ci-interactive-delivery.yml
  preview-gate:
    name: >-
      \${{
        (github.event.deployment_status.state == 'success' &&
         github.event.deployment_status.environment == 'Preview – app.monetizekit.web')
        && 'Preview Gate' || 'Preview E2E (not gating)'
      }}
    runs-on: ubuntu-latest
    if: >-
      \${{
        always() &&
        (github.event.deployment_status.state == 'success' &&
         github.event.deployment_status.environment == 'Preview – app.monetizekit.web')
      }}
    needs: [paired]
    steps:
      - env:
          RESULT: \${{ needs.paired.result }}
        run: test "$RESULT" = success
`);

const PROMOTE = wf(".github/workflows/promote.yml", `
name: Promote
on:
  pull_request:
    branches: [delivery, main]
  schedule:
    - cron: "15 * * * *"
jobs:
  guard:
    name: promotion-guard
    if: github.event_name == 'pull_request'
    uses: MonetizeKit/.github/.github/workflows/reusable-promotion-guard.yml@v1
`);

test("triggersOf reads mapping, list and scalar forms", () => {
  assert.deepEqual(triggersOf(YAML.parse("on: push")), ["push"]);
  assert.deepEqual(triggersOf(YAML.parse("on: [push, pull_request]")), ["push", "pull_request"]);
  assert.deepEqual(triggersOf(YAML.parse("on:\n  pull_request:\n  schedule: []")), ["pull_request", "schedule"]);
  assert.deepEqual(triggersOf({}), []);
});

test("normaliseExpression strips the wrapper and collapses whitespace", () => {
  assert.equal(normaliseExpression("${{ always() }}"), "always()");
  assert.equal(normaliseExpression("always()"), "always()");
  assert.equal(normaliseExpression(" ${{\n  always() &&\n  x }}\n"), "always() && x");
  assert.equal(normaliseExpression(undefined), "");
});

test("the pre-split monorepo ci.yml is flagged: foreign triggers, an event-conditioned gate, an unread need", () => {
  const findings = auditBranch({ repo: REPO, branch: "development", required: [pinned("Required Checks Gate")], workflows: [OLD_CI] });
  assert.deepEqual(codes(findings), ["foreign-trigger", "skippable", "unchecked-need"]);
  assert.match(findings.find((finding) => finding.code === "foreign-trigger").detail, /deployment_status, schedule/);
  assert.match(findings.find((finding) => finding.code === "unchecked-need").detail, /required-interactive-delivery/);
});

test("the split ci.yml, the Preview Gate and the promotion guard pass", () => {
  const promotionGuard = { name: "promotion-guard", "runs-on": "ubuntu-latest", steps: [{ run: "node guard.mjs" }] };
  const findings = auditBranch({
    repo: REPO,
    branch: "delivery",
    required: [pinned("Required Checks Gate"), pinned("Preview Gate"), pinned("promotion-guard / promotion-guard")],
    workflows: [NEW_CI, PREVIEW, PROMOTE],
    innerJobOf: () => promotionGuard,
  });
  assert.deepEqual(findings, []);
});

test("a gate without if: always() is skipped when a need fails, and that skip satisfies the ruleset", () => {
  const ci = wf("ci.yml", "on: [pull_request]\njobs:\n  a: { runs-on: x, steps: [] }\n  gate:\n    name: Required Checks Gate\n    needs: [a]\n    runs-on: x\n    steps: [{ run: 'echo ${{ needs.a.result }}' }]\n");
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "main", required: [pinned("Required Checks Gate")], workflows: [ci] })), ["skippable"]);
});

test("a conditionally named job must be bound to its own condition and run whenever it holds", () => {
  const unbound = wf("p.yml", `on: [deployment_status]\njobs:\n  g:\n    name: \${{ github.event_name == 'x' && 'Preview Gate' || 'Preview Gate' }}\n    if: \${{ always() && github.event_name == 'x' }}\n    runs-on: x\n    steps: []\n`);
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "development", required: [pinned("Preview Gate")], workflows: [unbound] })), ["conditional-name"]);
  const skippable = wf("p.yml", `on: [deployment_status]\njobs:\n  g:\n    name: \${{ github.event_name == 'x' && 'Preview Gate' || 'Preview E2E (not gating)' }}\n    if: \${{ github.event_name == 'x' }}\n    runs-on: x\n    steps: []\n`);
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "development", required: [pinned("Preview Gate")], workflows: [skippable] })), ["skippable"]);
});

test("a required context nobody emits warns (fail-closed); more than one emitter is an error", () => {
  const orphan = auditBranch({ repo: REPO, branch: "main", required: [pinned("Preview Gate")], workflows: [NEW_CI] });
  assert.deepEqual(codes(orphan), []);
  assert.deepEqual(codes(orphan, "warning"), ["no-emitter"]);
  const twin = wf(".github/workflows/other.yml", "on: [pull_request]\njobs:\n  g:\n    name: Required Checks Gate\n    if: always()\n    runs-on: x\n    steps: []\n");
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "main", required: [pinned("Required Checks Gate")], workflows: [NEW_CI, twin] })), ["multiple-emitters"]);
});

test("a stage branch that requires nothing is ungated; a non-stage branch is not judged", () => {
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "development", required: [], workflows: [NEW_CI] })), ["ungated-branch"]);
  assert.deepEqual(auditBranch({ repo: REPO, branch: "feat/x", required: [], workflows: [NEW_CI] }), []);
});

test("unpinned contexts warn; contexts pinned to another integration are that integration's business", () => {
  const unpinned = auditBranch({ repo: REPO, branch: "main", required: [{ context: "Required Checks Gate" }], workflows: [NEW_CI] });
  assert.deepEqual(codes(unpinned), []);
  assert.deepEqual(codes(unpinned, "warning"), ["unpinned"]);
  assert.deepEqual(auditBranch({ repo: REPO, branch: "main", required: [{ context: "Vercel", integration_id: 8329 }], workflows: [NEW_CI] }), []);
});

test("a reusable caller is judged by the called job: missing, or skippable inside the called workflow", () => {
  const required = [pinned("promotion-guard / promotion-guard")];
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "delivery", required, workflows: [PROMOTE], innerJobOf: () => null }), "warning"), ["no-emitter"]);
  const gated = { name: "promotion-guard", needs: ["setup"], "runs-on": "x", steps: [{ run: "echo ${{ needs.setup.result }}" }] };
  assert.deepEqual(codes(auditBranch({ repo: REPO, branch: "delivery", required, workflows: [PROMOTE], innerJobOf: () => gated })), ["skippable"]);
  // A skipped caller is reported as "promotion-guard" alone, so its schedule trigger cannot satisfy the context.
  assert.equal(emittersOf("promotion-guard", [PROMOTE]).length, 0);
});

test("uncheckedNeeds accepts blanket reads of every need", () => {
  assert.deepEqual(uncheckedNeeds({ needs: ["a", "b"], steps: [{ run: "echo ${{ toJSON(needs) }}" }] }), []);
  assert.deepEqual(uncheckedNeeds({ needs: ["a", "b"], steps: [{ if: "contains(needs.*.result, 'failure')" }] }), []);
  assert.deepEqual(uncheckedNeeds({ needs: "a", steps: [] }), ["a"]);
});

test("parseUses resolves local and cross-repository reusable workflows", () => {
  assert.deepEqual(parseUses("./.github/workflows/x.yml", { repo: REPO, ref: "development" }), { repo: REPO, path: ".github/workflows/x.yml", ref: "development" });
  assert.deepEqual(parseUses("MonetizeKit/.github/.github/workflows/reusable-promotion-guard.yml@v1", { repo: REPO, ref: "main" }), { repo: "MonetizeKit/.github", path: ".github/workflows/reusable-promotion-guard.yml", ref: "v1" });
  assert.equal(parseUses("actions/checkout@v4", { repo: REPO, ref: "main" }), null);
});
