// node --test scripts/resolve-agent-policy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const resolver = path.join(here, "resolve-agent-policy.mjs");
const policyPath = path.join(here, "..", "agent-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));

function resolve(role, extraArgs = []) {
  const out = execFileSync("node", [resolver, "--role", role, "--json", ...extraArgs], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
  return JSON.parse(out);
}

test("a gateway role resolves the Anthropic-compatible base URL and no direct-provider fields", () => {
  const out = resolve("build-failure-triage");
  assert.equal(out.route, "gateway");
  assert.equal(out.anthropic_base_url, policy.gateway.anthropic_compatible_base_url);
  assert.equal(out.base_url, "");
  assert.equal(out.credential_env, "");
  assert.equal(out.api, "");
});

test("a direct-typesafe role resolves its provider endpoint, credential name and wire protocol from direct_providers", () => {
  const out = resolve("build-failure-triage:decision");
  assert.equal(out.route, "direct-typesafe");
  assert.equal(out.model, "typesafe/jev-1.13.0");
  assert.equal(out.bare, "jev-1.13.0");
  assert.equal(out.base_url, policy.direct_providers.typesafe.base_url);
  assert.equal(out.credential_env, "TYPESAFE_API_KEY");
  assert.equal(out.api, "systemone");
  assert.equal(out.anthropic_base_url, "", "a direct route never inherits the gateway URL");
});

test("a direct route whose provider is not declared resolves empty provider fields instead of guessing", () => {
  const broken = structuredClone(policy);
  delete broken.direct_providers;
  const dir = mkdtempSync(path.join(tmpdir(), "policy-"));
  const file = path.join(dir, "agent-policy.json");
  writeFileSync(file, JSON.stringify(broken));
  const out = resolve("build-failure-triage:decision", ["--policy", file]);
  assert.equal(out.base_url, "");
  assert.equal(out.credential_env, "");
});

test("every typesafe/ model in the policy is reached only through the direct-typesafe route", () => {
  for (const [id, role] of Object.entries(policy.roles)) {
    if (role.model?.startsWith("typesafe/")) assert.equal(role.route, "direct-typesafe", `${id} pins a TypeSafe model on route ${role.route}`);
    if (role.route === "direct-typesafe") assert.ok(role.model?.startsWith("typesafe/"), `${id} uses direct-typesafe with ${role.model}`);
  }
  assert.ok(policy.direct_providers.typesafe, "direct_providers.typesafe is declared");
});
