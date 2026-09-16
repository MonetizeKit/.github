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
  observerVerdict,
  untrustedObserverRunReason,
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
        { id: "ci", title: "Required Checks Gate", type: "check-run", name: "Required Checks Gate", workflow: ".github/workflows/ci.yml" },
        { id: "docs", title: "Docs Post-Deploy", type: "check-run", name: "Docs Post-Deploy / development", workflow: ".github/workflows/docs-post-deploy.yml" },
        { id: "drift", title: "Drift clear", type: "drift-clear", labels: ["examples-drift"] },
        { id: "model", title: "Model drift clear", type: "drift-clear", labels: ["model-usage-drift"], mode: "any-open" },
        { id: "web", title: "Fleet: web", type: "branch-head", repo: "MonetizeKit/app-monetizekit-web", branch: "development", workflow: ".github/workflows/ci.yml" },
        { id: "review", title: "Stage Review (shadow)", type: "check-run", name: "Stage Review / development", workflow: ".github/workflows/stage-review.yml", required: false },
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
  assert.throws(() => validateConfig({ stages: { production: { base: "main", signals: [{ id: "x", title: "x", type: "check-run", name: "x", workflow: ".github/workflows/ci.yml" }] } } }), /unknown stage "production"/);
  // Observer identity is the workflow path, so a check-run or branch-head without one is rejected (a bare file name too).
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "x", title: "x", type: "check-run", name: "Required Checks Gate" }] } } }), /check-run needs workflow/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "x", title: "x", type: "check-run", name: "Required Checks Gate", workflow: "ci.yml" }] } } }), /check-run needs workflow/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "x", title: "x", type: "branch-head", repo: "o/r", branch: "development" }] } } }), /branch-head needs workflow/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [{ id: "x", title: "x", type: "status" }] } } }), /unknown type "status"/);
  assert.throws(() => validateConfig({ stages: { development: { base: "delivery", signals: [
    { id: "x", title: "x", type: "check-run", name: "a", workflow: ".github/workflows/ci.yml" },
    { id: "x", title: "y", type: "check-run", name: "b", workflow: ".github/workflows/ci.yml" },
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
  // A newer success from a fork or a pull_request run is not an observation of the stage; the repository's own run is.
  const repo = "MonetizeKit/performance";
  const own = { ...recentSuccess, conclusion: "failure", event: "schedule", head_repository: { full_name: repo } };
  const forkSuccess = { ...recentSuccess, created_at: "2026-09-15T05:30:00Z", event: "schedule", head_repository: { full_name: "someone/performance" } };
  const prSuccess = { ...recentSuccess, created_at: "2026-09-15T05:40:00Z", event: "pull_request", head_repository: { full_name: repo } };
  assert.equal(classifyWorkflowRuns([own, forkSuccess, prSuccess], { now: NOW, maxAgeHours: 30, repo }).state, "fail");
  assert.equal(classifyWorkflowRuns([forkSuccess, prSuccess], { now: NOW, maxAgeHours: 30, repo }).state, "pending");
  // A stub of the observer on a feature branch, or a same-named file elsewhere, is not the observer: only the declared
  // path on the trusted branch counts, so the default-branch failure stands.
  const real = { ...own, path: ".github/workflows/nightly.yml", head_branch: "main" };
  const stub = { ...recentSuccess, created_at: "2026-09-15T05:50:00Z", event: "workflow_dispatch", head_repository: { full_name: repo }, path: ".github/workflows/nightly.yml", head_branch: "feat/stub" };
  const elsewhere = { ...recentSuccess, created_at: "2026-09-15T05:55:00Z", event: "push", head_repository: { full_name: repo }, path: ".github/workflows/other.yml", head_branch: "main" };
  const pinned = { now: NOW, maxAgeHours: 30, repo, path: ".github/workflows/nightly.yml", branch: "main" };
  assert.equal(classifyWorkflowRuns([real, stub, elsewhere], pinned).state, "fail");
  assert.equal(classifyWorkflowRuns([stub, elsewhere], pinned).state, "pending");
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

/**
 * A workflow run of `path` for `sha` and its jobs, the way the API reports them
 * (GET /actions/workflows/<file>/runs?head_sha= and GET /actions/runs/<id>/jobs).
 * `jobs` is a list of { name, conclusion, status? }.
 */
function observerRun({ repo, sha, runId, path = ".github/workflows/ci.yml", event = "push", headRepo = repo, jobs, runOverrides = {} }) {
  const run = { id: runId, event, head_sha: sha, head_branch: "development", path, html_url: `https://github.com/${repo}/actions/runs/${runId}`, repository: { full_name: repo }, head_repository: { full_name: headRepo }, ...runOverrides };
  const jobList = jobs.map((job, index) => ({ id: runId * 10 + index, run_id: runId, status: "completed", html_url: `${run.html_url}/job/${runId * 10 + index}`, ...job }));
  return { run, jobs: jobList, routes: { [`${repo}/actions/runs/${runId}/jobs`]: { total_count: jobList.length, jobs: jobList } } };
}

/** Routes for GET /actions/workflows/<file>/runs?head_sha=<sha> answering with the given runs (asserting the head_sha filter is used). */
function runsByShaRoute(repo, file, sha, runs) {
  return { [`${repo}/actions/workflows/${file}/runs`]: (params) => { assert.equal(params.head_sha, sha, `${file} runs are filtered by head_sha`); return { total_count: runs.length, workflow_runs: runs }; } };
}

function developmentRoutes({ ciConclusion = "success", docsRuns = true, driftIssues = [], modelIssues = [], webConclusion = "success", extraCiRuns = [], extraDocsRuns = [], forgedChecks = [] } = {}) {
  const webHead = "d".repeat(40);
  const mono = "MonetizeKit/mono";
  const ci = observerRun({ repo: mono, sha: HEAD, runId: 100, jobs: [{ name: "Lint" }, { name: "Required Checks Gate", conclusion: ciConclusion }] });
  // A deployment_status-triggered CI run skips the gate job after the push run's real verdict: not informative.
  const ciSkipped = observerRun({ repo: mono, sha: HEAD, runId: 101, event: "deployment_status", jobs: [{ name: "Required Checks Gate", conclusion: "skipped" }] });
  const docsOld = observerRun({ repo: mono, sha: HEAD, runId: 105, event: "deployment_status", path: ".github/workflows/docs-post-deploy.yml", jobs: [{ name: "Docs Post-Deploy / development", conclusion: "failure" }] });
  const docsNew = observerRun({ repo: mono, sha: HEAD, runId: 109, event: "deployment_status", path: ".github/workflows/docs-post-deploy.yml", jobs: [{ name: "Docs Post-Deploy / development", conclusion: "success" }] });
  const web = observerRun({ repo: "MonetizeKit/app-monetizekit-web", sha: webHead, runId: 300, jobs: [{ name: "Required Checks Gate", conclusion: webConclusion }] });
  // Stage Review publishes its check run via the API; its workflow has no job by that name, so it never binds (advisory anyway).
  const review = observerRun({ repo: mono, sha: HEAD, runId: 200, event: "workflow_run", path: ".github/workflows/stage-review.yml", jobs: [{ name: "Publish verdict", conclusion: "success" }] });
  const ciRuns = [ci.run, ciSkipped.run, ...extraCiRuns.map((extra) => extra.run)];
  const docsRunsList = docsRuns ? [docsOld.run, docsNew.run, ...extraDocsRuns.map((extra) => extra.run)] : extraDocsRuns.map((extra) => extra.run);
  return {
    ...ci.routes, ...ciSkipped.routes, ...docsOld.routes, ...docsNew.routes, ...web.routes, ...review.routes,
    ...Object.assign({}, ...extraCiRuns.map((extra) => extra.routes), ...extraDocsRuns.map((extra) => extra.routes)),
    ...runsByShaRoute(mono, "ci.yml", HEAD, ciRuns),
    ...runsByShaRoute(mono, "docs-post-deploy.yml", HEAD, docsRunsList),
    ...runsByShaRoute(mono, "stage-review.yml", HEAD, [review.run]),
    ...runsByShaRoute("MonetizeKit/app-monetizekit-web", "ci.yml", webHead, [web.run]),
    "MonetizeKit/mono/branches/development": { commit: { sha: HEAD } },
    [`MonetizeKit/mono/commits/${HEAD}`]: { commit: { committer: { date: "2026-09-14T22:00:00Z" } } },
    // Check runs exist on the commit — some forged — and must never be read.
    [`MonetizeKit/mono/commits/${HEAD}/check-runs`]: () => { throw new Error("the evaluator must not read check runs"); },
    "MonetizeKit/mono/compare/delivery...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { total_commits: 2, commits: [{ sha: HEAD }, { sha: OLD }] },
    "MonetizeKit/mono/issues": (params) => (params.labels === "examples-drift" ? driftIssues : params.labels === "model-usage-drift" ? modelIssues : []),
    "MonetizeKit/mono/issues/7/comments": [{ body: `follow-up escalation in ${OLD}` }],
    "MonetizeKit/app-monetizekit-web/branches/development": { commit: { sha: webHead } },
    [`MonetizeKit/app-monetizekit-web/commits/${webHead}/check-runs`]: () => { throw new Error("the evaluator must not read check runs"); },
  };
}

test("untrustedObserverRunReason: only this repository's own non-PR run of the pinned workflow for this SHA", () => {
  const mono = "MonetizeKit/mono";
  const ctx = { repo: mono, workflow: ".github/workflows/ci.yml", sha: HEAD };
  const good = observerRun({ repo: mono, sha: HEAD, runId: 100, jobs: [] }).run;
  assert.equal(untrustedObserverRunReason(good, ctx), null);
  const cases = [
    ["missing", null, /no workflow run/],
    ["another repository", { ...good, repository: { full_name: "someone/fork" }, head_repository: { full_name: "someone/fork" } }, /belongs to someone\/fork/],
    ["fork code", { ...good, head_repository: { full_name: "someone/fork" } }, /ran code from someone\/fork/],
    ["pull_request", { ...good, event: "pull_request" }, /triggered by pull_request/],
    ["pull_request_target", { ...good, event: "pull_request_target" }, /triggered by pull_request_target/],
    ["same-named job in another workflow (collision)", { ...good, path: ".github/workflows/forge.yml" }, /is \.github\/workflows\/forge\.yml, not \.github\/workflows\/ci\.yml/],
    ["another SHA", { ...good, head_sha: OUTSIDE }, /ran for ccccccc, not this head/],
  ];
  for (const [label, run, pattern] of cases) assert.match(untrustedObserverRunReason(run, ctx) ?? "", pattern, label);
  for (const event of ["deployment_status", "workflow_run", "schedule", "push", "workflow_dispatch"]) {
    assert.equal(untrustedObserverRunReason({ ...good, event }, ctx), null, event);
  }
});

test("observerVerdict: the newest trusted run's job is the verdict; skipped jobs are not informative; untrusted runs and other jobs are ignored", async () => {
  const mono = "MonetizeKit/mono";
  const ctx = { repo: mono, workflow: ".github/workflows/ci.yml", sha: HEAD, name: "Required Checks Gate" };
  const green = observerRun({ repo: mono, sha: HEAD, runId: 100, jobs: [{ name: "Required Checks Gate", conclusion: "success" }] });
  const red = observerRun({ repo: mono, sha: HEAD, runId: 102, jobs: [{ name: "Required Checks Gate", conclusion: "failure" }] });
  const skipped = observerRun({ repo: mono, sha: HEAD, runId: 103, event: "deployment_status", jobs: [{ name: "Required Checks Gate", conclusion: "skipped" }] });
  const collision = observerRun({ repo: mono, sha: HEAD, runId: 104, path: ".github/workflows/forge.yml", jobs: [{ name: "Required Checks Gate", conclusion: "success" }] });
  const noJob = observerRun({ repo: mono, sha: HEAD, runId: 105, jobs: [{ name: "Lint", conclusion: "success" }] });
  const jobsByRun = Object.fromEntries([green, red, skipped, collision, noJob].map((item) => [item.run.id, item.jobs]));
  const lookups = [];
  const jobsOf = async (runId) => { lookups.push(runId); return jobsByRun[runId]; };

  // Newest informative run (102, red) beats the older green (100); the skipped 103 and the colliding 104 do not count.
  const verdict = await observerVerdict([green.run, red.run, skipped.run, collision.run, noJob.run], ctx, jobsOf);
  assert.equal(verdict.state, "fail");
  assert.equal(verdict.runId, 102);
  assert.match(verdict.detail, /job 1020 of \.github\/workflows\/ci\.yml run 102/);
  assert.deepEqual(lookups, [105, 103, 102], "newest first, colliding run never asked for jobs, stops at the first informative job");
  assert.match(verdict.rejected[0], /forge\.yml/);

  // Only a skipped run: reported as pending via the fallback, not pass.
  assert.equal((await observerVerdict([skipped.run], ctx, jobsOf)).state, "pending");
  // No run has the job: pending, not reported.
  const none = await observerVerdict([noJob.run], ctx, jobsOf);
  assert.equal(none.state, "pending");
  assert.match(none.detail, /none with a job named "Required Checks Gate"/);
  // No trusted run at all.
  const untrusted = await observerVerdict([collision.run], ctx, jobsOf);
  assert.equal(untrusted.state, "pending");
  assert.match(untrusted.detail, /no run of \.github\/workflows\/ci\.yml for this commit \(1 run\(s\) not trusted/);
  assert.equal((await observerVerdict([], ctx, jobsOf)).state, "pending");
});

test("evaluateStage: forged or replayed check runs cannot move a required signal — check runs are never read", async () => {
  const mono = "MonetizeKit/mono";
  // Replay: ci.yml ran twice for this SHA; the older run passed, the newest failed. An attacker mints a check run
  // pointing at the older job. The evaluator reads the newest run of ci.yml for the SHA and never the check run.
  const rerunRed = observerRun({ repo: mono, sha: HEAD, runId: 110, jobs: [{ name: "Required Checks Gate", conclusion: "failure" }] });
  const replay = await evaluateStage({ api: fakeApi(developmentRoutes({ ciConclusion: "success", extraCiRuns: [rerunRed] })), config: baseConfig, stage: "development", selfRepo: mono, now: NOW });
  const ci = replay.signals.find((signal) => signal.id === "ci");
  assert.equal(ci.state, "fail", "the newest ci.yml run for the SHA is the verdict");
  assert.match(ci.detail, /run 110/);
  assert.equal(replay.conclusion, "failure");

  // Collision: a second workflow on the stage SHA with a passing job named "Required Checks Gate", finishing after the
  // real ci.yml job failed. It is not a run of ci.yml, so it is not the observer.
  const colliding = observerRun({ repo: mono, sha: HEAD, runId: 901, path: ".github/workflows/forge.yml", jobs: [{ name: "Required Checks Gate", conclusion: "success" }] });
  const collided = await evaluateStage({ api: fakeApi(developmentRoutes({ ciConclusion: "failure", extraCiRuns: [colliding] })), config: baseConfig, stage: "development", selfRepo: mono, now: NOW });
  assert.equal(collided.signals.find((signal) => signal.id === "ci").state, "fail");
  assert.equal(collided.conclusion, "failure");

  // No genuine observer run for the SHA at all: the signal is pending — not pass, not fail — whatever check runs exist.
  const pending = await evaluateStage({ api: fakeApi(developmentRoutes({ docsRuns: false })), config: baseConfig, stage: "development", selfRepo: mono, now: NOW });
  const docs = pending.signals.find((signal) => signal.id === "docs");
  assert.equal(docs.state, "pending");
  assert.match(docs.detail, /no run of \.github\/workflows\/docs-post-deploy\.yml for this commit/);
  assert.equal(pending.conclusion, "pending");
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
    "MonetizeKit/performance": { default_branch: "main" },
    "MonetizeKit/mono": { default_branch: "main" },
    "MonetizeKit/performance/actions/workflows/nightly.yml/runs": (params) => {
      assert.equal(params.branch, "main", "workflow-run observers are read from the target repository's default branch");
      return { workflow_runs: [{ status: "completed", conclusion: "success", created_at: "2026-09-15T04:17:00Z", html_url: "p", event: "schedule", head_branch: "main", path: ".github/workflows/nightly.yml", head_repository: { full_name: "MonetizeKit/performance" } }] };
    },
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
