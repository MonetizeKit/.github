#!/usr/bin/env node
// Fetch automation secrets from Phase.dev at run time and expose them to the
// following steps of a GitHub Actions job.
//
//   node export-secrets.mjs GH_PAT CURSOR_API_KEY ...
//
// Environment:
//   PHASE_TOKEN        Phase service-account token scoped to the environment
//                      (the org secret PHASE_SDLC_TOKEN). Absent -> the script
//                      prints a notice and exits 0 so callers can fall back to
//                      secrets passed the old way. Present but rejected -> exit 1.
//   PHASE_ENV          Phase environment to read (default "sdlc").
//   PHASE_APP_ID       Phase application id (default: Entitlements.C9D.Engineering).
//   PHASE_CLI_VERSION  Pinned CLI release (default 2.0.0); downloaded to
//                      PHASE_CLI_HOME (default /tmp/phase-cli) unless `phase`
//                      is already on PATH.
//   GITHUB_ENV / GITHUB_OUTPUT  Written when present (Actions).
//
// Every fetched value is registered with `::add-mask::` BEFORE it is written
// to GITHUB_ENV, so it is redacted from logs of later steps. Only the keys
// requested on the command line are exported: a job sees what it asked for.
//
// Why runtime fetch rather than the Phase -> GitHub Actions sync: GitHub caps a
// repository or environment at 100 secrets and the sync drops the rest
// silently; fleet repositories had no synced secrets at all; and one
// org-level bootstrap token scoped to a dedicated `sdlc` environment is a
// smaller blast radius than every automation token in every repository.

import { spawnSync, execSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_APP_ID = "026988b7-1ffa-499c-913b-3d0f031c4e58";
export const DEFAULT_ENV = "sdlc";
export const DEFAULT_CLI_VERSION = "2.0.0";

/** Parse `phase secrets export --format json` output into { KEY: value }. */
export function parseExport(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return {};
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  if (starts.length === 0) throw new Error("phase secrets export returned no JSON object");
  const start = Math.min(...starts);
  const parsed = JSON.parse(text.slice(start));
  if (Array.isArray(parsed)) {
    // Some formats list [{ key, value }]; normalise.
    return Object.fromEntries(parsed.filter((item) => item && item.key).map((item) => [item.key, item.value ?? ""]));
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value === "object" && value !== null && "value" in value ? value.value : value]));
}

/**
 * Split requested keys into fetched (non-empty in the export) and missing, and
 * render the GITHUB_ENV heredoc lines. Pure.
 */
export function planExport(exported, keys, { delimiter = "PHASE_EOF" } = {}) {
  const fetched = [];
  const missing = [];
  const envLines = [];
  for (const key of keys) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`refusing to export "${key}": not an environment variable name`);
    const value = exported[key];
    if (value === undefined || value === null || String(value) === "") {
      missing.push(key);
      continue;
    }
    const text = String(value);
    if (text.includes(delimiter)) throw new Error(`value of ${key} contains the heredoc delimiter`);
    fetched.push(key);
    envLines.push(`${key}<<${delimiter}`, text, delimiter);
  }
  return { fetched, missing, envLines };
}

function assetSuffix() {
  const { platform, arch } = process;
  if (platform === "linux") return arch === "arm64" ? "linux_arm64" : "linux_amd64";
  if (platform === "darwin") return arch === "arm64" ? "darwin_arm64" : "darwin_amd64";
  throw new Error(`unsupported platform ${platform}/${arch}`);
}

async function ensureCli({ version, home }) {
  try {
    execSync("phase --version", { stdio: "ignore" });
    return "phase";
  } catch {
    // not on PATH
  }
  const binary = path.join(home, "phase");
  if (existsSync(binary)) return binary;
  const url = `https://github.com/phasehq/cli/releases/download/v${version}/phase_cli_${version}_${assetSuffix()}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Phase CLI download failed (${response.status}): ${url}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(binary, Buffer.from(await response.arrayBuffer()));
  chmodSync(binary, 0o755);
  return binary;
}

async function main() {
  const keys = process.argv.slice(2).filter(Boolean);
  if (keys.length === 0) {
    console.error("usage: export-secrets.mjs KEY [KEY...]");
    process.exit(2);
  }
  const token = process.env.PHASE_TOKEN;
  if (!token) {
    console.log(`::notice::PHASE_TOKEN is not set; not fetching ${keys.join(", ")} from Phase (falling back to secrets passed by the caller, if any)`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fetched=\nmissing=${keys.join(",")}\nsource=none\n`);
    return;
  }
  const env = process.env.PHASE_ENV || DEFAULT_ENV;
  const appId = process.env.PHASE_APP_ID || DEFAULT_APP_ID;
  const cli = await ensureCli({ version: process.env.PHASE_CLI_VERSION || DEFAULT_CLI_VERSION, home: process.env.PHASE_CLI_HOME || "/tmp/phase-cli" });
  // The CLI refuses the whole export when any named key is absent, so export
  // the environment and select client-side; only the requested keys leave this
  // process (planExport), the rest are dropped.
  const result = spawnSync(cli, ["secrets", "export", "--env", env, "--app-id", appId, "--format", "json"], {
    env: { ...process.env, PHASE_SERVICE_TOKEN: token },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`phase secrets export failed (exit ${result.status}) for env "${env}": ${(result.stderr || result.stdout || "").trim().slice(0, 400)}`);
  }
  const exported = parseExport(result.stdout);
  const delimiter = `PHASE_EOF_${randomBytes(8).toString("hex")}`;
  const plan = planExport(exported, keys, { delimiter });
  // Mask first, then expose: the value must never reach a log unredacted.
  for (const key of plan.fetched) {
    for (const line of String(exported[key]).split(/\r?\n/)) if (line.trim()) console.log(`::add-mask::${line}`);
  }
  if (process.env.GITHUB_ENV && plan.envLines.length) appendFileSync(process.env.GITHUB_ENV, `${plan.envLines.join("\n")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fetched=${plan.fetched.join(",")}\nmissing=${plan.missing.join(",")}\nsource=phase:${env}\n`);
  console.log(`phase(${env}): fetched ${plan.fetched.length ? plan.fetched.join(", ") : "nothing"}${plan.missing.length ? `; not present: ${plan.missing.join(", ")}` : ""}`);
  if (plan.missing.length) console.log(`::warning::Phase environment "${env}" has no value for ${plan.missing.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
