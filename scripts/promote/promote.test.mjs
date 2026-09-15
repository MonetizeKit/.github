// node --test scripts/promote/
import { test } from "node:test";
import assert from "node:assert/strict";

import { guardDecision, OVERRIDE_LABEL, UPSTREAM } from "./guard.mjs";
import {
  HOPS,
  PROMOTION_MARKER,
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

const greenGate = { id: 2, name: "Stage Gate / development", status: "completed", conclusion: "success", completed_at: "2026-09-15T05:00:00Z", html_url: "https://example/gate", output: { summary: "| ✅ | Required Checks Gate |" } };

function baseRoutes({ gate = greenGate, aheadBy = 2 } = {}) {
  return {
    [`${REPO}/branches/development`]: { commit: { sha: HEAD } },
    [`${REPO}/branches/delivery`]: { commit: { sha: TARGET } },
    [`${REPO}/branches/main`]: { commit: { sha: TARGET } },
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
  const soaking = gateState(greenGate, { soakMinutes: 120, now: NOW });
  assert.equal(soaking.state, "soaking");
  assert.equal(soaking.readyAt, "2026-09-15T07:00:00.000Z");
  assert.equal(gateState(greenGate, { soakMinutes: 30, now: NOW }).state, "green");
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

test("promote: soak keeps delivery -> main waiting after the gate goes green", async () => {
  const routes = baseRoutes();
  routes[`${REPO}/compare/main...delivery`] = routes[`${REPO}/compare/delivery...development`];
  routes[`${REPO}/branches/delivery`] = { commit: { sha: HEAD } };
  const api = fakeApi(routes);
  const result = await promote({ api, repo: REPO, source: "delivery", target: "main", gateName: "Stage Gate / delivery", soakMinutes: 180, now: NOW });
  assert.equal(result.status, "gate-soaking");
  assert.equal(result.gate.readyAt, "2026-09-15T08:00:00.000Z");
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
  const routes = baseRoutes();
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
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "development" }).pass, true);
  assert.equal(guardDecision({ baseRef: "main", headRef: "delivery" }).pass, true);
  assert.equal(guardDecision({ baseRef: "main", headRef: "development" }).pass, false);
  assert.equal(guardDecision({ baseRef: "main", headRef: "feat/x" }).pass, false);
  assert.equal(guardDecision({ baseRef: "delivery", headRef: "feat/x" }).pass, false);
  const feature = guardDecision({ baseRef: "development", headRef: "feat/x" });
  assert.equal(feature.pass, true);
  assert.equal(feature.guarded, false);
  const override = guardDecision({ baseRef: "main", headRef: "hotfix/x", labels: [OVERRIDE_LABEL] });
  assert.equal(override.pass, true);
  assert.equal(override.override, true);
  assert.match(override.reason, /audited exception/);
});
