// node --test scripts/promote/
import { test } from "node:test";
import assert from "node:assert/strict";

import { guardDecision, OVERRIDE_LABEL, UPSTREAM } from "./guard.mjs";
import {
  DEFAULT_GATE_WORKFLOW,
  HOPS,
  PROMOTION_MARKER,
  displayCheckRun,
  findTrustedVerdict,
  gateEvidence,
  gateState,
  includedPullNumbers,
  promote,
  promotionTitle,
  renderBody,
  reviewFindingsFromComments,
  untrustedGateRunReason,
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

/** A Stage Gate workflow run as listed by /actions/workflows/stage-gate.yml/runs: default branch, this repo, green. */
function gateWorkflowRun(overrides = {}) {
  return {
    id: Number(GATE_RUN_ID), path: DEFAULT_GATE_WORKFLOW, event: "schedule", head_branch: "main", status: "completed", conclusion: "success",
    created_at: "2026-09-15T04:30:00Z", updated_at: "2026-09-15T05:00:00Z", html_url: `https://github.com/${REPO}/actions/runs/${GATE_RUN_ID}`,
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    ...overrides,
  };
}

function gateArtifacts(stage = "development", sha = HEAD, conclusion = "success") {
  return { total_count: 1, artifacts: [{ name: `stage-gate-${stage}-${sha}-${conclusion}` }] };
}

/** The trusted verdict as findTrustedVerdict returns it for the default fixture. */
const trustedVerdict = { conclusion: "success", runId: Number(GATE_RUN_ID), runUrl: `https://github.com/${REPO}/actions/runs/${GATE_RUN_ID}`, artifact: `stage-gate-development-${HEAD}-success`, completedAt: "2026-09-15T05:00:00Z" };

function baseRoutes({ gate = greenGate, aheadBy = 2, workflowRuns = [gateWorkflowRun()], artifacts = gateArtifacts(), landedAt = LANDED_AT, extraArtifacts = {} } = {}) {
  const routes = {
    [REPO]: { default_branch: "main" },
    [`${REPO}/branches/development`]: { commit: { sha: HEAD, commit: { committer: { date: landedAt } } } },
    [`${REPO}/branches/delivery`]: { commit: { sha: TARGET } },
    [`${REPO}/branches/main`]: { commit: { sha: TARGET } },
    [`${REPO}/actions/workflows/stage-gate.yml/runs`]: { total_count: workflowRuns.length, workflow_runs: workflowRuns },
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
  for (const [runId, names] of Object.entries(extraArtifacts)) {
    routes[`${REPO}/actions/runs/${runId}/artifacts`] = { total_count: names.length, artifacts: names.map((name) => ({ name })) };
  }
  return routes;
}

test("the chain is development -> delivery -> main and the guard mirrors it", () => {
  assert.deepEqual(HOPS, { development: "delivery", delivery: "main" });
  assert.deepEqual(UPSTREAM, { delivery: "development", main: "delivery" });
});

test("gateState: green only on a trusted success verdict, after the soak", () => {
  assert.equal(gateState(null).state, "pending");
  assert.match(gateState(null).detail, /no trusted Stage Gate evaluation/);
  assert.equal(gateState({ conclusion: "pending", runId: 1 }).state, "pending");
  assert.equal(gateState({ conclusion: "failure", runId: 1 }).state, "red");
  assert.equal(gateState(trustedVerdict, { now: NOW }).state, "green");
  assert.match(gateState(trustedVerdict, { now: NOW }).detail, /evidence stage-gate-development-a+-success/);
  // Without a landing time the soak falls back to the evaluation time.
  const soaking = gateState(trustedVerdict, { soakMinutes: 120, now: NOW });
  assert.equal(soaking.state, "soaking");
  assert.equal(soaking.readyAt, "2026-09-15T07:00:00.000Z");
  assert.equal(gateState(trustedVerdict, { soakMinutes: 30, now: NOW }).state, "green");
});

test("gateState: the soak counts from when the head landed, so re-evaluating every cycle cannot reset it", () => {
  // Head landed 22:00 the day before; the newest evaluation completed at 05:00 (one hour ago).
  // A 6-hour soak anchored on the head is over; anchored on the evaluation it would never end.
  assert.equal(gateState(trustedVerdict, { soakMinutes: 360, now: NOW, soakFrom: LANDED_AT }).state, "green");
  const soaking = gateState(trustedVerdict, { soakMinutes: 600, now: NOW, soakFrom: LANDED_AT });
  assert.equal(soaking.state, "soaking");
  assert.equal(soaking.readyAt, "2026-09-15T08:00:00.000Z");
  assert.match(soaking.detail, /the head landed at 2026-09-14T22:00:00.000Z/);
  const reevaluated = { ...trustedVerdict, runId: 9003, completedAt: "2026-09-15T05:30:00Z" };
  assert.equal(gateState(reevaluated, { soakMinutes: 600, now: NOW, soakFrom: LANDED_AT }).readyAt, "2026-09-15T08:00:00.000Z");
});

test("gateEvidence reads the conclusion from the artifact name and ignores other stages, SHAs and junk", () => {
  assert.deepEqual(gateEvidence([`stage-gate-development-${HEAD}-success`], { stage: "development", headSha: HEAD }), { conclusion: "success", artifact: `stage-gate-development-${HEAD}-success` });
  assert.equal(gateEvidence([`stage-gate-development-${HEAD}-failure`], { stage: "development", headSha: HEAD }).conclusion, "failure");
  assert.equal(gateEvidence([`stage-gate-development-${HEAD}-pending`], { stage: "development", headSha: HEAD }).conclusion, "pending");
  assert.equal(gateEvidence([`stage-gate-delivery-${HEAD}-success`], { stage: "development", headSha: HEAD }), null);
  assert.equal(gateEvidence([`stage-gate-development-${"c".repeat(40)}-success`], { stage: "development", headSha: HEAD }), null);
  assert.equal(gateEvidence([`stage-gate-development-${HEAD}-bogus`, "stage-gate-development-run-5"], { stage: "development", headSha: HEAD }), null);
  assert.equal(gateEvidence([], { stage: "development", headSha: HEAD }), null);
  assert.equal(gateEvidence(null, { stage: "development", headSha: HEAD }), null);
});

test("untrustedGateRunReason: only this repository's Stage Gate workflow on the default branch, from this repository, green", () => {
  const ctx = { repo: REPO, defaultBranch: "main" };
  assert.equal(untrustedGateRunReason(gateWorkflowRun(), ctx), null);
  const cases = [
    ["missing", null, /no workflow run/],
    ["another repository", gateWorkflowRun({ repository: { full_name: "someone/fork" }, head_repository: { full_name: "someone/fork" } }), /belongs to someone\/fork/],
    ["another workflow", gateWorkflowRun({ path: ".github/workflows/forge.yml" }), /is \.github\/workflows\/forge\.yml/],
    ["pull_request event", gateWorkflowRun({ event: "pull_request" }), /triggered by pull_request/],
    ["non-default branch (weakened config)", gateWorkflowRun({ event: "workflow_dispatch", head_branch: "feat/weaken-gate" }), /ran from feat\/weaken-gate/],
    ["fork code", gateWorkflowRun({ head_repository: { full_name: "someone/fork" } }), /ran code from someone\/fork/],
    ["failed", gateWorkflowRun({ conclusion: "failure" }), /completed\/failure/],
    ["cancelled (superseded)", gateWorkflowRun({ conclusion: "cancelled" }), /completed\/cancelled/],
    ["in progress", gateWorkflowRun({ status: "in_progress", conclusion: null }), /in_progress/],
  ];
  for (const [label, run, pattern] of cases) assert.match(untrustedGateRunReason(run, ctx) ?? "", pattern, label);
  // A caller may relocate its Stage Gate workflow; the expected path follows.
  assert.equal(untrustedGateRunReason(gateWorkflowRun({ path: ".github/workflows/gate.yml" }), { ...ctx, gateWorkflow: ".github/workflows/gate.yml" }), null);
});

test("findTrustedVerdict: the newest trusted run with evidence for this SHA wins; untrusted runs are skipped, older runs cannot replay a stale success", async () => {
  const ctx = { repo: REPO, defaultBranch: "main", gateWorkflow: DEFAULT_GATE_WORKFLOW, stage: "development", headSha: HEAD, landedAt: LANDED_AT };
  const artifactsByRun = {
    9003: [`stage-gate-development-${HEAD}-failure`, `stage-gate-delivery-${TARGET}-success`],
    9002: [],
    9001: [`stage-gate-development-${HEAD}-success`],
    8000: [`stage-gate-development-${HEAD}-success`],
  };
  const lookups = [];
  const artifactNamesOf = async (runId) => { lookups.push(runId); return artifactsByRun[runId] ?? []; };
  const runs = [
    gateWorkflowRun({ id: 9001, created_at: "2026-09-15T04:30:00Z" }),
    gateWorkflowRun({ id: 9003, created_at: "2026-09-15T05:30:00Z" }),
    gateWorkflowRun({ id: 9002, created_at: "2026-09-15T05:00:00Z", event: "workflow_dispatch", head_branch: "feat/weaken-gate" }),
    gateWorkflowRun({ id: 8000, created_at: "2026-09-14T21:00:00Z" }), // before the head landed
  ];
  // Newest evaluation (9003) went red: the older 9001 success is not consulted at all.
  const red = await findTrustedVerdict(runs, ctx, artifactNamesOf);
  assert.equal(red.verdict.conclusion, "failure");
  assert.equal(red.verdict.runId, 9003);
  assert.deepEqual(lookups, [9003], "stops at the newest trusted run that carries evidence for this SHA");
  assert.equal(red.rejected.length, 0);

  // Without 9003 the weakened-config run 9002 is skipped (with a reason) and 9001 supplies the verdict.
  lookups.length = 0;
  const green = await findTrustedVerdict(runs.filter((run) => run.id !== 9003), ctx, artifactNamesOf);
  assert.equal(green.verdict.conclusion, "success");
  assert.equal(green.verdict.runId, 9001);
  assert.deepEqual(lookups, [9001], "untrusted runs are never asked for artifacts");
  assert.match(green.rejected[0], /feat\/weaken-gate/);

  // Runs created before the head landed are not consulted (8000 is never looked up).
  lookups.length = 0;
  const none = await findTrustedVerdict([runs[3]], ctx, artifactNamesOf);
  assert.equal(none.verdict, null);
  assert.equal(none.considered, 0);
  assert.deepEqual(lookups, []);

  // A trusted run that evaluated a different SHA yields nothing, not a borrowed verdict.
  const other = await findTrustedVerdict([gateWorkflowRun({ id: 9005, created_at: "2026-09-15T05:45:00Z" })], ctx, async () => [`stage-gate-development-${"c".repeat(40)}-success`]);
  assert.equal(other.verdict, null);
  assert.equal(other.considered, 1);
});

test("displayCheckRun is display-only: it picks the check run whose external_id names the trusted run, or nothing", () => {
  const forged = { ...greenGate, id: 50, external_id: "stage-gate:development", details_url: "https://example/forged" };
  const other = { ...greenGate, id: 51, external_id: "stage-gate:development:1" };
  assert.equal(displayCheckRun([forged, other, greenGate], { stage: "development", runId: Number(GATE_RUN_ID) }), greenGate);
  assert.equal(displayCheckRun([forged, other], { stage: "development", runId: Number(GATE_RUN_ID) }), null);
  assert.equal(displayCheckRun(null, { stage: "development", runId: 1 }), null);
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
    gate: { ...gateState(trustedVerdict, { now: NOW }), verdict: trustedVerdict, display: greenGate }, commits: [{}, {}],
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
  assert.match(body, /Provenance: the verdict is read from the Stage Gate workflow's own evaluation run 9001/);
  const auto = renderBody({ repo: REPO, source: "development", target: "delivery", headSha: HEAD, baseSha: TARGET, gate: { ...gateState(trustedVerdict, { now: NOW }), verdict: trustedVerdict, display: null }, commits: [], pulls: [], reviews: new Map(), changelog: "", autoMerge: true, now: NOW });
  assert.match(auto, /\*\*Automatic\.\*\* Auto-merge is enabled/);
  assert.match(auto, /No pull request references found/);
  assert.doesNotMatch(auto, /Loop-by-loop verdict quoted/, "no summary when no check run names the trusted run");
});

test("promote: nothing to promote when the target already contains the source", async () => {
  const api = fakeApi(baseRoutes({ aheadBy: 0 }));
  const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", now: NOW });
  assert.equal(result.status, "nothing-to-promote");
  assert.ok(!api.calls.some((call) => call.method === "POST"));
});

test("promote: waits on a pending or absent evaluation, stops on a red one, opens nothing either way — check runs play no part", async () => {
  const cases = [
    ["no evaluation yet", { workflowRuns: [] }, "gate-pending", /no trusted Stage Gate evaluation/],
    ["evaluation pending", { artifacts: gateArtifacts("development", HEAD, "pending") }, "gate-pending", /waiting on required signals/],
    ["evaluation red", { artifacts: gateArtifacts("development", HEAD, "failure") }, "gate-red", /concluded failure/],
    ["evaluation of another SHA only", { artifacts: gateArtifacts("development", "c".repeat(40)) }, "gate-pending", /no trusted Stage Gate evaluation/],
    ["only untrusted runs", { workflowRuns: [gateWorkflowRun({ event: "workflow_dispatch", head_branch: "feat/weaken-gate" })] }, "gate-pending", /1 not trusted: run 9001 ran from feat\/weaken-gate/],
  ];
  for (const [label, overrides, status, pattern] of cases) {
    // A green check run is present in every case and must not matter.
    const api = fakeApi(baseRoutes({ gate: greenGate, ...overrides }));
    const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW });
    assert.equal(result.status, status, label);
    assert.match(result.detail, pattern, label);
    assert.ok(!api.calls.some((call) => call.method === "POST" || call.method === "PATCH" || call.method === "GRAPHQL"), label);
  }
});

test("promote: soak keeps delivery -> main waiting, counted from when the head landed on delivery", async () => {
  const routes = baseRoutes({ artifacts: gateArtifacts("delivery") });
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

test("promote: forged check runs cannot open the hop — the verdict is read from the newest trusted evaluation's artifact", async () => {
  // Stale evidence: run 9001 evaluated this SHA green; a later run 9002 evaluated it red; an attacker mints a newer
  // green check run whose external_id points at 9001. The bot follows the runs, not the check run: gate-red.
  const routes = baseRoutes({
    workflowRuns: [gateWorkflowRun({ id: 9001 }), gateWorkflowRun({ id: 9002, created_at: "2026-09-15T05:30:00Z" })],
    extraArtifacts: { 9002: [`stage-gate-development-${HEAD}-failure`] },
  });
  routes[`${REPO}/commits/${HEAD}/check-runs`] = { check_runs: [greenGate, { ...greenGate, id: 99, completed_at: "2026-09-15T05:59:00Z" }] };
  const stale = await promote({ api: fakeApi(routes), repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW });
  assert.equal(stale.status, "gate-red");
  assert.equal(stale.gate.verdict.runId, 9002);

  // No trusted evaluation at all, but a forged green check run naming a nonexistent run: gate-pending, nothing opened.
  const forgedOnly = baseRoutes({ workflowRuns: [], gate: { ...greenGate, id: 9, external_id: "stage-gate:development:424242", details_url: "https://example/forged" } });
  const api = fakeApi(forgedOnly);
  const result = await promote({ api, repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW });
  assert.equal(result.status, "gate-pending");
  assert.ok(!api.calls.some((call) => call.method !== "GET"));
  // The bot never asked the API about the run the forged check run named.
  assert.ok(!api.calls.some((call) => call.route === "/actions/runs/424242" || call.route === "/actions/runs/424242/artifacts"));

  // A check run pointing at a fork PR run that uploaded a success artifact: that run is not in the default-branch
  // Stage Gate run list (it is filtered out by untrustedGateRunReason even if it were), so it never counts.
  const forkRun = gateWorkflowRun({ id: 9009, created_at: "2026-09-15T05:50:00Z", event: "pull_request", head_repository: { full_name: "someone/fork" } });
  const viaFork = await promote({
    api: fakeApi(baseRoutes({ workflowRuns: [forkRun], extraArtifacts: { 9009: [`stage-gate-development-${HEAD}-success`] } })),
    repo: REPO, source: "development", target: "delivery", gateName: "Stage Gate / development", autoMerge: true, now: NOW,
  });
  assert.equal(viaFork.status, "gate-pending");
  assert.match(viaFork.detail, /triggered by pull_request/);
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
  assert.match(open.body.body, new RegExp(`Provenance: the verdict is read from the Stage Gate workflow's own evaluation run ${GATE_RUN_ID} on the default branch and its artifact \`stage-gate-development-${HEAD}-success\``));
  assert.match(open.body.body, /Loop-by-loop verdict quoted from the check run/, "the matching check run's summary is quoted for humans");
  assert.deepEqual(result.gate.verdict, trustedVerdict);
  assert.equal(result.gate.url, "https://example/gate", "links the display check run when its external_id names the trusted run");
  // The verdict came from the workflow's runs and that run's artifacts.
  assert.ok(api.calls.some((call) => call.method === "GET" && call.route === "/actions/workflows/stage-gate.yml/runs" && call.params.branch === "main"));
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
