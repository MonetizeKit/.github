#!/usr/bin/env node
// Write side of the fleet preview manifest (Vercel Edge Config). Modes:
//   label       branch (or the open PR of a commit) -> preview label
//   register    verified Vercel deployments -> <label>.<base domain> alias + manifest entry
//   unregister  remove a branch's entries and aliases for this repository's surfaces
//   sweep       remove entries past expiresAt (daily, from this repository)
//   check       wait until every open fleet PR on the branch registered its head
// Runbook: docs/engineering/preview-surface-resolution.md in the monorepo.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  PREVIEW_MANIFEST,
  SURFACES,
  isLiveManifestEntry,
  manifestKey,
  previewOrigin,
} from "../../packages/surface-origins/index.mjs";
import { previewLabel } from "../../packages/surface-origins/label.mjs";

const VERCEL_API = "https://api.vercel.com";
const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const KEY_PREFIX = `${PREVIEW_MANIFEST.keyPrefix}__`;

function sameRepository(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function surfacesOf(repository, surfaces = SURFACES) {
  return Object.entries(surfaces)
    .filter(([, definition]) => sameRepository(definition.repository, repository))
    .map(([surface]) => surface);
}

function hostOf(origin) {
  return new URL(origin).hostname;
}

async function requestJson(fetchImpl, url, { method = "GET", token, body, allow404 = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${new URL(url).pathname} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

export function createClients({ vercelToken, githubToken, fetch: fetchImpl = globalThis.fetch }) {
  const team = `teamId=${PREVIEW_MANIFEST.vercelTeamId}`;
  const store = `${VERCEL_API}/v1/edge-config/${PREVIEW_MANIFEST.edgeConfigId}`;
  const vercel = (path, options = {}) =>
    requestJson(fetchImpl, `${VERCEL_API}${path}${path.includes("?") ? "&" : "?"}${team}`, {
      ...options,
      token: vercelToken,
    });
  const github = (path, options = {}) =>
    requestJson(fetchImpl, `${GITHUB_API}${path}`, { ...options, token: githubToken });

  return {
    getDeployment: (id) => vercel(`/v13/deployments/${encodeURIComponent(id)}`),
    listDeploymentAliases: async (id) =>
      (await vercel(`/v2/deployments/${encodeURIComponent(id)}/aliases`)).aliases ?? [],
    assignDeploymentAlias: (id, alias) =>
      vercel(`/v2/deployments/${encodeURIComponent(id)}/aliases`, { method: "POST", body: { alias } }),
    // DELETE takes the alias ID only; a hostname there is always a 404.
    removeAlias: async (alias) => {
      const found = await vercel(`/v4/aliases/${encodeURIComponent(alias)}`, { allow404: true });
      if (!found?.uid) return null;
      return vercel(`/v2/aliases/${encodeURIComponent(found.uid)}`, { method: "DELETE", allow404: true });
    },
    listItems: async () => {
      const items = await requestJson(fetchImpl, `${store}/items?${team}`, { token: vercelToken });
      return Array.isArray(items) ? items : [];
    },
    getItem: async (key) => {
      const item = await requestJson(fetchImpl, `${store}/item/${encodeURIComponent(key)}?${team}`, {
        token: vercelToken,
        allow404: true,
      });
      return item?.value ?? null;
    },
    patchItems: (items) =>
      requestJson(fetchImpl, `${store}/items?${team}`, { method: "PATCH", token: vercelToken, body: { items } }),
    branchHeadSha: async (repository, branch) => {
      const result = await github(`/repos/${repository}/branches/${encodeURIComponent(branch)}`, { allow404: true });
      return result?.commit?.sha ?? null;
    },
    pullRequestsForCommit: async (repository, sha) =>
      (await github(`/repos/${repository}/commits/${sha}/pulls?per_page=100`)) ?? [],
    openPullRequestsForBranch: async (repository, branch) => {
      const owner = repository.split("/")[0];
      const head = encodeURIComponent(`${owner}:${branch}`);
      return (await github(`/repos/${repository}/pulls?state=open&head=${head}&per_page=100`)) ?? [];
    },
  };
}

export async function resolveLabel(clients, { repository, sha, branch }) {
  let headRef = branch?.trim() || null;
  let pullRequest = null;
  if (!headRef && sha) {
    const open = (await clients.pullRequestsForCommit(repository, sha)).find(
      (candidate) => candidate.state === "open" && sameRepository(candidate.head?.repo?.full_name, repository),
    );
    if (open) {
      headRef = open.head.ref;
      pullRequest = open.number;
    }
  }
  return { branch: headRef, label: previewLabel(headRef), pullRequest };
}

export async function register(clients, { repository, deployments, expectedSha, pullRequest = null, now = Date.now(), surfaces = SURFACES }) {
  const requested = Object.entries(deployments ?? {}).filter(([, id]) => typeof id === "string" && id.trim());
  if (requested.length === 0) throw new Error("register needs at least one surface deployment");

  const verified = [];
  for (const [surface, deploymentId] of requested) {
    const definition = surfaces[surface];
    if (!definition) throw new Error(`Unknown surface ${surface}`);
    if (!sameRepository(definition.repository, repository)) {
      throw new Error(`Surface ${surface} belongs to ${definition.repository}, not ${repository}`);
    }
    const deployment = await clients.getDeployment(deploymentId.trim());
    const meta = deployment.meta ?? {};
    if (deployment.projectId !== definition.vercelProjectId) {
      throw new Error(`Deployment ${deploymentId} is in project ${deployment.projectId}, not ${surface}'s ${definition.vercelProjectId}`);
    }
    if (deployment.readyState !== "READY") {
      throw new Error(`Deployment ${deploymentId} is ${deployment.readyState}, not READY`);
    }
    if (!sameRepository(`${meta.githubOrg}/${meta.githubRepo}`, repository)) {
      throw new Error(`Deployment ${deploymentId} was built from ${meta.githubOrg}/${meta.githubRepo}, not ${repository}`);
    }
    if (expectedSha && meta.githubCommitSha !== expectedSha) {
      throw new Error(`Deployment ${deploymentId} is commit ${meta.githubCommitSha}, not ${expectedSha}`);
    }
    verified.push({ surface, deploymentId: deployment.id ?? deploymentId.trim(), branch: meta.githubCommitRef, sha: meta.githubCommitSha });
  }

  const branches = new Set(verified.map((item) => item.branch));
  const shas = new Set(verified.map((item) => item.sha));
  if (branches.size !== 1 || shas.size !== 1) {
    throw new Error("Every registered deployment must come from the same branch and commit");
  }
  const [branch] = branches;
  const [sha] = shas;
  const label = previewLabel(branch);
  if (!label) return { status: "excluded", branch, label: null, origins: {} };

  const head = await clients.branchHeadSha(repository, branch);
  if (head !== sha) return { status: "stale", branch, label, head, sha, origins: {} };

  const updatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PREVIEW_MANIFEST.maxLifetimeMs).toISOString();
  const origins = {};
  const items = [];
  for (const { surface, deploymentId } of verified) {
    const origin = previewOrigin(label, surface, surfaces);
    const host = hostOf(origin);
    const aliases = await clients.listDeploymentAliases(deploymentId);
    if (!aliases.some((alias) => (typeof alias === "string" ? alias : alias?.alias) === host)) {
      await clients.assignDeploymentAlias(deploymentId, host);
    }
    origins[surface] = origin;
    items.push({
      operation: "upsert",
      key: manifestKey(label, surface),
      value: {
        repository,
        surface,
        vercelProjectId: surfaces[surface].vercelProjectId,
        deploymentId,
        origin,
        branch,
        sha,
        pullRequest: pullRequest ?? null,
        updatedAt,
        expiresAt,
      },
    });
  }
  await clients.patchItems(items);
  return { status: "registered", branch, label, sha, expiresAt, origins };
}

async function removeEntries(clients, entries) {
  if (entries.length === 0) return;
  for (const { value } of entries) {
    if (typeof value?.origin === "string") {
      try {
        await clients.removeAlias(hostOf(value.origin));
      } catch (error) {
        console.warn(`::warning::alias removal for ${value.origin} failed: ${error.message}`);
      }
    }
  }
  await clients.patchItems(entries.map(({ key }) => ({ operation: "delete", key })));
}

export async function unregister(clients, { repository, branch, surfaces = SURFACES }) {
  const label = previewLabel(branch);
  if (!label) return { status: "excluded", branch, label: null, removed: [] };
  const entries = [];
  for (const surface of surfacesOf(repository, surfaces)) {
    const key = manifestKey(label, surface);
    const value = await clients.getItem(key);
    if (value !== null && value !== undefined) entries.push({ key, value });
  }
  await removeEntries(clients, entries);
  return { status: "unregistered", branch, label, removed: entries.map(({ key }) => key) };
}

// Every open same-repository PR in the fleet on this branch must have a live
// entry for its current head, so a gate cannot pass against development-stage
// siblings while the real sibling change is still building.
export async function checkSiblings(clients, { branch, now = Date.now(), surfaces = SURFACES }) {
  const label = previewLabel(branch);
  if (!label) return { status: "excluded", branch, label: null, missing: [] };
  const repositories = [...new Set(Object.values(surfaces).map((definition) => definition.repository))];
  const missing = [];
  for (const repository of repositories) {
    const pulls = await clients.openPullRequestsForBranch(repository, branch);
    for (const pull of pulls.filter((candidate) => sameRepository(candidate.head?.repo?.full_name, repository))) {
      const registered = [];
      for (const surface of surfacesOf(repository, surfaces)) {
        const value = await clients.getItem(manifestKey(label, surface));
        if (isLiveManifestEntry(value, { label, surface, now, surfaces }) && sameRepository(value.repository, repository)) {
          registered.push(value);
        }
      }
      if (!registered.some((entry) => entry.sha === pull.head.sha)) {
        missing.push({ repository, pullRequest: pull.number, sha: pull.head.sha });
      }
    }
  }
  return { status: missing.length === 0 ? "complete" : "incomplete", branch, label, missing };
}

export async function sweep(clients, { now = Date.now() } = {}) {
  const expired = (await clients.listItems()).filter(({ key, value }) => {
    if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return false;
    const expiresAt = typeof value?.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
    return !Number.isFinite(expiresAt) || expiresAt <= now;
  });
  await removeEntries(clients, expired);
  return { status: "swept", removed: expired.map(({ key }) => key) };
}

function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function main(env = process.env) {
  const mode = env.MANIFEST_MODE?.trim();
  const repository = env.MANIFEST_REPOSITORY?.trim() || env.GITHUB_REPOSITORY;
  const clients = createClients({ vercelToken: env.VERCEL_TOKEN?.trim(), githubToken: env.GITHUB_TOKEN?.trim() });

  switch (mode) {
    case "label": {
      const result = await resolveLabel(clients, { repository, sha: env.MANIFEST_SHA?.trim(), branch: env.MANIFEST_BRANCH });
      writeOutputs({ label: result.label ?? "", branch: result.branch ?? "", pull_request: String(result.pullRequest ?? "") });
      return result;
    }
    case "register": {
      required(env, "VERCEL_TOKEN");
      const result = await register(clients, {
        repository,
        deployments: JSON.parse(required(env, "MANIFEST_DEPLOYMENTS")),
        expectedSha: env.MANIFEST_SHA?.trim() || undefined,
        pullRequest: env.MANIFEST_PULL_REQUEST?.trim() ? Number(env.MANIFEST_PULL_REQUEST) : null,
      });
      if (result.status === "stale") {
        console.log(`::notice::${result.sha} is no longer the head of ${result.branch} (${result.head}); not registering.`);
      }
      writeOutputs({ status: result.status, label: result.label ?? "", branch: result.branch ?? "", origins: result.origins });
      return result;
    }
    case "unregister": {
      required(env, "VERCEL_TOKEN");
      const result = await unregister(clients, { repository, branch: required(env, "MANIFEST_BRANCH") });
      writeOutputs({ status: result.status, label: result.label ?? "", removed: result.removed });
      return result;
    }
    case "sweep": {
      required(env, "VERCEL_TOKEN");
      const result = await sweep(clients);
      writeOutputs({ status: result.status, removed: result.removed });
      return result;
    }
    case "check": {
      required(env, "VERCEL_TOKEN");
      const { branch } = await resolveLabel(clients, { repository, sha: env.MANIFEST_SHA?.trim(), branch: env.MANIFEST_BRANCH });
      if (!branch) throw new Error("check needs MANIFEST_BRANCH or a MANIFEST_SHA with an open pull request");
      const deadline = Date.now() + Number(env.MANIFEST_WAIT_SECONDS || 0) * 1000;
      const pollMs = Number(env.MANIFEST_POLL_SECONDS || 30) * 1000;
      let result = await checkSiblings(clients, { branch });
      while (result.status === "incomplete" && Date.now() + pollMs <= deadline) {
        console.log(`Waiting for sibling previews: ${JSON.stringify(result.missing)}`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        result = await checkSiblings(clients, { branch });
      }
      writeOutputs({ status: result.status, label: result.label ?? "", branch, missing: result.missing });
      if (result.status === "incomplete") {
        throw new Error(`Sibling previews not registered for their head commit: ${JSON.stringify(result.missing)}`);
      }
      return result;
    }
    default:
      throw new Error(`MANIFEST_MODE must be label, register, unregister, sweep or check; received ${mode || "<empty>"}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
