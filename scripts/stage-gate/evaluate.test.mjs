// node --test scripts/stage-gate/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregate,
  checkRunExternalId,
  checkRunPayload,
  classifyCheckRun,
  classifyWorkflowRuns,
  createGitHubApi,
  evaluateStage,
  evidenceArtifactName,
  extractShas,
  issueCitesRange,
  latestCheckRun,
  validateConfig,
} from "./evaluate.mjs";

const NOW = Date.parse("2026-09-15T06:00:00Z");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OUTSIDE = "c".repeat(40);

function fakeApi(routes) {
  const calls = [];
  return {
    calls,
    async getJson(repo, route, params = {}) {
      calls.push({ repo, route, params });
      const key = `${repo}${route}`;
      const handler = routes[key];
      if (handler === undefined) return null;
      return typeof handler === "function" ? handler(params) : handler;
    },
    async postJson(repo, route, body) {
      calls.push({ repo, route, body });
      return { name: body.name, status: body.status, conclusion: body.conclusion, html_url: "https://example/check" };
    },
  };
}

const baseConfig = {
  stages: {
    development: {
      base: "delivery",
      signals: [
        { id: "ci", title: "Required Checks Gate", type: "check-run", name: "Required Checks Gate" },
        { id: "docs", title: "Docs Post-Deploy", type: "check-run", name: "Docs Post-Deploy / development" },
        { id: "drift", title: "Drift clear", type: "drift-clear", labels: ["examples-drift"] },
        { id: "model", title: "Model drift clear", type: "drift-clear", labels: ["model-usage-drift"], mode: "any-open" },
        { id: "web", title: "Fleet: web", type: "branch-head", repo: "MonetizeKit/app-monetizekit-web", branch: "development" },
        { id: "review", title: "Stage Review (shadow)", type: "check-run", name: "Stage Review / development", required: false },
      ],
    },
    delivery: {
      base: "main",
      signals: [
        { id: "perf", title: "Performance nightly", type: "workflow-run", repo: "MonetizeKit/performance", workflow: "nightly.yml", maxAgeHours: 30, afterHead: true },
        { id: "demo", title: "Demo verify", type: "workflow-run", workflow: "demo-refresh.yml", maxAgeHours: 30, absent: "skip" },
      ],
    },
  },
};

test("validateConfig accepts the reference shape and rejects unknown types, stages and duplicate ids", () => {
  assert.equal(validateConfig(baseConfig), true);
  assert.throws(() => validateConfig({ stages: { production: { base: "main", signals: [{ id: "x", title: "x", type: "check-run", name: "x" }] } } }), /unknown stage "production"/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "x", title: "x", type: "status" }] } } }), /unknown type "status"/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [
    { id: "x", title: "x", type: "check-run", name: "a" },
    { id: "x", title: "y", type: "check-run", name: "b" },
  ] } } }), /duplicate id/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "d", title: "d", type: "drift-clear", labels: [] }] } } }), /needs labels/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "w", title: "w", type: "workflow-run", workflow: "x.yml", absent: "ignore" }] } } }), /absent must be/);
});

test("classifyCheckRun maps conclusions to pass, fail and pending", () => {
  assert.equal(classifyCheckRun(null).state, "pending");
  assert.equal(classifyCheckRun({ status: "in_progress" }).state, "pending");
  assert.equal(classifyCheckRun({ status: "completed", conclusion: "success" }).state, "pass");
  assert.equal(classifyCheckRun({ status: "completed", conclusion: "failure" }).state, "fail");
  assert.equal(classifyCheckRun({ status: "completed", conclusion: "cancelled" }).state, "fail");
  assert.equal(classifyCheckRun({ status: "completed", conclusion: "skipped" }).state, "pending");
});

test("latestCheckRun prefers a run with a real verdict over a newer skipped one, and a newer in-progress run over an older verdict", () => {
  const pushVerdict = { id: 10, status: "completed", conclusion: "success" };
  const deploymentSkip = { id: 20, status: "completed", conclusion: "skipped" };
  const rerun = { id: 30, status: "in_progress" };
  assert.equal(latestCheckRun([deploymentSkip, pushVerdict]).id, 10);
  assert.equal(latestCheckRun([deploymentSkip]).id, 20);
  assert.equal(latestCheckRun([pushVerdict, rerun, deploymentSkip]).id, 30);
  assert.equal(latestCheckRun([]), null);
});

test("createGitHubApi retries anonymously on 401 for other public repos only when no fleet token is configured", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization ?? null });
    if (init.headers.authorization && url.includes("/repos/MonetizeKit/other/")) return new Response("bad credentials", { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = createGitHubApi({ token: "t", selfRepo: "MonetizeKit/self", fetchImpl });
  assert.deepEqual(await api.getJson("MonetizeKit/other", "/branches/main"), { ok: true });
  assert.deepEqual(calls.map((call) => call.auth), ["Bearer t", null]);

  const withFleet = createGitHubApi({ token: "t", fleetToken: "pat", selfRepo: "MonetizeKit/self", fetchImpl });
  calls.length = 0;
  await assert.rejects(() => withFleet.getJson("MonetizeKit/other", "/branches/main"), /GitHub API 401/);
  assert.deepEqual(calls.map((call) => call.auth), ["Bearer pat"], "a configured fleet token is authoritative; no anonymous retry");
});

test("classifyWorkflowRuns applies the age window, the after-head soak and the absent policy", () => {
  const recentSuccess = { status: "completed", conclusion: "success", created_at: "2026-09-15T04:17:00Z", html_url: "u" };
  const recentFailure = { ...recentSuccess, conclusion: "failure" };
  const stale = { ...recentSuccess, created_at: "2026-09-10T04:17:00Z" };
  const cancelled = { ...recentSuccess, conclusion: "cancelled", created_at: "2026-09-15T05:00:00Z" };

  assert.equal(classifyWorkflowRuns([recentSuccess], { now: NOW, maxAgeHours: 30 }).state, "pass");
  assert.equal(classifyWorkflowRuns([recentFailure], { now: NOW, maxAgeHours: 30 }).state, "fail");
  assert.equal(classifyWorkflowRuns([cancelled, recentSuccess], { now: NOW, maxAgeHours: 30 }).state, "pass", "cancelled runs are not verdicts");
  assert.equal(classifyWorkflowRuns([stale], { now: NOW, maxAgeHours: 30 }).state, "pending");
  assert.equal(classifyWorkflowRuns([stale], { now: NOW, maxAgeHours: 30, absent: "skip" }).state, "skipped");
  assert.equal(classifyWorkflowRuns([], { now: NOW, absent: "skip" }).state, "skipped");
  assert.equal(classifyWorkflowRuns([], { now: NOW }).state, "pending");
  const soaking = classifyWorkflowRuns([recentSuccess], { now: NOW, maxAgeHours: 30, afterHead: true, headCommittedAt: "2026-09-15T05:00:00Z" });
  assert.equal(soaking.state, "pending");
  assert.match(soaking.detail, /soaking/);
  assert.equal(classifyWorkflowRuns([recentSuccess], { now: NOW, maxAgeHours: 30, afterHead: true, headCommittedAt: "2026-09-14T05:00:00Z" }).state, "pass");
});

test("extractShas and issueCitesRange match full and abbreviated SHAs against the range", () => {
  const shas = extractShas(`Contract-surface changes landed on \`development\` in ${HEAD}. See also ${OLD.slice(0, 7)}.`);
  assert.ok(shas.has(HEAD));
  assert.ok(shas.has(OLD.slice(0, 7)));
  assert.equal(issueCitesRange(shas, [HEAD]), HEAD);
  assert.equal(issueCitesRange(shas, [OLD]), OLD, "abbreviated citation matches a range commit by prefix");
  assert.equal(issueCitesRange(shas, [OUTSIDE]), null);
});

test("aggregate: required fail wins, then required pending, advisory never moves it", () => {
  assert.equal(aggregate([{ required: true, state: "pass" }, { required: false, state: "fail" }]), "success");
  assert.equal(aggregate([{ required: true, state: "pass" }, { required: true, state: "pending" }]), "pending");
  assert.equal(aggregate([{ required: true, state: "fail" }, { required: true, state: "pending" }]), "failure");
  assert.equal(aggregate([{ required: true, state: "skipped" }]), "success", "a loop that is not observing does not hold the gate");
});

function developmentRoutes({ ciConclusion = "success", docsRuns = true, driftIssues = [], modelIssues = [], webConclusion = "success" } = {}) {
  const webHead = "d".repeat(40);
  return {
    "MonetizeKit/mono/branches/development": { commit: { sha: HEAD } },
    [`MonetizeKit/mono/commits/${HEAD}`]: { commit: { committer: { date: "2026-09-14T22:00:00Z" } } },
    [`MonetizeKit/mono/commits/${HEAD}/check-runs`]: (params) => {
      if (params.check_name === "Required Checks Gate") return { check_runs: [{ id: 1, status: "completed", conclusion: ciConclusion, html_url: "ci" }] };
      if (params.check_name === "Docs Post-Deploy / development") return docsRuns ? { check_runs: [{ id: 5, status: "completed", conclusion: "failure" }, { id: 9, status: "completed", conclusion: "success" }] } : { check_runs: [] };
      if (params.check_name === "Stage Review / development") return { check_runs: [{ id: 2, status: "completed", conclusion: "failure" }] };
      return { check_runs: [] };
    },
    "MonetizeKit/mono/compare/delivery...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { total_commits: 2, commits: [{ sha: HEAD }, { sha: OLD }] },
    "MonetizeKit/mono/issues": (params) => (params.labels === "examples-drift" ? driftIssues : params.labels === "model-usage-drift" ? modelIssues : []),
    "MonetizeKit/mono/issues/7/comments": [{ body: `follow-up escalation in ${OLD}` }],
    "MonetizeKit/app-monetizekit-web/branches/development": { commit: { sha: webHead } },
    [`MonetizeKit/app-monetizekit-web/commits/${webHead}/check-runs`]: { check_runs: [{ id: 3, status: "completed", conclusion: webConclusion }] },
  };
}

test("evaluateStage: development is green when every required signal passes; the shadow lens is reported but does not gate", async () => {
  const api = fakeApi(developmentRoutes());
  const evaluation = await evaluateStage({ api, config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.sha, HEAD);
  assert.equal(evaluation.conclusion, "success");
  const byId = Object.fromEntries(evaluation.signals.map((signal) => [signal.id, signal]));
  assert.equal(byId.docs.state, "pass", "the newest check run by id wins over an older failure");
  assert.equal(byId.review.state, "fail");
  assert.equal(byId.review.required, false);
  assert.match(evaluation.summary, /Stage Review \(shadow\) \| advisory \| fail/);
  const payload = checkRunPayload(evaluation, { detailsUrl: "https://run", runId: "12345" });
  assert.equal(payload.name, "Stage Gate / development");
  assert.equal(payload.head_sha, HEAD);
  assert.equal(payload.status, "completed");
  assert.equal(payload.conclusion, "success");
  assert.equal(payload.details_url, "https://run");
  assert.equal(payload.external_id, "stage-gate:development:12345");
  assert.equal(checkRunPayload(evaluation).external_id, "stage-gate:development");
});

test("evidence artifact name binds stage, exact SHA and conclusion — the part of the verdict the promotion bot verifies", () => {
  assert.equal(evidenceArtifactName("development", HEAD, "success"), `stage-gate-development-${HEAD}-success`);
  assert.equal(evidenceArtifactName("delivery", HEAD, "pending"), `stage-gate-delivery-${HEAD}-pending`);
  assert.equal(checkRunExternalId("delivery", 7), "stage-gate:delivery:7");
});

test("evaluateStage: a missing Docs Post-Deploy check leaves the gate in progress, not red", async () => {
  const api = fakeApi(developmentRoutes({ docsRuns: false }));
  const evaluation = await evaluateStage({ api, config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "pending");
  const payload = checkRunPayload(evaluation);
  assert.equal(payload.status, "in_progress");
  assert.equal(payload.conclusion, undefined);
  assert.match(payload.output.title, /Waiting on 1 required signal/);
});

test("evaluateStage: a red Required Checks Gate or a red fleet head fails the gate", async () => {
  let evaluation = await evaluateStage({ api: fakeApi(developmentRoutes({ ciConclusion: "failure" })), config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "failure");
  evaluation = await evaluateStage({ api: fakeApi(developmentRoutes({ webConclusion: "failure" })), config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "failure");
  assert.match(evaluation.signals.find((signal) => signal.id === "web").detail, /app-monetizekit-web@development/);
});

test("drift-clear (cites-range): an issue citing a commit in base..head blocks, one citing an outside commit does not, one citing nothing blocks", async () => {
  const inRangeViaComment = { number: 7, title: "examples-drift: surfaces changed", body: "no sha in body", comments: 1, html_url: "i7" };
  const outside = { number: 8, title: "examples-drift: old", body: `landed in ${OUTSIDE}`, comments: 0, html_url: "i8" };
  const silent = { number: 9, title: "examples-drift: manual", body: "someone opened this by hand", comments: 0, html_url: "i9" };

  let evaluation = await evaluateStage({ api: fakeApi(developmentRoutes({ driftIssues: [inRangeViaComment] })), config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "failure");
  assert.match(evaluation.signals.find((signal) => signal.id === "drift").detail, /#7 .*cites bbbbbbb/);

  evaluation = await evaluateStage({ api: fakeApi(developmentRoutes({ driftIssues: [outside] })), config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "success");

  evaluation = await evaluateStage({ api: fakeApi(developmentRoutes({ driftIssues: [silent] })), config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "failure");
  assert.match(evaluation.signals.find((signal) => signal.id === "drift").detail, /cites no commit/);
});

test("drift-clear (any-open): any open model-usage-drift issue blocks regardless of citations", async () => {
  const issue = { number: 12, title: "model-usage-drift: stale model", body: "policy review overdue", comments: 0, html_url: "i12" };
  const evaluation = await evaluateStage({ api: fakeApi(developmentRoutes({ modelIssues: [issue] })), config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "failure");
  assert.match(evaluation.signals.find((signal) => signal.id === "model").detail, /#12/);
});

test("evaluateStage: delivery nightly observers soak until a run after the head; a skip-policy loop with no runs does not hold the gate", async () => {
  const deliveryHead = "e".repeat(40);
  const routes = {
    "MonetizeKit/mono/branches/delivery": { commit: { sha: deliveryHead } },
    [`MonetizeKit/mono/commits/${deliveryHead}`]: { commit: { committer: { date: "2026-09-15T05:00:00Z" } } },
    "MonetizeKit/performance/actions/workflows/nightly.yml/runs": { workflow_runs: [{ status: "completed", conclusion: "success", created_at: "2026-09-15T04:17:00Z", html_url: "p" }] },
    "MonetizeKit/mono/actions/workflows/demo-refresh.yml/runs": { workflow_runs: [] },
  };
  let evaluation = await evaluateStage({ api: fakeApi(routes), config: baseConfig, stage: "delivery", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "pending");
  assert.equal(evaluation.signals.find((signal) => signal.id === "perf").state, "pending");
  assert.equal(evaluation.signals.find((signal) => signal.id === "demo").state, "skipped");

  routes[`MonetizeKit/mono/commits/${deliveryHead}`] = { commit: { committer: { date: "2026-09-14T05:00:00Z" } } };
  evaluation = await evaluateStage({ api: fakeApi(routes), config: baseConfig, stage: "delivery", selfRepo: "MonetizeKit/mono", now: NOW });
  assert.equal(evaluation.conclusion, "success");
});

test("evaluateStage: an API error on one signal is reported as pending, never as a pass", async () => {
  const api = fakeApi(developmentRoutes());
  api.getJson = (function wrap(original) {
    return async (repo, route, params) => {
      if (route === "/issues" && params.labels === "examples-drift") throw new Error("boom");
      return original(repo, route, params);
    };
  })(api.getJson.bind(api));
  const evaluation = await evaluateStage({ api, config: baseConfig, stage: "development", selfRepo: "MonetizeKit/mono", now: NOW });
  const drift = evaluation.signals.find((signal) => signal.id === "drift");
  assert.equal(drift.state, "pending");
  assert.match(drift.detail, /evaluation error: boom/);
  assert.equal(evaluation.conclusion, "pending");
});
