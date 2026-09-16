#!/usr/bin/env node
// Stage Gate evaluator.
//
// Reads a repository's `.github/stage-gate.json`, resolves the head of the
// requested stage branch (`development` or `delivery`), asks every declared
// observing loop what it concluded about that head, and publishes one
// aggregate check run — `Stage Gate / <stage>` — on the stage SHA. Promotion
// (`reusable-promote.yml`) reads that check run and nothing else, so the set of
// loops that can hold a promotion is exactly the set declared in the config.
//
// Signal types (see schemas/stage-gate.schema.json):
//   check-run     a check run by name on the stage SHA (push CI gate, Docs
//                 Post-Deploy, Interactive Delivery, Checkly, Stage Review)
//   workflow-run  the latest completed run of a workflow, optionally required to
//                 have started after the stage head landed (nightly observers)
//   branch-head   a check run by name on another branch head (fleet health)
//   drift-clear   no open drift issue that cites a commit in `base..head`
//                 (`cites-range`) or no open issue at all (`any-open`)
//
// A required signal that failed makes the gate `failure`; a required signal
// that has not reported yet leaves the gate `in_progress` (pending); anything
// else is `success`.
//
// Observer verdicts are read from workflow runs, never from check runs. Any
// workflow with `checks: write` can mint a check run under any name on the
// stage SHA, pointing wherever it likes, so a `check-run`/`branch-head` signal
// is evaluated as: the newest run of exactly the declared `workflow` path for
// this SHA (GET /actions/workflows/<file>/runs?head_sha=), from this
// repository's own code (not a fork, not a pull_request event), and within it
// the job named `name` — job objects are written only by GitHub. That job's
// status/conclusion is the verdict. Newest run wins, so an older success cannot
// be replayed past a newer failure, and a forged check run is simply never
// consulted. A signal whose workflow has no run with that job for this SHA is
// *not reported* (pending). `workflow-run` signals count only runs of exactly
// `.github/workflows/<workflow>` from the target repository's own code on its
// default branch (or the declared `branch`), so a stub of the observer on a
// feature branch is not an observation.
//
//   node evaluate.mjs --repo OWNER/REPO --stage development \
//     --config .github/stage-gate.json [--sha <sha>] [--publish] [--out file]
//
// Environment: GITHUB_TOKEN (checks:write on --repo), GH_PAT (optional, used
// for repositories other than --repo so private fleet members are readable),
// GITHUB_RUN_URL (details link on the check run).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGES = Object.freeze(["development", "delivery"]);
export const CHECK_NAME_PREFIX = "Stage Gate / ";
const SHA_PATTERN = /\b[0-9a-f]{7,40}\b/g;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** `nightly.yml` -> `.github/workflows/nightly.yml`; a path is returned as is. */
export function workflowPath(workflow) {
  return workflow.includes("/") ? workflow : `.github/workflows/${workflow}`;
}

// --------------------------------------------------------------------------
// GitHub API access (injectable for tests)
// --------------------------------------------------------------------------

export function createGitHubApi({ token, fleetToken, selfRepo, fetchImpl = fetch, baseUrl = "https://api.github.com" }) {
  return {
    async getJson(repo, route, params = {}) {
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
      const queryString = query.toString();
      const url = `${baseUrl}/repos/${repo}${route}${queryString ? `?${queryString}` : ""}`;
      const auth = repo === selfRepo || !fleetToken ? token : fleetToken;
      const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
      let response = await fetchImpl(url, { headers: { ...headers, authorization: `Bearer ${auth}` } });
      // A repo-scoped installation token is rejected outright by other
      // repositories; public fleet members are still readable anonymously.
      if (response.status === 401 && repo !== selfRepo && !fleetToken) {
        response = await fetchImpl(url, { headers });
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${(await response.text()).slice(0, 300)}`);
      return response.json();
    },
    async postJson(repo, route, body) {
      const url = `${baseUrl}/repos/${repo}${route}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status} for POST ${url}: ${(await response.text()).slice(0, 300)}`);
      return response.json();
    },
  };
}

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

export function loadConfig(configPath) {
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  validateConfig(parsed);
  return parsed;
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return ["config must be an object"];
  if (!config.stages || typeof config.stages !== "object") errors.push("config.stages must be an object");
  for (const [stage, spec] of Object.entries(config.stages ?? {})) {
    if (!STAGES.includes(stage)) errors.push(`unknown stage "${stage}"; expected one of ${STAGES.join(", ")}`);
    if (!spec || typeof spec !== "object") { errors.push(`stages.${stage} must be an object`); continue; }
    if (typeof spec.base !== "string" || !spec.base) errors.push(`stages.${stage}.base must name the downstream branch`);
    if (!Array.isArray(spec.signals) || spec.signals.length === 0) { errors.push(`stages.${stage}.signals must be a non-empty array`); continue; }
    const ids = new Set();
    for (const signal of spec.signals) {
      const label = `stages.${stage}.signals[${signal?.id ?? "?"}]`;
      if (!signal?.id) errors.push(`${label}: id is required`);
      if (ids.has(signal?.id)) errors.push(`${label}: duplicate id`);
      ids.add(signal?.id);
      if (!signal?.title) errors.push(`${label}: title is required`);
      switch (signal?.type) {
        case "check-run":
          if (!signal.name) errors.push(`${label}: check-run needs name`);
          if (!WORKFLOW_PATH.test(signal.workflow ?? "")) errors.push(`${label}: check-run needs workflow (path like .github/workflows/ci.yml of the workflow whose job produces the check)`);
          break;
        case "workflow-run":
          if (!signal.workflow) errors.push(`${label}: workflow-run needs workflow (file name)`);
          if (signal.maxAgeHours !== undefined && !(Number(signal.maxAgeHours) > 0)) errors.push(`${label}: maxAgeHours must be > 0`);
          if (signal.absent !== undefined && !["pending", "skip"].includes(signal.absent)) errors.push(`${label}: absent must be pending|skip`);
          break;
        case "branch-head":
          if (!signal.repo) errors.push(`${label}: branch-head needs repo`);
          if (!signal.branch) errors.push(`${label}: branch-head needs branch`);
          if (!WORKFLOW_PATH.test(signal.workflow ?? "")) errors.push(`${label}: branch-head needs workflow (path like .github/workflows/ci.yml in that repository)`);
          break;
        case "drift-clear":
          if (!Array.isArray(signal.labels) || signal.labels.length === 0) errors.push(`${label}: drift-clear needs labels`);
          if (signal.mode !== undefined && !["cites-range", "any-open"].includes(signal.mode)) errors.push(`${label}: mode must be cites-range|any-open`);
          break;
        default:
          errors.push(`${label}: unknown type "${signal?.type}"`);
      }
    }
  }
  if (errors.length) throw new Error(`invalid stage-gate config:\n- ${errors.join("\n- ")}`);
  return true;
}

// --------------------------------------------------------------------------
// Signal evaluation
// --------------------------------------------------------------------------

export const UNTRUSTED_OBSERVER_EVENTS = Object.freeze(["pull_request", "pull_request_target"]);

/** Why a workflow run may NOT be trusted as an observation of `sha` by `workflow`, or null when it may. */
export function untrustedObserverRunReason(run, { repo, workflow, sha }) {
  if (!run) return "no workflow run";
  const id = run.id ?? "?";
  if ((run.repository?.full_name ?? "").toLowerCase() !== repo.toLowerCase()) return `run ${id} belongs to ${run.repository?.full_name ?? "another repository"}, not ${repo}`;
  const headRepo = run.head_repository?.full_name ?? run.repository?.full_name ?? "";
  if (headRepo.toLowerCase() !== repo.toLowerCase()) return `run ${id} ran code from ${headRepo || "an unknown repository"} (fork), not ${repo}`;
  if (UNTRUSTED_OBSERVER_EVENTS.includes(run.event)) return `run ${id} was triggered by ${run.event}; pull request runs cannot observe a stage head`;
  if (run.path !== workflow) return `run ${id} is ${run.path ?? "an unknown workflow"}, not ${workflow}`;
  if ((run.head_sha ?? "").toLowerCase() !== sha.toLowerCase()) return `run ${id} ran for ${(run.head_sha ?? "?").slice(0, 7)}, not this head`;
  return null;
}

/** Classify a job's (or any status/conclusion pair's) verdict. */
export function classifyCheckRun(run) {
  if (!run) return { state: "pending", detail: "no check run reported for this commit yet" };
  if (run.status !== "completed") return { state: "pending", detail: `check run is ${run.status}`, url: run.html_url };
  if (run.conclusion === "success") return { state: "pass", detail: "success", url: run.html_url };
  if (run.conclusion === "skipped" || run.conclusion === "neutral") {
    return { state: "pending", detail: `check run concluded ${run.conclusion}; waiting for a run that observed this commit`, url: run.html_url };
  }
  if (FAILED_CONCLUSIONS.has(run.conclusion)) return { state: "fail", detail: `check run concluded ${run.conclusion}`, url: run.html_url };
  return { state: "pending", detail: `unrecognised conclusion ${run.conclusion}`, url: run.html_url };
}

/**
 * The verdict of the job named `name` in the newest trusted run of `workflow`
 * for `sha`. Pure over the fetched runs and a jobs lookup. A run whose job
 * concluded `skipped`/`neutral` is not informative (a `deployment_status`-
 * triggered CI run skips "Required Checks Gate" after the push run's real one),
 * so the search continues to the next-newest run and falls back to the newest
 * such run only when nothing informative exists.
 * @param {object[]} runs
 * @param {(runId: number|string) => Promise<object[]>} jobsOf
 */
export async function observerVerdict(runs, { repo, workflow, sha, name, maxRuns = 10 }, jobsOf) {
  const ordered = [...(runs ?? [])].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  const rejected = [];
  let fallback = null;
  let considered = 0;
  for (const run of ordered) {
    if (considered >= maxRuns) break;
    const reason = untrustedObserverRunReason(run, { repo, workflow, sha });
    if (reason) {
      rejected.push(reason);
      continue;
    }
    considered += 1;
    const job = (await jobsOf(run.id)).find((candidate) => candidate.name === name);
    if (!job) continue;
    const verdict = { ...classifyCheckRun({ status: job.status, conclusion: job.conclusion, html_url: job.html_url ?? run.html_url }), runId: run.id, jobId: job.id, path: run.path, bound: true };
    verdict.detail = `${verdict.detail} (job ${job.id} of ${run.path} run ${run.id})`;
    if (job.status === "completed" && ["skipped", "neutral"].includes(job.conclusion)) {
      fallback ??= verdict;
      continue;
    }
    return { ...verdict, considered, rejected };
  }
  if (fallback) return { ...fallback, considered, rejected };
  const why = considered === 0
    ? `no run of ${workflow} for this commit${rejected.length ? ` (${rejected.length} run(s) not trusted: ${rejected[0]})` : ""}`
    : `${considered} run(s) of ${workflow} for this commit, none with a job named "${name}"`;
  return { state: "pending", detail: `${why}; the observer has not reported`, bound: false, considered, rejected };
}

/**
 * Observer verdict for a named job of a pinned workflow on a SHA: runs of that
 * workflow file filtered by head_sha, then the job by name — no check run is
 * read at any point.
 */
async function observerOnSha(api, repo, sha, name, workflow) {
  const file = workflow.split("/").pop();
  const data = await api.getJson(repo, `/actions/workflows/${encodeURIComponent(file)}/runs`, { head_sha: sha, per_page: 50 });
  return observerVerdict(
    data?.workflow_runs ?? [],
    { repo, workflow, sha, name },
    async (runId) => (await api.getJson(repo, `/actions/runs/${runId}/jobs`, { per_page: 100 }))?.jobs ?? [],
  );
}

export function classifyWorkflowRuns(runs, { now, maxAgeHours = 36, afterHead = false, headCommittedAt, absent = "pending", repo, path, branch }) {
  const cutoff = now - maxAgeHours * 3600_000;
  const considered = (runs ?? [])
    .filter((run) => run.status === "completed" && run.conclusion !== "cancelled" && run.conclusion !== "skipped")
    // Only the observer itself, from the target repository's own code on the trusted branch:
    // not a fork, not a pull request run, not a same-named file elsewhere, not a stub on a feature branch.
    .filter((run) => !UNTRUSTED_OBSERVER_EVENTS.includes(run.event))
    .filter((run) => !repo || !run.head_repository?.full_name || run.head_repository.full_name.toLowerCase() === repo.toLowerCase())
    .filter((run) => !path || !run.path || run.path === path)
    .filter((run) => !branch || !run.head_branch || run.head_branch === branch)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = considered[0];
  if (!latest || Date.parse(latest.created_at) < cutoff) {
    const detail = latest
      ? `latest completed run ${latest.created_at} is older than ${maxAgeHours}h`
      : "no completed run found";
    if (absent === "skip") return { state: "skipped", detail: `${detail}; the loop is not observing this stage right now`, url: latest?.html_url };
    return { state: "pending", detail: `${detail}; waiting for the next cycle`, url: latest?.html_url };
  }
  if (afterHead && headCommittedAt && Date.parse(latest.created_at) < Date.parse(headCommittedAt)) {
    return { state: "pending", detail: `latest run ${latest.created_at} started before the stage head landed (${headCommittedAt}); soaking until the next cycle`, url: latest.html_url };
  }
  if (latest.conclusion === "success") return { state: "pass", detail: `run ${latest.created_at} succeeded`, url: latest.html_url };
  return { state: "fail", detail: `run ${latest.created_at} concluded ${latest.conclusion}`, url: latest.html_url };
}

export function extractShas(text) {
  return new Set((text ?? "").match(SHA_PATTERN) ?? []);
}

export function issueCitesRange(citedShas, rangeShas) {
  for (const cited of citedShas) {
    for (const full of rangeShas) {
      if (full.startsWith(cited) || cited.startsWith(full)) return full;
    }
  }
  return null;
}

async function listRangeCommits(api, repo, base, head) {
  const commits = [];
  for (let page = 1; page <= 20; page++) {
    const data = await api.getJson(repo, `/compare/${encodeURIComponent(base)}...${head}`, { per_page: 250, page });
    if (!data) break;
    commits.push(...(data.commits ?? []).map((commit) => commit.sha));
    if ((data.commits ?? []).length < 250 || commits.length >= (data.total_commits ?? 0)) break;
  }
  return commits;
}

async function driftClear(api, signal, { selfRepo, base, sha }) {
  const repo = signal.repo ?? selfRepo;
  const mode = signal.mode ?? "cites-range";
  const rangeShas = mode === "cites-range" ? await listRangeCommits(api, repo, base, sha) : [];
  const blocking = [];
  for (const label of signal.labels) {
    const issues = (await api.getJson(repo, "/issues", { state: "open", labels: label, per_page: 100 })) ?? [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      if (mode === "any-open") {
        blocking.push({ issue, reason: `open ${label} issue` });
        continue;
      }
      const cited = extractShas(issue.body);
      if (issue.comments > 0) {
        const comments = (await api.getJson(repo, `/issues/${issue.number}/comments`, { per_page: 100 })) ?? [];
        for (const comment of comments) for (const s of extractShas(comment.body)) cited.add(s);
      }
      if (cited.size === 0) {
        blocking.push({ issue, reason: `open ${label} issue cites no commit, so it cannot be excluded from ${base}..${sha.slice(0, 7)}` });
        continue;
      }
      const hit = issueCitesRange(cited, rangeShas);
      if (hit) blocking.push({ issue, reason: `open ${label} issue cites ${hit.slice(0, 7)}, which is in ${base}..${sha.slice(0, 7)}` });
    }
  }
  if (blocking.length === 0) {
    return { state: "pass", detail: mode === "any-open" ? `no open ${signal.labels.join("/")} issue` : `no open ${signal.labels.join("/")} issue cites a commit in ${base}..${sha.slice(0, 7)} (${rangeShas.length} commits)` };
  }
  return {
    state: "fail",
    detail: blocking.map(({ issue, reason }) => `#${issue.number} ${issue.title} — ${reason}`).join("; "),
    url: blocking[0].issue.html_url,
  };
}

/** The target repository's default branch, cached on the evaluation context. */
async function defaultBranchOf(api, repo, context) {
  context.defaultBranches ??= new Map();
  if (!context.defaultBranches.has(repo)) {
    const repository = await api.getJson(repo, "");
    if (!repository?.default_branch) throw new Error(`${repo}: could not resolve the default branch`);
    context.defaultBranches.set(repo, repository.default_branch);
  }
  return context.defaultBranches.get(repo);
}

export async function evaluateSignal(api, signal, context) {
  const repo = signal.repo ?? context.selfRepo;
  try {
    switch (signal.type) {
      case "check-run":
        return await observerOnSha(api, repo, context.sha, signal.name, signal.workflow);
      case "workflow-run": {
        const branch = signal.branch ?? (await defaultBranchOf(api, repo, context));
        const data = await api.getJson(repo, `/actions/workflows/${encodeURIComponent(signal.workflow)}/runs`, {
          status: "completed",
          per_page: 30,
          branch,
          event: signal.event,
        });
        return classifyWorkflowRuns(data?.workflow_runs, {
          repo,
          path: workflowPath(signal.workflow),
          branch,
          now: context.now,
          maxAgeHours: signal.maxAgeHours,
          afterHead: signal.afterHead ?? false,
          headCommittedAt: context.headCommittedAt,
          absent: signal.absent,
        });
      }
      case "branch-head": {
        const branch = await api.getJson(repo, `/branches/${encodeURIComponent(signal.branch)}`);
        if (!branch?.commit?.sha) return { state: "fail", detail: `${repo}@${signal.branch} does not exist` };
        const result = await observerOnSha(api, repo, branch.commit.sha, signal.check ?? "Required Checks Gate", signal.workflow);
        return { ...result, detail: `${repo}@${signal.branch} (${branch.commit.sha.slice(0, 7)}): ${result.detail}` };
      }
      case "drift-clear":
        return await driftClear(api, signal, context);
      default:
        return { state: "fail", detail: `unknown signal type ${signal.type}` };
    }
  } catch (error) {
    return { state: "pending", detail: `evaluation error: ${error.message}` };
  }
}

// --------------------------------------------------------------------------
// Aggregation
// --------------------------------------------------------------------------

export function aggregate(results) {
  const required = results.filter((result) => result.required);
  if (required.some((result) => result.state === "fail")) return "failure";
  if (required.some((result) => result.state === "pending")) return "pending";
  return "success";
}

const STATE_ICON = { pass: "✅", fail: "❌", pending: "⏳", skipped: "➖" };

export function renderSummary(evaluation) {
  const { stage, repo, sha, base, conclusion, signals, evaluatedAt } = evaluation;
  const lines = [
    `**${CHECK_NAME_PREFIX}${stage}** for \`${repo}\` @ \`${sha.slice(0, 7)}\` (promotes into \`${base}\`) — **${conclusion}**`,
    "",
    "| | Signal | Kind | Result | Detail |",
    "|---|---|---|---|---|",
  ];
  for (const signal of signals) {
    const kind = signal.required ? "required" : "advisory";
    const detail = signal.url ? `${signal.detail} ([link](${signal.url}))` : signal.detail;
    lines.push(`| ${STATE_ICON[signal.state] ?? "?"} | ${signal.title} | ${kind} | ${signal.state} | ${detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", `_Evaluated ${evaluatedAt}. Advisory signals never change the conclusion; a required signal that has not reported keeps the gate in progress._`);
  return lines.join("\n");
}

export async function evaluateStage({ api, config, stage, selfRepo, sha, now = Date.now() }) {
  const spec = config.stages?.[stage];
  if (!spec) throw new Error(`stage "${stage}" is not declared in the config`);
  let headSha = sha;
  if (!headSha) {
    const branch = await api.getJson(selfRepo, `/branches/${encodeURIComponent(stage)}`);
    if (!branch?.commit?.sha) throw new Error(`${selfRepo} has no ${stage} branch`);
    headSha = branch.commit.sha;
  }
  const commit = await api.getJson(selfRepo, `/commits/${headSha}`);
  const headCommittedAt = commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
  const context = { selfRepo, sha: headSha, base: spec.base, now, headCommittedAt };
  const signals = [];
  for (const signal of spec.signals) {
    const result = await evaluateSignal(api, signal, context);
    signals.push({ id: signal.id, title: signal.title, type: signal.type, required: signal.required !== false, ...result });
  }
  const evaluation = {
    stage,
    repo: selfRepo,
    sha: headSha,
    base: spec.base,
    headCommittedAt,
    evaluatedAt: new Date(now).toISOString(),
    conclusion: aggregate(signals),
    signals,
  };
  evaluation.summary = renderSummary(evaluation);
  return evaluation;
}

/**
 * Name of the evidence artifact the Stage Gate workflow uploads for one
 * evaluation. The conclusion is part of the name so the promotion bot can
 * verify a verdict by listing the producing run's artifacts — an artifact can
 * only be created by the run that owns it, unlike a check run, which any
 * workflow with `checks: write` can mint under any name.
 */
export function evidenceArtifactName(stage, sha, conclusion) {
  return `stage-gate-${stage}-${sha}-${conclusion}`;
}

/**
 * `external_id` of the published check run: `stage-gate:<stage>:<run id>`.
 * The run id is advisory (a forged check run can carry any external_id); the
 * promotion bot uses it to find the producing workflow run and then verifies
 * that run's identity and artifacts.
 */
export function checkRunExternalId(stage, runId) {
  return runId ? `stage-gate:${stage}:${runId}` : `stage-gate:${stage}`;
}

export function checkRunPayload(evaluation, { detailsUrl, runId } = {}) {
  const blocking = evaluation.signals.filter((signal) => signal.required && signal.state !== "pass" && signal.state !== "skipped");
  const title = evaluation.conclusion === "success"
    ? `All ${evaluation.signals.filter((signal) => signal.required).length} required signals passed`
    : evaluation.conclusion === "failure"
      ? `${blocking.filter((signal) => signal.state === "fail").length} required signal(s) failed`
      : `Waiting on ${blocking.length} required signal(s)`;
  const payload = {
    name: `${CHECK_NAME_PREFIX}${evaluation.stage}`,
    head_sha: evaluation.sha,
    external_id: checkRunExternalId(evaluation.stage, runId),
    details_url: detailsUrl || undefined,
    output: { title, summary: evaluation.summary.slice(0, 65000) },
  };
  if (evaluation.conclusion === "pending") {
    payload.status = "in_progress";
  } else {
    payload.status = "completed";
    payload.conclusion = evaluation.conclusion;
    payload.completed_at = evaluation.evaluatedAt;
  }
  return payload;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { publish: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--publish") args.publish = true;
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selfRepo = args.repo ?? process.env.GITHUB_REPOSITORY;
  if (!selfRepo || !args.stage || !args.config) {
    console.error("usage: evaluate.mjs --repo OWNER/REPO --stage development|delivery --config path [--sha sha] [--publish] [--out file]");
    process.exit(2);
  }
  if (!STAGES.includes(args.stage)) {
    console.error(`--stage must be one of ${STAGES.join(", ")}`);
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN is required");
    process.exit(2);
  }
  const config = loadConfig(args.config);
  const api = createGitHubApi({ token, fleetToken: process.env.GH_PAT || undefined, selfRepo });
  const evaluation = await evaluateStage({ api, config, stage: args.stage, selfRepo, sha: args.sha });

  console.log(evaluation.summary);
  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(evaluation, null, 2)}\n`);
  }
  if (args.publish) {
    const run = await api.postJson(selfRepo, "/check-runs", checkRunPayload(evaluation, { detailsUrl: process.env.GITHUB_RUN_URL, runId: process.env.GITHUB_RUN_ID }));
    console.log(`published ${run.name} (${run.status}${run.conclusion ? `/${run.conclusion}` : ""}) on ${evaluation.sha}: ${run.html_url}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `conclusion=${evaluation.conclusion}\nsha=${evaluation.sha}\nartifact_name=${evidenceArtifactName(evaluation.stage, evaluation.sha, evaluation.conclusion)}\n`,
      { flag: "a" },
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${evaluation.summary}\n`, { flag: "a" });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
