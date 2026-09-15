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
//   node guard.mjs --base main --head delivery [--labels "a,b"]
//
// In a workflow the event payload supplies base/head/labels via env
// (GITHUB_BASE_REF, GITHUB_HEAD_REF, PR_LABELS).

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = Object.freeze({
  delivery: "development",
  main: "delivery",
});
export const OVERRIDE_LABEL = "promotion-override";

/**
 * @param {{ baseRef: string, headRef: string, labels?: string[] }} pr
 * @returns {{ pass: boolean, guarded: boolean, override: boolean, reason: string }}
 */
export function guardDecision({ baseRef, headRef, labels = [] }) {
  const expected = UPSTREAM[baseRef];
  if (!expected) {
    return { pass: true, guarded: false, override: false, reason: `\`${baseRef}\` is not a guarded stage branch; feature PRs belong here` };
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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRef = args.base ?? process.env.GITHUB_BASE_REF;
  const headRef = args.head ?? process.env.GITHUB_HEAD_REF;
  const labels = String(args.labels ?? process.env.PR_LABELS ?? "").split(",").map((label) => label.trim()).filter(Boolean);
  if (!baseRef || !headRef) {
    console.error("usage: guard.mjs --base <branch> --head <branch> [--labels a,b]");
    process.exit(2);
  }
  const decision = guardDecision({ baseRef, headRef, labels });
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
  main();
}
