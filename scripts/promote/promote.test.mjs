// node --test scripts/promote/
import { test } from "node:test";
import assert from "node:assert/strict";

import { guardDecision, OVERRIDE_LABEL, UPSTREAM } from "./guard.mjs";
import {
  DEFAULT_GATE_WORKFLOW,
  HOPS,
  PROMOTION_MARKER,
  gateProvenance,
  gateRunId,
  gateState,
  includedPullNumbers,
  latestCheckRun,
  promote,
  promotionTitle,
  renderBody,
  reviewFindingsFromComments,
} from "./run.mjs";

const NOW = Date.parse("2026-09-15T06:00:00Z");
const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const REPO = "MonetizeKit/app-monetizekit-monorepo";
const GATE_RUN_ID = "9001";
const LANDED_AT = "2026-09-14T22:00:00Z";

function fakeApi(routes, { failAutoMerge = null } = {}) {
  const calls = [];
  return {
    calls,
    usesWriteToken: true,
    async getJson(repo, route, params = {}) {
      calls.push({ method: "GET", repo, route, params });
      const handler = routes[`${repo}${route}`];
      if (handler === undefined) return null;
      return typeof handler === "function" ? handler(params) : handler;
    },
    async postJson(repo, route, body) {
      calls.push({ method: "POST", repo, route, body });
      if (route === "/pulls") return { number: 77, node_id: "PR_77", html_url: "https://github.com/x/pull/77" };
      return {};
    },
    async patchJson(repo, route, body) {
      calls.push({ method: "PATCH", repo, route, body });
      return {};
    },
    async graphql(query, variables) {
      calls.push({ method: "GRAPHQL", query, variables });
      if (failAutoMerge) throw new Error(failAutoMerge);
      return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "2026-09-15T06:00:01Z" } } } };
    },
  };
}

const greenGate = {
  id: 2, name: "Stage Gate / development", status: "completed", conclusion: "success", completed_at: "2026-09-15T05:00:00Z",
  html_url: "https://example/gate", external_id: `stage-gate:development:${GATE_RUN_ID}`, details_url: `https://github.com/${REPO}/actions/runs/${GATE_RUN_ID}`,
  output: { summary: "| ✅ | Required Checks Gate |" },
};

/** The workflow run that legitimately minted `greenGate`: Stage Gate on the default branch, from this repo, green. */
function gateWorkflowRun(overrides = {}) {
  return {
    id: Number(GATE_RUN_ID), path: DEFAULT_GATE_WORKFLOW, event: "schedule", head_branch: "main", status: "completed", conclusion: "success",
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    ...overrides,
  };
}

function gateArtifacts(stage = "development", sha = HEAD, conclusion = "success") {
  return { total_count: 1, artifacts: [{ name: `stage-gate-${stage}-${sha}-${conclusion}` }] };
}

function baseRoutes({ gate = greenGate, aheadBy = 2, workflowRun = gateWorkflowRun(), artifacts = gateArtifacts(), landedAt = LANDED_AT } = {}) {
  return {
    [REPO]: { default_branch: "main" },
    [`${REPO}/branches/development`]: { commit: { sha: HEAD, commit: { committer: { date: landedAt } } } },
    [`${REPO}/branches/delivery`]: { commit: { sha: TARGET } },
    [`${REPO}/branches/main`]: { commit: { sha: TARGET } },
    [`${REPO}/actions/runs/${GATE_RUN_ID}`]: workflowRun,
    [`${REPO}/actions/runs/${GATE_RUN_ID}/artifacts`]: artifacts,
    [`${REPO}/compare/delivery...development`]: {
      status: aheadBy === 0 ? "identical" : "ahead",
      ahead_by: aheadBy,
      behind_by: 0,
      total_commits: aheadBy,
      merge_base_commit: { sha: TARGET },
      commits: aheadBy === 0 ? [] : [
        { sha: "1".repeat(40), commit: { message: "Merge pull request #410 from MonetizeKit/feat/x\n\nfeat: x" } },
        { sha: "2".repeat(40), commit: { message: "fix(api): y (#411)" } },
      ],
    },
    [`${REPO}/commits/${HEAD}/check-runs`]: gate ? { check_runs: [gate] } : { check_runs: [] },
    [`${REPO}/pulls/410`]: { number: 410, title: "feat: x", html_url: "https://github.com/x/pull/410" },
    [`${REPO}/pulls/411`]: { number: 411, title: "fix(api): y", html_url: "https://github.com/x/pull/411" },
    [`${REPO}/issues/410/comments`]: [
      { body: "## 🕶️ Shadow reviewer verdict (advisory — does not block)\n\n```json\n" + JSON.stringify({ model: "anthropic/claude-sonnet-5", lenses: [{ lens: "security", findings: [{ label: "important", file: "apps/web/a.ts", line: 3, problem: "raw SQL" }, { label: "nit", file: "x", problem: "naming" }] }] }) + "\n```" },
    ],
    [`${REPO}/issues/411/comments`]: [],
    [`${REPO}/pulls`]: [],
    [`${REPO}/labels/promotion`]: { name: "promotion" },
    [`${REPO}/labels/stage:delivery`]: null,
  };
}

test("the chain is development -> delivery -> main and the guard mirrors it", () => {
  assert.deepEqual(HOPS, { development: "delivery", delivery: "main" });
  assert.deepEqual(UPSTREAM, { delivery: "development", main: "delivery" });
});

test("gateState: green only on completed/success after the soak", () => {
  assert.equal(gateState(null).state, "pending");
  assert.equal(gateState({ status: "in_progress" }).state, "pending");
  assert.equal(gateState({ status: "completed", conclusion: "failure" }).state, "red");
  assert.equal(gateState({ status: "completed", conclusion: "skipped" }).state, "pending");
  assert.equal(gateState(greenGate, { now: NOW }).state, "green");
  // Without a landing time the soak falls back to the run's completed_at.
  const soaking = gateState(greenGate, { soakMinutes: 120, now: NOW });
  assert.equal(soaking.state, "soaking");
  assert.equal(soaking.readyAt, "2026-09-15T07:00:00.000Z");
  assert.equal(gateState(greenGate, { soakMinutes: 30, now: NOW }).state, "green");
});

test("gateState: the soak counts from when the head landed, so a gate that republishes every cycle cannot reset it", () => {
  // Head landed 22:00 the day before; the newest green run completed at 05:00 (one hour ago).
  // A 6-hour soak anchored on the head is over; anchored on the run it would never end.
  const green = gateState(greenGate, { soakMinutes: 360, now: NOW, soakFrom: LANDED_AT });
  assert.equal(green.state, "green");
  const soaking = gateState(greenGate, { soakMinutes: 600, now: NOW, soakFrom: LANDED_AT });
  assert.equal(soaking.state, "soaking");
  assert.equal(soaking.readyAt, "2026-09-15T08:00:00.000Z");
  assert.match(soaking.detail, /the head landed at 2026-09-14T22:00:00.000Z/);
  // A newer republished run with the same head does not move readyAt.
  const republished = { ...greenGate, id: 3, completed_at: "2026-09-15T05:30:00Z" };
  assert.equal(gateState(republished, { soakMinutes: 600, now: NOW, soakFrom: LANDED_AT }).readyAt, "2026-09-15T08:00:00.000Z");
});

test("gateRunId reads the producing run from external_id first, then details_url", () => {
  assert.equal(gateRunId(greenGate), GATE_RUN_ID);
  assert.equal(gateRunId({ details_url: `https://github.com/${REPO}/actions/runs/42?check_suite_focus=true` }), "42");
  assert.equal(gateRunId({ external_id: "stage-gate:development", details_url: "https://example/gate" }), null);
  assert.equal(gateRunId({ external_id: "stage-gate:development:12", details_url: `https://github.com/${REPO}/actions/runs/13` }), "12");
  assert.equal(gateRunId(null), null);
});

test("gateProvenance: trusts only the default-branch Stage Gate run from this repository that uploaded success evidence for this SHA", () => {
  const base = { checkRun: greenGate, repo: REPO, defaultBranch: "main", stage: "development", headSha: HEAD };
  const ok = gateProvenance({ ...base, workflowRun: gateWorkflowRun(), artifacts: gateArtifacts().artifacts });
  assert.equal(ok.trusted, true);
  assert.match(ok.reason, new RegExp(`run ${GATE_RUN_ID} on main`));

  const cases = [
    ["no producing run named", { checkRun: { ...greenGate, external_id: "stage-gate:development", details_url: "https://example/gate" }, workflowRun: gateWorkflowRun(), artifacts: gateArtifacts().artifacts }, /names no producing workflow run/],
    ["run does not exist", { workflowRun: null, artifacts: [] }, /does not exist/],
    ["run from another repository", { workflowRun: gateWorkflowRun({ repository: { full_name: "someone/fork" }, head_repository: { full_name: "someone/fork" } }), artifacts: gateArtifacts().artifacts }, /belongs to someone\/fork/],
    ["run of a different workflow", { workflowRun: gateWorkflowRun({ path: ".github/workflows/forge.yml" }), artifacts: gateArtifacts().artifacts }, /is \.github\/workflows\/forge\.yml/],
    ["run triggered by a pull request", { workflowRun: gateWorkflowRun({ event: "pull_request" }), artifacts: gateArtifacts().artifacts }, /triggered by pull_request/],
    ["run from a non-default branch (weakened config)", { workflowRun: gateWorkflowRun({ event: "workflow_dispatch", head_branch: "feat/weaken-gate" }), artifacts: gateArtifacts().artifacts }, /ran from feat\/weaken-gate/],
    ["run whose code came from a fork", { workflowRun: gateWorkflowRun({ head_repository: { full_name: "someone/fork" } }), artifacts: gateArtifacts().artifacts }, /ran code from someone\/fork/],
    ["run that did not succeed", { workflowRun: gateWorkflowRun({ conclusion: "failure" }), artifacts: gateArtifacts().artifacts }, /completed\/failure/],
    ["run still in progress", { workflowRun: gateWorkflowRun({ status: "in_progress", conclusion: null }), artifacts: gateArtifacts().artifacts }, /in_progress/],
    ["legitimate run, but it evaluated another SHA", { workflowRun: gateWorkflowRun(), artifacts: gateArtifacts("development", "c".repeat(40)).artifacts }, /uploaded no artifact stage-gate-development-a+-success \(it has stage-gate-development-c+-success\)/],
    ["legitimate run, but its verdict for this SHA was pending", { workflowRun: gateWorkflowRun(), artifacts: gateArtifacts("development", HEAD, "pending").artifacts }, /-pending\)/],
    ["legitimate run, but for the other stage", { workflowRun: gateWorkflowRun(), artifacts: gateArtifacts("delivery").artifacts }, /evaluated nothing for this SHA/],
    ["legitimate run with no artifacts at all", { workflowRun: gateWorkflowRun(), artifacts: [] }, /evaluated nothing for this SHA/],
  ];
  for (const [label, overrides, pattern] of cases) {
    const verdict = gateProvenance({ ...base, ...overrides });
    assert.equal(verdict.trusted, false, label);
    assert.match(verdict.reason, pattern, label);
  }
  // A caller may relocate its Stage Gate workflow; the expected path follows.
  assert.equal(gateProvenance({ ...base, gateWorkflow: ".github/workflows/gate.yml", workflowRun: gateWorkflowRun({ path: ".github/workflows/gate.yml" }), artifacts: gateArtifacts().artifacts }).trusted, true);
});

test("latestCheckRun prefers the newest informative run over a newer skipped one", () => {
  const runs = [{ id: 1, status: "completed", conclusion: "success" }, { id: 3, status: "completed", conclusion: "skipped" }, { id: 2, status: "completed", conclusion: "failure" }];
  assert.equal(latestCheckRun(runs).id, 2);
});

test("includedPullNumbers reads merge and squash commits, ignores the rest", () => {
  const commits = [
    { commit: { message: "Merge pull request #12 from x/y\n\nbody" } },
    { commit: { message: "feat(scope): thing (#34)" } },
    { commit: { message: "chore: direct commit" } },
    { commit: { message: "Merge pull request #12 from x/y" } },
  ];
  assert.deepEqual(includedPullNumbers(commits), [12, 34]);
});

test("reviewFindingsFromComments parses the shadow verdict's JSON block", () => {
  assert.equal(reviewFindingsFromComments([{ body: "lgtm" }]), null);
  const parsed = reviewFindingsFromComments(baseRoutes()[`${REPO}/issues/410/comments`]);
  assert.equal(parsed.important, 1);
  assert.equal(parsed.nits, 1);
  assert.equal(parsed.findings[0].lens, "security");
  assert.equal(parsed.model, "anthropic/claude-sonnet-5");
  const unparsed = reviewFindingsFromComments([{ body: "## 🕶️ Shadow reviewer verdict\n_Reviewer run failed_" }]);
  assert.deepEqual(unparsed, { important: 0, nits: 0, findings: [], parsed: false });
});

test("renderBody carries marker, gate evidence, included PRs, findings and the changelog", () => {
  const reviews = new Map([[410, reviewFindingsFromComments(baseRoutes()[`${REPO}/issues/410/comments`])]]);
  const body = renderBody({
    repo: REPO, source: "delivery", target: "main", headSha: HEAD, baseSha: TARGET,
    gate: gateState(greenGate, { now: NOW }), commits: [{}, {}],
    pulls: [{ number: 410, title: "feat: x | pipes" }, { number: 411, title: "fix(api): y" }],
    reviews, changelog: "## vNEXT\n- feat: x", autoMerge: false, runUrl: "https://run", now: NOW,
  });
  assert.ok(body.startsWith(PROMOTION_MARKER));
  assert.match(body, /Prepared for human authorization/);
  assert.match(body, /Loop-by-loop verdict quoted from the check run/);
  assert.match(body, /## Changelog draft\n\n## vNEXT/);
  assert.match(body, /\| #410 \| feat: x \\\| pipes \| 1 important, 1 nit \|/);
  assert.match(body, /\| #411 \| fix\(api\): y \| no shadow review \|/);
  assert.match(body, /Important review findings carried into main \(1\)/);
  assert.match(body, /#410 `security` \*\*apps\/web\/a.ts\*\*:3 — raw SQL/);
  assert.match(body, /adds no diff of its own/);
  const auto = renderBody({ repo: REPO, source: "development", target: "delivery", headSha: HEAD, baseSha: TARGET, gate: gateState(greenGate, { now: NOW }), commits: [], pulls: [], reviews: new Map(), changelog: "", autoMerge: true, now: NOW });
  assert.match(auto, /\*\*Automatic\.\*\* Auto-merge is enabled/);
  assert.match(auto, /No pull request references found/);
});

test("promote: nothing to promote when the target already contains the source", async () => {
  const api = fakeApi(baseRoutes({ aheadBy: 0 }));
  const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", now: NOW });
  assert.equal(result.status, "nothing-to-promote");
  assert.ok(!api.calls.some((call) => call.method === "POST"));
});

test("promote: waits on a pending gate, stops on a red gate, opens nothing either way", async () => {
  for (const [gate, status] of [[null, "gate-pending"], [{ ...greenGate, conclusion: "failure" }, "gate-red"], [{ ...greenGate, status: "in_progress", conclusion: null }, "gate-pending"]]) {
    const api = fakeApi(baseRoutes({ gate }));
    const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", now: NOW });
    assert.equal(result.status, status);
    assert.ok(!api.calls.some((call) => call.method === "POST" || call.method === "PATCH" || call.method === "GRAPHQL"), status);
  }
});

test("promote: soak keeps delivery -> main waiting, counted from when the head landed on delivery", async () => {
  const routes = baseRoutes();
  routes[`${REPO}/compare/main...delivery`] = routes[`${REPO}/compare/delivery...development`];
  // Landed on delivery at 22:00 the day before; gate republished green at 05:00.
  routes[`${REPO}/branches/delivery`] = { commit: { sha: HEAD, commit: { committer: { date: LANDED_AT } } } };
  const api = fakeApi(routes);
  // 10 h soak from landing -> ready 08:00; anchored on the 05:00 run it would say 15:00.
  const result = await promote({ api, repo: REPO, source: "delivery", target: "main", gateName: "Stage Gate / delivery", soakMinutes: 600, now: NOW });
  assert.equal(result.status, "gate-soaking");
  assert.equal(result.landedAt, LANDED_AT);
  assert.equal(result.gate.readyAt, "2026-09-15T08:00:00.000Z");
  assert.ok(!api.calls.some((call) => call.method !== "GET"));
  // 7 h soak from landing has elapsed even though the newest gate run is only an hour old.
  const routes2 = { ...routes, [`${REPO}/actions/runs/${GATE_RUN_ID}/artifacts`]: gateArtifacts("delivery") };
  const api2 = fakeApi(routes2);
  const ready = await promote({ api: api2, repo: REPO, source: "delivery", target: "main", gateName: "Stage Gate / delivery", soakMinutes: 420, dryRun: true, now: NOW });
  assert.equal(ready.status, "dry-run");
});

test("promote: a green gate whose provenance cannot be verified is gate-untrusted and opens nothing", async () => {
  const forged = [
    ["check run naming no run", { gate: { ...greenGate, id: 9, external_id: "stage-gate:development", details_url: "https://example/forged" } }, /names no producing workflow run/],
    ["check run pointing at a PR-branch run with a weakened config", { workflowRun: gateWorkflowRun({ event: "workflow_dispatch", head_branch: "feat/weaken-gate" }) }, /feat\/weaken-gate/],
    ["check run pointing at a fork PR run that uploaded the artifact", { workflowRun: gateWorkflowRun({ event: "pull_request", head_branch: "main", head_repository: { full_name: "someone/fork" } }) }, /pull_request/],
    ["check run pointing at a legitimate run for another SHA", { artifacts: gateArtifacts("development", "c".repeat(40)) }, /uploaded no artifact/],
    ["check run pointing at a legitimate run whose verdict was failure", { artifacts: gateArtifacts("development", HEAD, "failure") }, /-failure\)/],
    ["check run pointing at a run that does not exist", { workflowRun: null, artifacts: null }, /does not exist/],
  ];
  for (const [label, overrides, pattern] of forged) {
    const api = fakeApi(baseRoutes(overrides));
    const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW });
    assert.equal(result.status, "gate-untrusted", label);
    assert.equal(result.gate.provenance.trusted, false, label);
    assert.match(result.gate.provenance.reason, pattern, label);
    assert.match(result.warning, /provenance could not be verified/, label);
    assert.ok(!api.calls.some((call) => call.method === "POST" || call.method === "PATCH" || call.method === "GRAPHQL"), label);
  }
  // A newer forged green run is the one judged (newest informative wins), so it cannot ride on an older legitimate run's verdict.
  const routes = baseRoutes();
  routes[`${REPO}/commits/${HEAD}/check-runs`] = { check_runs: [greenGate, { ...greenGate, id: 50, external_id: "stage-gate:development", details_url: "https://example/forged" }] };
  const judged = await promote({ api: fakeApi(routes), repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", now: NOW });
  assert.equal(judged.status, "gate-untrusted");
});

test("promote: green development gate opens the PR, labels it and enables auto-merge", async () => {
  const api = fakeApi(baseRoutes());
  const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, runUrl: "https://run", now: NOW });
  assert.equal(result.status, "opened");
  assert.deepEqual(result.pr, { number: 77, url: "https://github.com/x/pull/77" });
  assert.equal(result.autoMerge.enabled, true);
  const open = api.calls.find((call) => call.method === "POST" && call.route === "/pulls");
  assert.equal(open.body.head, "development");
  assert.equal(open.body.base, "delivery");
  assert.equal(open.body.title, promotionTitle("development", "delivery", HEAD));
  assert.ok(open.body.body.includes(PROMOTION_MARKER));
  assert.match(open.body.body, new RegExp(`Provenance verified: verdict minted by ${DEFAULT_GATE_WORKFLOW.replace(/\\./g, "\\\\.")} run ${GATE_RUN_ID} on main`));
  assert.equal(result.gate.provenance.trusted, true);
  // The verification read the run and its artifacts, nothing more.
  assert.ok(api.calls.some((call) => call.method === "GET" && call.route === `/actions/runs/${GATE_RUN_ID}`));
  assert.ok(api.calls.some((call) => call.method === "GET" && call.route === `/actions/runs/${GATE_RUN_ID}/artifacts`));
  const labels = api.calls.find((call) => call.method === "POST" && call.route === "/issues/77/labels");
  assert.deepEqual(labels.body.labels, ["promotion", "stage:delivery"]);
  // Missing label was created; the existing one was not.
  assert.ok(api.calls.some((call) => call.method === "POST" && call.route === "/labels" && call.body.name === "stage:delivery"));
  assert.ok(!api.calls.some((call) => call.method === "POST" && call.route === "/labels" && call.body.name === "promotion"));
});

test("promote: an existing open promotion PR is updated in place, not duplicated", async () => {
  const routes = baseRoutes();
  routes[`${REPO}/pulls`] = [{ number: 70, node_id: "PR_70", html_url: "https://github.com/x/pull/70", head: { ref: "development" }, base: { ref: "delivery" } }];
  const api = fakeApi(routes);
  const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW });
  assert.equal(result.status, "updated");
  assert.equal(result.pr.number, 70);
  assert.ok(api.calls.some((call) => call.method === "PATCH" && call.route === "/pulls/70"));
  assert.ok(!api.calls.some((call) => call.method === "POST" && call.route === "/pulls"));
});

test("promote: auto-merge refused by the repository is a warning, not a failure", async () => {
  const api = fakeApi(baseRoutes(), { failAutoMerge: "GitHub GraphQL: Pull request Auto merge is not allowed for this repository" });
  const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW });
  assert.equal(result.status, "opened");
  assert.equal(result.autoMerge.enabled, false);
  assert.match(result.warning, /Allow auto-merge/);
});

test("promote: delivery -> main never enables auto-merge and dry-run opens nothing", async () => {
  const routes = baseRoutes({ artifacts: gateArtifacts("delivery") });
  routes[`${REPO}/compare/main...delivery`] = routes[`${REPO}/compare/delivery...development`];
  routes[`${REPO}/branches/delivery`] = { commit: { sha: HEAD } };
  const api = fakeApi(routes);
  const result = await promote({ api, repo: REPO, source: "delivery", target: "main", gateName: "Stage Gate / delivery", changelog: "## vNEXT", dryRun: true, now: NOW });
  assert.equal(result.status, "dry-run");
  assert.match(result.body, /Prepared for human authorization/);
  assert.match(result.body, /## Changelog draft/);
  assert.ok(!api.calls.some((call) => call.method !== "GET"));
  await assert.rejects(() => promote({ api, repo: REPO, source: "development", target: "main", gateName: "x" }), /unsupported hop/);
});

test("guardDecision: only the expected upstream hop passes into a guarded branch", () => {
  const same = { headRepo: REPO, baseRepo: REPO };
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "development", ...same }).pass, true);
  assert.equal(guardDecision({ baseRef: "main", headRef: "delivery", ...same }).pass, true);
  assert.equal(guardDecision({ baseRef: "main", headRef: "development", ...same }).pass, false);
  assert.equal(guardDecision({ baseRef: "main", headRef: "feat/x", ...same }).pass, false);
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "feat/x", ...same }).pass, false);
  const feature = guardDecision({ baseRef: "development", headRef: "feat/x", ...same });
  assert.equal(feature.pass, true);
  assert.equal(feature.guarded, false);
  const override = guardDecision({ baseRef: "main", headRef: "hotfix/x", labels: [OVERRIDE_LABEL], ...same });
  assert.equal(override.pass, true);
  assert.equal(override.override, true);
  assert.match(override.reason, /audited exception/);
});

test("guardDecision: a fork branch named like the stage is not the stage branch", () => {
  const fork = guardDecision({ baseRef: "delivery", headRef: "development", headRepo: "someone/app-monetizekit-monorepo", baseRepo: REPO });
  assert.equal(fork.pass, false);
  assert.equal(fork.guarded, true);
  assert.match(fork.reason, /head lives in this repository/);
  assert.match(fork.reason, /someone\/app-monetizekit-monorepo/);
  // The override label relaxes the hop, never the repository.
  const forkOverride = guardDecision({ baseRef: "main", headRef: "hotfix/x", labels: [OVERRIDE_LABEL], headRepo: "someone/fork", baseRepo: REPO });
  assert.equal(forkOverride.pass, false);
  assert.equal(forkOverride.override, false);
  // Unknown head repository (deleted fork, missing env) fails closed.
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "development", baseRepo: REPO }).pass, false);
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "development", headRepo: REPO }).pass, false);
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "development" }).pass, false);
  // Repository names compare case-insensitively, as GitHub treats them.
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "development", headRepo: REPO.toUpperCase(), baseRepo: REPO }).pass, true);
  // Feature PRs into development are not guarded, so the head repository does not matter there.
  assert.equal(guardDecision({ baseRef: "development", headRef: "feat/x", headRepo: "someone/fork", baseRepo: REPO }).pass, true);
});
