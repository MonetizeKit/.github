#!/usr/bin/env node
// Promotion bot.
//
// Walks one hop of the promotion chain for a repository:
//
//   development -> delivery   automatic: when `Stage Gate / development` is
//                             green on the development head, open or update the
//                             promotion PR and enable auto-merge; GitHub merges
//                             it when the required checks pass. No human in
//                             the path.
//   delivery -> main          prepared, human-authorized: when `Stage Gate /
//                             delivery` is green (plus an optional extra soak),
//                             open or update the PR with the changelog draft,
//                             the loop-by-loop gate evidence and the review
//                             findings across the included feature PRs. Never
//                             merges; branch protection on main is the release
//                             gate.
//
// The bot reads the stage gate check run and nothing else, so what can hold a
// promotion is exactly what `.github/stage-gate.json` declares. It has no route
// to `main`: the workflow token cannot bypass protection, and feature PRs that
// target `delivery` or `main` directly are failed by the `promotion-guard`
// check (scripts/promote/guard.mjs).
//
//   node run.mjs --repo OWNER/REPO --source development --target delivery \
//     --gate "Stage Gate / development" [--soak-minutes N] [--auto-merge] \
//     [--changelog-file path] [--dry-run] [--out file]
//
// Environment: GITHUB_TOKEN (contents:read, pull-requests:write); GH_PAT — a
// user or app token used to open the PR so that its CI runs (a PR opened with
// the workflow's own GITHUB_TOKEN triggers no workflows, and a PR whose required
// checks never report can never auto-merge). Falls back to GITHUB_TOKEN with a
// warning. GITHUB_RUN_URL for the evidence footer.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOPS = Object.freeze({
  development: "delivery",
  delivery: "main",
});
export const PROMOTION_LABEL = "promotion";
export const PROMOTION_MARKER = "<!-- monetizekit-promotion -->";
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const MAX_INCLUDED_PRS = 60;
const MAX_BODY_CHARS = 60_000;

// --------------------------------------------------------------------------
// GitHub API (injectable for tests)
// --------------------------------------------------------------------------

export function createGitHubApi({ token, writeToken, fetchImpl = fetch, baseUrl = "https://api.github.com", graphqlUrl = "https://api.github.com/graphql" }) {
  const headers = (auth) => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${auth}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  });
  async function request(method, url, body, auth) {
    const response = await fetchImpl(url, { method, headers: headers(auth), body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${method} ${url}: ${(await response.text()).slice(0, 400)}`);
    if (response.status === 204) return null;
    return response.json();
  }
  return {
    /** Reads use the workflow token. */
    getJson(repo, route, params = {}) {
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));
      const qs = query.toString();
      return request("GET", `${baseUrl}/repos/${repo}${route}${qs ? `?${qs}` : ""}`, undefined, token);
    },
    /** Writes that must trigger workflows (PR open/update) use the write token. */
    postJson(repo, route, body) {
      return request("POST", `${baseUrl}/repos/${repo}${route}`, body, writeToken ?? token);
    },
    patchJson(repo, route, body) {
      return request("PATCH", `${baseUrl}/repos/${repo}${route}`, body, writeToken ?? token);
    },
    async graphql(query, variables) {
      const response = await fetchImpl(graphqlUrl, { method: "POST", headers: headers(writeToken ?? token), body: JSON.stringify({ query, variables }) });
      const data = await response.json();
      if (!response.ok || data.errors?.length) {
        const error = new Error(`GitHub GraphQL: ${JSON.stringify(data.errors ?? data).slice(0, 400)}`);
        error.graphqlErrors = data.errors ?? [];
        throw error;
      }
      return data.data;
    },
    usesWriteToken: Boolean(writeToken),
  };
}

// --------------------------------------------------------------------------
// Decisions (pure)
// --------------------------------------------------------------------------

export function latestCheckRun(runs) {
  if (!runs?.length) return null;
  const byNewest = [...runs].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  const informative = byNewest.filter((run) => run.status !== "completed" || !["skipped", "neutral"].includes(run.conclusion));
  return informative[0] ?? byNewest[0];
}

/**
 * Is the gate green for this head, and has the soak elapsed?
 * @returns {{ state: "green"|"red"|"pending"|"soaking", detail: string, run?: object, readyAt?: string }}
 */
export function gateState(run, { soakMinutes = 0, now = Date.now() } = {}) {
  if (!run) return { state: "pending", detail: "the gate has not reported for this head yet" };
  if (run.status !== "completed") return { state: "pending", detail: `the gate is ${run.status}`, run };
  if (run.conclusion !== "success") {
    return { state: FAILED_CONCLUSIONS.has(run.conclusion) ? "red" : "pending", detail: `the gate concluded ${run.conclusion}`, run };
  }
  const completedAt = Date.parse(run.completed_at ?? "");
  if (soakMinutes > 0 && Number.isFinite(completedAt)) {
    const readyAt = completedAt + soakMinutes * 60_000;
    if (readyAt > now) {
      return { state: "soaking", detail: `the gate went green at ${run.completed_at}; soaking until ${new Date(readyAt).toISOString()}`, run, readyAt: new Date(readyAt).toISOString() };
    }
  }
  return { state: "green", detail: `the gate is green (${run.completed_at})`, run };
}

/** Pull request numbers referenced by merge and squash commits in the range. */
export function includedPullNumbers(commits) {
  const numbers = new Set();
  for (const commit of commits ?? []) {
    const message = commit.commit?.message ?? commit.message ?? "";
    const firstLine = message.split("\n")[0];
    const merge = /^Merge pull request #(\d+)/.exec(firstLine);
    if (merge) {
      numbers.add(Number(merge[1]));
      continue;
    }
    const squash = /\(#(\d+)\)\s*$/.exec(firstLine);
    if (squash) numbers.add(Number(squash[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Parse the shadow reviewer's structured findings out of its PR comment.
 * Returns important/nit counts and the important findings themselves.
 */
export function reviewFindingsFromComments(comments) {
  const verdicts = (comments ?? []).filter((comment) => /Shadow reviewer verdict/.test(comment.body ?? ""));
  if (verdicts.length === 0) return null;
  const latest = verdicts[verdicts.length - 1];
  const block = /```json\s*([\s\S]*?)```/.exec(latest.body ?? "");
  if (!block) return { important: 0, nits: 0, findings: [], parsed: false };
  let doc;
  try {
    doc = JSON.parse(block[1]);
  } catch {
    return { important: 0, nits: 0, findings: [], parsed: false };
  }
  const findings = [];
  for (const lens of doc.lenses ?? []) {
    for (const finding of lens.findings ?? []) {
      findings.push({ lens: lens.lens ?? lens.id ?? "?", ...finding });
    }
  }
  const important = findings.filter((finding) => finding.label === "important");
  return {
    important: important.length,
    nits: findings.length - important.length,
    findings: important,
    parsed: true,
    model: doc.model ?? null,
  };
}

export function promotionTitle(source, target, headSha) {
  return `promote: ${source} -> ${target} (${headSha.slice(0, 7)})`;
}

/**
 * Compose the PR body. Deterministic: everything in it is quoted from the gate
 * check run, the compare API, the included PRs and the shadow-review comments.
 */
export function renderBody({ repo, source, target, headSha, baseSha, gate, commits, pulls, reviews, changelog, autoMerge, runUrl, now = Date.now() }) {
  const lines = [PROMOTION_MARKER, ""];
  lines.push(`Promotion of \`${source}\` into \`${target}\` at \`${headSha.slice(0, 7)}\` — ${commits.length} commit(s) since \`${baseSha.slice(0, 7)}\`.`);
  lines.push("");
  if (autoMerge) {
    lines.push("**Automatic.** Auto-merge is enabled; GitHub merges this when the required checks pass. Nobody needs to review it: every change here already passed its feature-PR review and the stage gate below.");
  } else {
    lines.push("**Prepared for human authorization.** This PR is never merged by automation. A code-owner approval is the release gate; approving and merging is the act of releasing.");
  }
  lines.push("");
  lines.push(`## Gate evidence — ${gate.run?.name ?? "Stage Gate"}`);
  lines.push("");
  lines.push(`${gate.detail}${gate.run?.html_url ? ` ([check run](${gate.run.html_url}))` : ""}.`);
  const summary = gate.run?.output?.summary?.trim();
  if (summary) {
    lines.push("", "<details><summary>Loop-by-loop verdict quoted from the check run</summary>", "", summary, "", "</details>");
  }
  if (changelog?.trim()) {
    lines.push("", "## Changelog draft", "", changelog.trim());
  }
  lines.push("", `## Included pull requests (${pulls.length})`, "");
  if (pulls.length === 0) {
    lines.push("_No pull request references found in the range (direct commits only)._");
  } else {
    lines.push("| PR | Title | Review findings |", "|----|-------|-----------------|");
    for (const pull of pulls) {
      const review = reviews.get(pull.number);
      const verdict = !review ? "no shadow review" : !review.parsed ? "review posted, findings unparsed" : `${review.important} important, ${review.nits} nit`;
      lines.push(`| #${pull.number} | ${(pull.title ?? "").replace(/\|/g, "\\|")} | ${verdict} |`);
    }
  }
  const important = [...reviews.values()].flatMap((review) => (review?.findings ?? []).map((finding) => ({ ...finding, pr: [...reviews.entries()].find(([, r]) => r === review)?.[0] })));
  if (important.length > 0) {
    lines.push("", `## Important review findings carried into ${target} (${important.length})`, "");
    lines.push("Reviewers flagged these on the feature PRs; the authors merged past them (or dismissed with 👎). Listed so the release decision sees them.", "");
    for (const finding of important.slice(0, 40)) {
      lines.push(`- #${finding.pr} \`${finding.lens}\` **${finding.file ?? ""}**${finding.line ? `:${finding.line}` : ""} — ${(finding.problem ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
    }
    if (important.length > 40) lines.push(`- …and ${important.length - 40} more`);
  }
  lines.push("", "---", "");
  lines.push(`_Opened by the promotion bot (\`reusable-promote.yml\`, role \`promotion-bot\`) at ${new Date(now).toISOString()}${runUrl ? ` from [this run](${runUrl})` : ""}. Head \`${headSha}\`; base \`${baseSha}\`. Feature PRs target \`development\`; this PR carries them one stage forward and adds no diff of its own._`);
  const body = lines.join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n_…truncated_` : body;
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

async function listRangeCommits(api, repo, base, head) {
  const commits = [];
  for (let page = 1; page <= 4; page++) {
    const data = await api.getJson(repo, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { per_page: 250, page });
    if (!data) break;
    commits.push(...(data.commits ?? []));
    if (page === 1 && data.status === "identical") return { commits: [], aheadBy: 0, behindBy: data.behind_by ?? 0, baseSha: data.merge_base_commit?.sha ?? data.base_commit?.sha };
    if ((data.commits ?? []).length < 250 || commits.length >= (data.total_commits ?? 0)) {
      return { commits, aheadBy: data.ahead_by ?? commits.length, behindBy: data.behind_by ?? 0, baseSha: data.merge_base_commit?.sha ?? data.base_commit?.sha };
    }
  }
  return { commits, aheadBy: commits.length, behindBy: 0, baseSha: null };
}

async function ensureLabels(api, repo, labels) {
  for (const { name, color, description } of labels) {
    const existing = await api.getJson(repo, `/labels/${encodeURIComponent(name)}`);
    if (existing) continue;
    try {
      await api.postJson(repo, "/labels", { name, color, description });
    } catch (error) {
      if (!/422/.test(String(error.message))) throw error;
    }
  }
}

async function findOpenPromotionPr(api, repo, source, target) {
  const owner = repo.split("/")[0];
  const pulls = await api.getJson(repo, "/pulls", { state: "open", head: `${owner}:${source}`, base: target, per_page: 10 });
  return (pulls ?? []).find((pull) => pull.head?.ref === source && pull.base?.ref === target) ?? null;
}

async function enableAutoMerge(api, pull) {
  const mutation = `mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) { pullRequest { autoMergeRequest { enabledAt } } } }`;
  try {
    const data = await api.graphql(mutation, { id: pull.node_id });
    return { enabled: true, enabledAt: data.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt ?? null };
  } catch (error) {
    const text = String(error.message);
    // Repo setting "Allow auto-merge" off, or the PR is already mergeable with
    // no pending checks (GitHub refuses auto-merge on a clean PR).
    if (/auto.?merge/i.test(text) || /not allowed|not enabled|clean status/i.test(text)) return { enabled: false, reason: text.slice(0, 300) };
    throw error;
  }
}

export async function promote({ api, repo, source, target, gateName, soakMinutes = 0, autoMerge = false, changelog = "", dryRun = false, runUrl, now = Date.now() }) {
  if (HOPS[source] !== target) throw new Error(`unsupported hop ${source} -> ${target}; chain is development -> delivery -> main`);
  const branch = await api.getJson(repo, `/branches/${encodeURIComponent(source)}`);
  if (!branch?.commit?.sha) throw new Error(`${repo} has no ${source} branch`);
  const headSha = branch.commit.sha;
  const targetBranch = await api.getJson(repo, `/branches/${encodeURIComponent(target)}`);
  if (!targetBranch?.commit?.sha) throw new Error(`${repo} has no ${target} branch`);

  const range = await listRangeCommits(api, repo, target, source);
  const result = { repo, source, target, headSha, targetSha: targetBranch.commit.sha, aheadBy: range.aheadBy, behindBy: range.behindBy, gate: null, status: null, pr: null, autoMerge: null };

  if (range.aheadBy === 0) {
    result.status = "nothing-to-promote";
    result.detail = `${target} already contains ${source}@${headSha.slice(0, 7)}`;
    return result;
  }

  const checks = await api.getJson(repo, `/commits/${headSha}/check-runs`, { check_name: gateName, per_page: 50 });
  const gate = gateState(latestCheckRun(checks?.check_runs), { soakMinutes, now });
  result.gate = { state: gate.state, detail: gate.detail, url: gate.run?.html_url ?? null, readyAt: gate.readyAt ?? null };
  if (gate.state !== "green") {
    result.status = `gate-${gate.state}`;
    result.detail = `${gateName} on ${headSha.slice(0, 7)}: ${gate.detail}`;
    return result;
  }

  const numbers = includedPullNumbers(range.commits).slice(0, MAX_INCLUDED_PRS);
  const pulls = [];
  const reviews = new Map();
  for (const number of numbers) {
    const pull = await api.getJson(repo, `/pulls/${number}`);
    if (!pull) continue;
    pulls.push({ number, title: pull.title, url: pull.html_url });
    const comments = await api.getJson(repo, `/issues/${number}/comments`, { per_page: 100 });
    const review = reviewFindingsFromComments(comments ?? []);
    if (review) reviews.set(number, review);
  }

  const title = promotionTitle(source, target, headSha);
  const body = renderBody({ repo, source, target, headSha, baseSha: range.baseSha ?? targetBranch.commit.sha, gate, commits: range.commits, pulls, reviews, changelog, autoMerge, runUrl, now });
  result.title = title;
  result.body = body;

  if (dryRun) {
    result.status = "dry-run";
    result.detail = `would ${autoMerge ? "open and auto-merge" : "open"} ${source} -> ${target} for ${headSha.slice(0, 7)} (${pulls.length} PRs)`;
    return result;
  }

  await ensureLabels(api, repo, [
    { name: PROMOTION_LABEL, color: "0e8a16", description: "Promotion PR opened by the promotion bot" },
    { name: `stage:${target}`, color: "1d76db", description: `Promotes into ${target}` },
  ]);
  let pull = await findOpenPromotionPr(api, repo, source, target);
  if (pull) {
    await api.patchJson(repo, `/pulls/${pull.number}`, { title, body });
    result.status = "updated";
  } else {
    pull = await api.postJson(repo, "/pulls", { title, body, head: source, base: target, maintainer_can_modify: false });
    result.status = "opened";
  }
  await api.postJson(repo, `/issues/${pull.number}/labels`, { labels: [PROMOTION_LABEL, `stage:${target}`] });
  result.pr = { number: pull.number, url: pull.html_url };

  if (autoMerge) {
    const merge = await enableAutoMerge(api, pull);
    result.autoMerge = merge;
    if (!merge.enabled) result.warning = `auto-merge could not be enabled: ${merge.reason}. Enable "Allow auto-merge" in the repository settings, or merge #${pull.number} by hand.`;
  }
  result.detail = `${result.status} #${pull.number} ${source} -> ${target} for ${headSha.slice(0, 7)}`;
  return result;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { "auto-merge": false, "dry-run": false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--auto-merge" || arg === "--dry-run") args[arg.slice(2)] = true;
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const source = args.source;
  const target = args.target ?? HOPS[source];
  if (!repo || !source || !target || !args.gate) {
    console.error("usage: run.mjs --repo OWNER/REPO --source development|delivery [--target delivery|main] --gate 'Stage Gate / <stage>' [--soak-minutes N] [--auto-merge] [--changelog-file path] [--dry-run] [--out file]");
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN is required");
    process.exit(2);
  }
  const writeToken = process.env.GH_PAT || undefined;
  if (!writeToken && !args["dry-run"]) {
    console.log("::warning::GH_PAT is not set; opening the PR with GITHUB_TOKEN. Workflows will not run on a PR opened by the workflow token, so its required checks cannot report and auto-merge cannot complete. Provision GH_PAT (Phase -> Actions).");
  }
  const api = createGitHubApi({ token, writeToken });
  const changelog = args["changelog-file"] ? readFileSync(args["changelog-file"], "utf8") : "";
  const result = await promote({
    api,
    repo,
    source,
    target,
    gateName: args.gate,
    soakMinutes: Number(args["soak-minutes"] ?? 0),
    autoMerge: Boolean(args["auto-merge"]),
    changelog,
    dryRun: Boolean(args["dry-run"]),
    runUrl: process.env.GITHUB_RUN_URL,
  });

  const { body, ...printable } = result;
  console.log(JSON.stringify(printable, null, 2));
  if (result.warning) console.log(`::warning::${result.warning}`);
  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\nsha=${result.headSha}\npr_number=${result.pr?.number ?? ""}\npr_url=${result.pr?.url ?? ""}\n`, { flag: "a" });
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## Promotion ${source} -> ${target}`, "", `**${result.status}** — ${result.detail ?? ""}`, ""];
    if (result.gate) lines.push(`Gate: ${result.gate.state} — ${result.gate.detail}${result.gate.url ? ` ([check run](${result.gate.url}))` : ""}`, "");
    if (result.pr) lines.push(`PR: ${result.pr.url}`, "");
    if (result.warning) lines.push(`> ${result.warning}`, "");
    if (body && result.status === "dry-run") lines.push("<details><summary>Body that would be posted</summary>", "", body, "", "</details>");
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
