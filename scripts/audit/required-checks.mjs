#!/usr/bin/env node
// Required-checks audit.
//
// A branch ruleset requires status checks by context name, and GitHub counts
// a check run that concluded `skipped` as satisfying it. So a required context
// is only a gate when every check run that can ever carry that name is the
// result of a job that actually ran and judged the change. This audit reads
// each stage branch's effective rules and the workflows on that branch, and
// fails when a required context:
//
//   multiple-emitters   is produced by more than one job
//   foreign-trigger     comes from a workflow that also runs on events other
//                       than pull_request / push / merge_group /
//                       workflow_dispatch (a deployment_status or schedule run
//                       posts the same name, typically skipped, on the commit)
//   skippable           comes from a job without `if: always()`: it is skipped
//                       when a needed job fails, or under another event
//   unchecked-need      comes from an aggregator that needs a job whose result
//                       its steps never read (a skipped or failed need passes)
//   conditional-name    comes from a job whose name is an expression but not
//                       bound to its own run condition (`<cond> && '<C>' || ...`
//                       with `if: always() && ...`)
//   ungated-branch      guards a stage branch (development, delivery, main)
//                       that requires no status check at all
//   unpinned            (warning) is not pinned to the GitHub Actions app, so
//                       any integration can post it
//   no-emitter          (warning) is produced by no workflow job on the branch.
//                       Fail-closed, not a hole: a missing required check blocks
//                       the merge, and a pull_request run takes its workflows
//                       from the merge ref, so a PR that adds the emitter (a
//                       promotion carrying promote.yml) still reports it
//
// Skipped jobs keep their unevaluated `${{ }}` name, so a job whose name is
// an expression can only ever carry the literal it evaluates to when it runs.
// A skipped reusable-workflow caller is reported under the caller's name only,
// never `<caller> / <inner>`.
//
//   node required-checks.mjs [--org MonetizeKit] [--repos a,b] [--out report.json]
//
// Environment: GH_TOKEN or GITHUB_TOKEN with read access to every audited
// repository (contents and rules).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

export const STAGE_BRANCHES = Object.freeze(["development", "delivery", "main"]);
export const GATE_EVENTS = Object.freeze(["pull_request", "push", "merge_group", "workflow_dispatch"]);
export const GITHUB_ACTIONS_APP_ID = 15368;

// --------------------------------------------------------------------------
// Analysis (pure)
// --------------------------------------------------------------------------

/** The events a parsed workflow triggers on. */
export function triggersOf(workflow) {
  const on = workflow?.on ?? workflow?.true;
  if (!on) return [];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

/** `${{ always() }}`, `always()` and whitespace variants normalise to `always()`. */
export function normaliseExpression(value) {
  if (value === undefined || value === null) return "";
  let text = String(value).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1];
  return text.replace(/\s+/g, " ").trim();
}

function needsOf(job) {
  if (!job?.needs) return [];
  return Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)];
}

function stepsText(job) {
  return JSON.stringify(job?.steps ?? []);
}

/** Needs whose result the job's steps never read (and no blanket `needs.*` / `toJSON(needs)` read). */
export function uncheckedNeeds(job) {
  const text = stepsText(job);
  if (/needs\.\*\.result|toJSON\(needs\)/.test(text)) return [];
  return needsOf(job).filter((need) => !text.includes(`needs.${need}.result`));
}

/**
 * Every job, across the given workflows, whose check run can carry `context`.
 * @param {{ path: string, workflow: object }[]} workflows
 */
export function emittersOf(context, workflows) {
  const emitters = [];
  for (const { path: workflowPath, workflow } of workflows) {
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      const name = job?.name === undefined ? jobId : String(job.name);
      const isExpression = name.includes("${{");
      if (job?.uses) {
        if (!isExpression && context.startsWith(`${name} / `)) {
          emitters.push({ kind: "reusable", path: workflowPath, jobId, job, workflow, inner: context.slice(name.length + 3) });
        }
        continue;
      }
      if (!isExpression && name === context) emitters.push({ kind: "literal", path: workflowPath, jobId, job, workflow });
      else if (isExpression && name.includes(`'${context}'`)) emitters.push({ kind: "conditional", path: workflowPath, jobId, job, workflow });
    }
  }
  return emitters;
}

/** Findings for one emitter of a required context. */
export function emitterFindings(context, emitter, { innerJob } = {}) {
  const findings = [];
  const where = `${emitter.path}#${emitter.jobId}`;
  const condition = normaliseExpression(emitter.job?.if);
  if (emitter.kind === "literal") {
    const foreign = triggersOf(emitter.workflow).filter((event) => !GATE_EVENTS.includes(event));
    if (foreign.length > 0) {
      findings.push({ level: "error", code: "foreign-trigger", context, where, detail: `${emitter.path} also runs on ${foreign.join(", ")}; those runs post "${context}" on the same commit (skipped or judged without the change's checks)` });
    }
    if (condition !== "always()") {
      findings.push({ level: "error", code: "skippable", context, where, detail: condition ? `\`if: ${condition}\` can skip the job, and a skipped "${context}" satisfies the ruleset` : `no \`if: always()\`: the job is skipped when a needed job fails, and a skipped "${context}" satisfies the ruleset` });
    }
  }
  if (emitter.kind === "conditional") {
    const name = normaliseExpression(emitter.job?.name);
    const bound = /^\(?([\s\S]+?)\)?\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'$/.exec(name);
    if (!bound || bound[2] !== context || bound[3] === context) {
      findings.push({ level: "error", code: "conditional-name", context, where, detail: `the job name is an expression that is not \`<condition> && '${context}' || '<other>'\`` });
    }
    if (!condition.startsWith("always() &&")) {
      findings.push({ level: "error", code: "skippable", context, where, detail: `a job that is given the name "${context}" must run whenever its condition holds (\`if: always() && <condition>\`), found \`if: ${condition || "(none)"}\`` });
    }
  }
  if (emitter.kind === "reusable" && innerJob !== undefined) {
    if (innerJob === null) {
      findings.push({ level: "warning", code: "no-emitter", context, where, detail: `the called workflow has no job named "${emitter.inner}"; PRs wait unless they bring it themselves` });
    } else {
      const innerCondition = normaliseExpression(innerJob.if);
      if (needsOf(innerJob).length > 0 && innerCondition !== "always()") {
        findings.push({ level: "error", code: "skippable", context, where, detail: `the called job "${emitter.inner}" needs other jobs without \`if: always()\`` });
      } else if (innerCondition && innerCondition !== "always()") {
        findings.push({ level: "error", code: "skippable", context, where, detail: `the called job "${emitter.inner}" has \`if: ${innerCondition}\`` });
      }
    }
  }
  const job = emitter.kind === "reusable" ? innerJob : emitter.job;
  for (const need of job ? uncheckedNeeds(job) : []) {
    findings.push({ level: "error", code: "unchecked-need", context, where, detail: `needs \`${need}\` but its steps never read \`needs.${need}.result\`` });
  }
  return findings;
}

/**
 * Audit one branch.
 * @param {{ repo: string, branch: string, required: { context: string, integration_id?: number }[], workflows: { path: string, workflow: object }[], innerJobOf?: (emitter) => object|null|undefined }} input
 */
export function auditBranch({ repo, branch, required, workflows, innerJobOf = () => undefined }) {
  const findings = [];
  const at = `${repo}@${branch}`;
  if (STAGE_BRANCHES.includes(branch) && required.length === 0) {
    findings.push({ level: "error", code: "ungated-branch", context: null, where: at, detail: `${branch} requires no status check, so anything that can be merged into it is ungated` });
  }
  for (const check of required) {
    const context = check.context;
    if (check.integration_id !== undefined && check.integration_id !== null && check.integration_id !== GITHUB_ACTIONS_APP_ID) continue;
    if (check.integration_id === undefined || check.integration_id === null) {
      findings.push({ level: "warning", code: "unpinned", context, where: at, detail: `"${context}" is not pinned to the GitHub Actions app (integration ${GITHUB_ACTIONS_APP_ID}); any integration can post it` });
    }
    const emitters = emittersOf(context, workflows);
    if (emitters.length === 0) {
      findings.push({ level: "warning", code: "no-emitter", context, where: at, detail: `no workflow job on ${branch} produces "${context}"; PRs wait unless they bring it themselves` });
      continue;
    }
    if (emitters.length > 1) {
      findings.push({ level: "error", code: "multiple-emitters", context, where: at, detail: `"${context}" is produced by ${emitters.map((emitter) => `${emitter.path}#${emitter.jobId}`).join(", ")}` });
    }
    for (const emitter of emitters) findings.push(...emitterFindings(context, emitter, { innerJob: emitter.kind === "reusable" ? innerJobOf(emitter) : undefined }));
  }
  return findings.map((finding) => ({ repo, branch, ...finding }));
}

export function renderReport(results) {
  const errors = results.flatMap((result) => result.findings.filter((finding) => finding.level === "error"));
  const warnings = results.flatMap((result) => result.findings.filter((finding) => finding.level === "warning"));
  const lines = ["## Required-checks audit", "", `${results.length} branch(es) audited: ${errors.length} error(s), ${warnings.length} warning(s).`, ""];
  lines.push("| Repository | Branch | Required contexts | Errors |", "|---|---|---|---|");
  for (const result of results) {
    lines.push(`| ${result.repo} | ${result.branch} | ${result.required.map((check) => `\`${check.context}\``).join(", ") || "—"} | ${result.findings.filter((finding) => finding.level === "error").length} |`);
  }
  for (const [title, list] of [["Errors", errors], ["Warnings", warnings]]) {
    if (list.length === 0) continue;
    lines.push("", `### ${title}`, "");
    for (const finding of list) lines.push(`- \`${finding.code}\` ${finding.repo}@${finding.branch}${finding.context ? ` "${finding.context}"` : ""} (${finding.where}): ${finding.detail}`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Collection
// --------------------------------------------------------------------------

function createApi(token, fetchImpl = fetch) {
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
  return async function getJson(route) {
    const response = await fetchImpl(`https://api.github.com${route}`, { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status} for GET ${route}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  };
}

async function workflowsAt(getJson, repo, ref) {
  const listing = (await getJson(`/repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`)) ?? [];
  const workflows = [];
  for (const entry of listing) {
    if (entry.type !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const file = await getJson(`/repos/${repo}/contents/${entry.path}?ref=${encodeURIComponent(ref)}`);
    const source = Buffer.from(file?.content ?? "", "base64").toString("utf8");
    workflows.push({ path: entry.path, workflow: YAML.parse(source) ?? {} });
  }
  return workflows;
}

/** `uses: ./.github/workflows/x.yml` or `uses: OWNER/REPO/.github/workflows/x.yml@ref`. */
export function parseUses(uses, { repo, ref }) {
  const local = /^\.\/(\.github\/workflows\/[^@]+)$/.exec(uses);
  if (local) return { repo, path: local[1], ref };
  const remote = /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@(.+)$/.exec(uses);
  if (remote) return { repo: remote[1], path: remote[2], ref: remote[3] };
  return null;
}

async function collectBranch(getJson, repo, branch, cache) {
  const rules = (await getJson(`/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`)) ?? [];
  const required = rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? []);
  const workflows = await workflowsAt(getJson, repo, branch);
  const inner = new Map();
  for (const check of required) {
    for (const emitter of emittersOf(check.context, workflows)) {
      if (emitter.kind !== "reusable") continue;
      const target = parseUses(String(emitter.job.uses), { repo, ref: branch });
      if (!target) continue;
      const key = `${target.repo}/${target.path}@${target.ref}`;
      if (!cache.has(key)) {
        const file = await getJson(`/repos/${target.repo}/contents/${target.path}?ref=${encodeURIComponent(target.ref)}`);
        cache.set(key, file ? YAML.parse(Buffer.from(file.content ?? "", "base64").toString("utf8")) ?? {} : null);
      }
      const called = cache.get(key);
      const job = called ? Object.entries(called.jobs ?? {}).find(([jobId, candidate]) => (candidate?.name ?? jobId) === emitter.inner)?.[1] ?? null : null;
      inner.set(`${emitter.path}#${emitter.jobId}`, job);
    }
  }
  return { required, workflows, innerJobOf: (emitter) => inner.get(`${emitter.path}#${emitter.jobId}`) };
}

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GH_TOKEN or GITHUB_TOKEN is required");
    process.exit(2);
  }
  const getJson = createApi(token);
  const org = args.org ?? "MonetizeKit";
  let repos = args.repos ? args.repos.split(",").map((name) => name.trim()).filter(Boolean) : null;
  if (!repos) {
    repos = [];
    for (let page = 1; page <= 10; page++) {
      const batch = (await getJson(`/orgs/${org}/repos?per_page=100&page=${page}`)) ?? [];
      repos.push(...batch.filter((repository) => !repository.archived).map((repository) => repository.name));
      if (batch.length < 100) break;
    }
  }
  const results = [];
  const cache = new Map();
  for (const name of repos.sort()) {
    const repo = name.includes("/") ? name : `${org}/${name}`;
    for (const branch of STAGE_BRANCHES) {
      if (!(await getJson(`/repos/${repo}/branches/${encodeURIComponent(branch)}`))) continue;
      const collected = await collectBranch(getJson, repo, branch, cache);
      results.push({ repo, branch, required: collected.required, findings: auditBranch({ repo, branch, ...collected }) });
    }
  }
  const report = renderReport(results);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, { flag: "a" });
  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(results.map(({ repo, branch, required, findings }) => ({ repo, branch, required, findings })), null, 2)}\n`);
  }
  const errors = results.reduce((count, result) => count + result.findings.filter((finding) => finding.level === "error").length, 0);
  process.exit(errors > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
