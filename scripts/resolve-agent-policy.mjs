#!/usr/bin/env node
// Resolve one agent role from agent-policy.json and print it as GitHub Actions
// outputs (or JSON), so workflows never carry a model ID of their own.
//
//   node resolve-agent-policy.mjs --role shadow-reviewer [--policy path] [--json]
//
// Outputs (also written to $GITHUB_OUTPUT when set):
//   model           gateway-style id, e.g. anthropic/claude-sonnet-5
//   bare            provider prefix stripped, e.g. claude-sonnet-5 (for Anthropic-API runtimes)
//   fallback        gateway-style fallback id
//   route           gateway | direct-anthropic | cursor-cloud-agent | none
//   tools           comma-joined allowlist in claude-code-action syntax
//   max_output_tokens, max_usd_per_run   budget fields when declared
//   quorum_models   comma-joined quorum list when declared
//   policy_version  the policy version, for provenance footers
//   anthropic_base_url   set only when route == gateway (Anthropic-compatible gateway URL)
//
// Exit codes: 0 resolved; 2 role missing or not a policy-selected model role
// (operator/none roles are still printed, with model empty, so a caller can
// decide); 3 policy unreadable.

import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const role = flag("role");
const asJson = flag("json", false) === true;
const here = path.dirname(fileURLToPath(import.meta.url));
const policyPath = flag("policy", path.resolve(here, "..", "agent-policy.json"));

if (!role || role === true) {
  console.error("usage: resolve-agent-policy.mjs --role <id> [--policy path] [--json]");
  process.exit(2);
}

let policy;
try {
  policy = JSON.parse(readFileSync(policyPath, "utf8"));
} catch (error) {
  console.error(`cannot read policy at ${policyPath}: ${error.message}`);
  process.exit(3);
}

const entry = policy.roles?.[role];
if (!entry) {
  console.error(`role "${role}" is not declared in ${policyPath}`);
  process.exit(2);
}

const model = entry.model_selection === "policy" ? entry.model : "";
const out = {
  role,
  model_selection: entry.model_selection,
  model,
  bare: model.includes("/") ? model.slice(model.indexOf("/") + 1) : model,
  fallback: entry.model_selection === "policy" ? entry.fallback : "",
  route: entry.route,
  tools: (entry.tools ?? []).join(","),
  max_output_tokens: entry.budget?.max_output_tokens ?? "",
  max_usd_per_run: entry.budget?.max_usd_per_run ?? "",
  quorum_models: (entry.quorum?.models ?? []).join(","),
  status: entry.status ?? "active",
  owner: entry.owner,
  policy_version: policy.policy_version,
  anthropic_base_url:
    entry.route === "gateway" ? policy.gateway?.anthropic_compatible_base_url ?? "" : "",
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [key, value] of Object.entries(out)) console.log(`${key}=${value}`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(out)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}
process.exit(entry.model_selection === "policy" ? 0 : 2);
