#!/usr/bin/env node
// promotion-guard.
//
// A pull request into a stage branch other than `development` must be the
// promotion PR from the stage directly upstream of it — `development` into
// `delivery`, `delivery` into `main`. Anything else (a feature branch aimed at
// `main`, a fix aimed at `delivery`) fails this check, so the only route to
// production is the promotion chain and nothing skips a stage's observers.
//
// Emergency hotfixes are not silently allowed: the `promotion-override` label
// passes the check but the reason is spelled out in the check output, and
// `sdlc-metrics` counts overrides.
//
//   node guard.mjs --base main --head delivery --head-repo OWNER/REPO --base-repo OWNER/REPO [--labels "a,b"]
//
// In a workflow the event payload supplies base/head/labels via env
// (GITHUB_BASE_REF, GITHUB_HEAD_REF, PR_LABELS) and the repositories via
// PR_HEAD_REPO and GITHUB_REPOSITORY.
//
// The head branch NAME alone proves nothing: a fork can call any branch
// `development`. A guarded base therefore also requires the head to live in
// this repository, so `development` means this repository's `development`
// branch. The override label relaxes the hop, never the repository.
//
// Gate evidence (`--require-gate-evidence`, REQUIRE_GATE_EVIDENCE=true). The
// bot enables auto-merge for the head it saw green, but the PR head is the
// live stage branch: a commit that lands on `development` afterwards becomes
// the head, and only this check and `Required Checks Gate` re-run on it. So on
// the chain hop the guard also requires a trusted `Stage Gate / <source>`
// success for the exact head SHA — read exactly as the bot reads it, from the
// Stage Gate workflow's own default-branch runs and evidence artifacts — or a
// trusted success for a commit with the identical tree (a merge that changes
// no file, e.g. resyncing a stage branch). Without it the check fails until
// the gate reports; the bot's title/body update for the new head (an `edited`
// event) re-runs it. Needs `actions: read` on the caller's guard job.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_GATE_WORKFLOW, createGitHubApi, findTrustedVerdict, untrustedGateRunReason } from "./run.mjs";

export const UPSTREAM = Object.freeze({
  delivery: "development",
  main: "delivery",
});
export const OVERRIDE_LABEL = "promotion-override";

/**
 * @param {{ baseRef: string, headRef: string, labels?: string[], headRepo?: string, baseRepo?: string }} pr
 * @returns {{ pass: boolean, guarded: boolean, override: boolean, reason: string }}
 */
export function guardDecision({ baseRef, headRef, labels = [], headRepo, baseRepo }) {
  const expected = UPSTREAM[baseRef];
  if (!expected) {
    return { pass: true, guarded: false, override: false, reason: `\`${baseRef}\` is not a guarded stage branch; feature PRs belong here` };
  }
  const sameRepo = Boolean(headRepo) && Boolean(baseRepo) && headRepo.toLowerCase() === baseRepo.toLowerCase();
  if (!sameRepo) {
    return {
      pass: false,
      guarded: true,
      override: false,
      reason: `\`${baseRef}\` only accepts pull requests whose head lives in this repository (head repository: \`${headRepo || "unknown"}\`, this repository: \`${baseRepo || "unknown"}\`); a fork branch named \`${headRef}\` is not the stage branch. Push the change to a branch in this repository and target \`development\``,
    };
  }
  if (headRef === expected) {
    return { pass: true, guarded: true, override: false, reason: `promotion PR: \`${headRef}\` -> \`${baseRef}\` is the expected hop` };
  }
  if (labels.includes(OVERRIDE_LABEL)) {
    return { pass: true, guarded: true, override: true, reason: `\`${headRef}\` -> \`${baseRef}\` skips the chain (expected head \`${expected}\`); allowed by the \`${OVERRIDE_LABEL}\` label — this is an audited exception, not a route` };
  }
  return {
    pass: false,
    guarded: true,
    override: false,
    reason: `\`${baseRef}\` only accepts promotion PRs from \`${expected}\`; retarget this PR at \`development\` and let the chain carry it forward (or add \`${OVERRIDE_LABEL}\` for an audited hotfix)`,
  };
}

/**
 * Does a trusted Stage Gate evaluation vouch for exactly this head (or a
 * commit with the same tree)? The newest trusted evaluation of the head
 * decides when one exists — a later red cannot be outvoted by an older green.
 * @returns {Promise<{ pass: boolean, reason: string, gatedSha?: string, runId?: number|string, treeEqual?: boolean }>}
 */
export async function gateEvidenceDecision(api, { repo, stage, headSha, gateWorkflow = DEFAULT_GATE_WORKFLOW, maxTreeCandidates = 10 }) {
  const gate = `Stage Gate / ${stage}`;
  const short = headSha.slice(0, 7);
  const repository = await api.getJson(repo, "");
  const defaultBranch = repository?.default_branch;
  if (!defaultBranch) return { pass: false, reason: `could not resolve ${repo}'s default branch to read ${gate} evidence` };
  const workflowFile = gateWorkflow.split("/").pop();
  const runs = (await api.getJson(repo, `/actions/workflows/${encodeURIComponent(workflowFile)}/runs`, { branch: defaultBranch, status: "completed", per_page: 100 }))?.workflow_runs ?? [];
  const artifacts = new Map();
  const artifactNamesOf = async (runId) => {
    if (!artifacts.has(runId)) {
      artifacts.set(runId, ((await api.getJson(repo, `/actions/runs/${runId}/artifacts`, { per_page: 100 }))?.artifacts ?? []).map((artifact) => artifact.name));
    }
    return artifacts.get(runId);
  };

  const exact = await findTrustedVerdict(runs, { repo, defaultBranch, gateWorkflow, stage, headSha }, artifactNamesOf);
  if (exact.verdict) {
    const { conclusion, runId } = exact.verdict;
    if (conclusion === "success") return { pass: true, reason: `${gate} passed on ${short} (trusted evaluation run ${runId})`, gatedSha: headSha, runId, treeEqual: false };
    return { pass: false, reason: `the newest trusted ${gate} evaluation of ${short} (run ${runId}) is ${conclusion}; this check re-runs when the promotion bot updates the PR for a green gate`, runId };
  }

  // No evaluation of this exact head: accept the newest trusted verdict of a
  // commit whose tree is identical, when that verdict is a success.
  const headTree = (await api.getJson(repo, `/git/commits/${headSha}`))?.tree?.sha;
  const pattern = new RegExp(`^stage-gate-${stage}-([0-9a-f]{40})-(success|failure|pending)$`);
  const newestPerSha = new Map();
  for (const run of [...runs].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, 60)) {
    if (untrustedGateRunReason(run, { repo, defaultBranch, gateWorkflow })) continue;
    for (const name of await artifactNamesOf(run.id)) {
      const match = pattern.exec(name);
      if (match && !newestPerSha.has(match[1])) newestPerSha.set(match[1], { conclusion: match[2], runId: run.id });
    }
  }
  const candidates = [...newestPerSha.entries()].filter(([, verdict]) => verdict.conclusion === "success").slice(0, maxTreeCandidates);
  if (headTree) {
    for (const [sha, verdict] of candidates) {
      const tree = (await api.getJson(repo, `/git/commits/${sha}`))?.tree?.sha;
      if (tree && tree === headTree) {
        return { pass: true, reason: `${gate} passed on ${sha.slice(0, 7)} (trusted evaluation run ${verdict.runId}), whose tree is identical to ${short}`, gatedSha: sha, runId: verdict.runId, treeEqual: true };
      }
    }
  }
  return {
    pass: false,
    reason: `no trusted ${gate} evaluation of ${short} yet${headTree ? ` and none of the ${candidates.length} recently gated commit(s) has the same tree` : ""}; the head moved after the gate, so this check fails until the gate passes on it (the promotion bot's PR update re-runs this check)`,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--require-gate-evidence") args[arg.slice(2)] = "true";
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRef = args.base ?? process.env.GITHUB_BASE_REF;
  const headRef = args.head ?? process.env.GITHUB_HEAD_REF;
  const headRepo = args["head-repo"] ?? process.env.PR_HEAD_REPO;
  const baseRepo = args["base-repo"] ?? process.env.GITHUB_REPOSITORY;
  const headSha = args["head-sha"] ?? process.env.PR_HEAD_SHA;
  const requireEvidence = String(args["require-gate-evidence"] ?? process.env.REQUIRE_GATE_EVIDENCE ?? "false") === "true";
  const gateWorkflow = args["gate-workflow"] || process.env.GATE_WORKFLOW || DEFAULT_GATE_WORKFLOW;
  const labels = String(args.labels ?? process.env.PR_LABELS ?? "").split(",").map((label) => label.trim()).filter(Boolean);
  if (!baseRef || !headRef) {
    console.error("usage: guard.mjs --base <branch> --head <branch> --head-repo OWNER/REPO --base-repo OWNER/REPO [--labels a,b] [--require-gate-evidence --head-sha SHA [--gate-workflow path]]");
    process.exit(2);
  }
  const decision = guardDecision({ baseRef, headRef, labels, headRepo, baseRepo });
  if (requireEvidence && decision.pass && decision.guarded && !decision.override) {
    let evidence;
    if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) {
      evidence = { pass: false, reason: "the PR head SHA is unknown, so no gate evidence can be bound to it" };
    } else if (!process.env.GITHUB_TOKEN) {
      evidence = { pass: false, reason: "GITHUB_TOKEN is not set, so the gate evidence cannot be read" };
    } else {
      try {
        evidence = await gateEvidenceDecision(createGitHubApi({ token: process.env.GITHUB_TOKEN }), { repo: baseRepo, stage: headRef, headSha: headSha.toLowerCase(), gateWorkflow });
      } catch (error) {
        evidence = { pass: false, reason: `could not read the Stage Gate evidence (${String(error.message).slice(0, 200)}); the guard job needs actions: read` };
      }
    }
    decision.pass = evidence.pass;
    decision.reason = `${decision.reason}; ${evidence.reason}`;
  }
  const line = `${decision.pass ? "✅" : "❌"} promotion-guard: ${decision.reason}`;
  console.log(line);
  if (decision.override) console.log(`::warning::${decision.reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`, { flag: "a" });
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `pass=${decision.pass}\noverride=${decision.override}\n`, { flag: "a" });
  }
  process.exit(decision.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
