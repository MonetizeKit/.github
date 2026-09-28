import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSiblings, createClients, register, resolveLabel, sweep, unregister } from "./manifest.mjs";
import { manifestKey } from "../../packages/surface-origins/index.mjs";

const REPO = "MonetizeKit/app-monetizekit-monorepo";
const BRANCH = "cursor/preview-surface-resolution-plan-430f";
const LABEL = "cursor-preview-surface-resolution-plan-430f";
const SHA = "a".repeat(40);
const NOW = Date.parse("2026-09-28T00:00:00Z");
const PROJECTS = { web: "prj_vX6VlHMfXiYfvWyL7Cw9LbynHka0", docs: "prj_9FFzvedTje2SCnqHYld5c6wCQp2s" };

function deployment(surface, overrides = {}) {
  return {
    id: `dpl_${surface}`,
    projectId: PROJECTS[surface],
    readyState: "READY",
    meta: { githubOrg: "MonetizeKit", githubRepo: "app-monetizekit-monorepo", githubCommitRef: BRANCH, githubCommitSha: SHA },
    ...overrides,
  };
}

function fakeClients({ deployments = {}, aliases = {}, head = SHA, items = [], pulls = [], branchPulls = {} } = {}) {
  const calls = { assigned: [], patched: [], removedAliases: [] };
  const store = new Map(items.map(({ key, value }) => [key, value]));
  return {
    calls,
    store,
    getDeployment: async (id) => {
      const found = Object.values(deployments).find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no deployment ${id}`);
      return found;
    },
    listDeploymentAliases: async (id) => aliases[id] ?? [],
    assignDeploymentAlias: async (id, alias) => calls.assigned.push([id, alias]),
    removeAlias: async (alias) => calls.removedAliases.push(alias),
    listItems: async () => [...store].map(([key, value]) => ({ key, value })),
    getItem: async (key) => (store.has(key) ? store.get(key) : null),
    patchItems: async (patch) => {
      calls.patched.push(patch);
      for (const item of patch) {
        if (item.operation === "delete") store.delete(item.key);
        else store.set(item.key, item.value);
      }
    },
    branchHeadSha: async () => head,
    pullRequestsForCommit: async () => pulls,
    openPullRequestsForBranch: async (repository) => branchPulls[repository] ?? [],
  };
}

test("register aliases each built surface and records it with a 30-day expiry", async () => {
  const clients = fakeClients({
    deployments: { web: deployment("web"), docs: deployment("docs") },
    aliases: { dpl_web: [{ alias: `${LABEL}.app.monetizekit.dev` }] },
  });
  const result = await register(clients, {
    repository: REPO,
    deployments: { web: "dpl_web", docs: "dpl_docs" },
    expectedSha: SHA,
    pullRequest: 507,
    now: NOW,
  });
  assert.equal(result.status, "registered");
  assert.deepEqual(result.origins, {
    web: `https://${LABEL}.app.monetizekit.dev`,
    docs: `https://${LABEL}.learning.monetizekit.dev`,
  });
  assert.deepEqual(clients.calls.assigned, [["dpl_docs", `${LABEL}.learning.monetizekit.dev`]]);
  const docs = clients.store.get(manifestKey(LABEL, "docs"));
  assert.equal(docs.deploymentId, "dpl_docs");
  assert.equal(docs.pullRequest, 507);
  assert.equal(docs.expiresAt, "2026-10-28T00:00:00.000Z");
});

test("register refuses deployments that are not the surface's project, repository, commit or READY", async () => {
  const cases = [
    deployment("web", { projectId: "prj_other" }),
    deployment("web", { readyState: "BUILDING" }),
    deployment("web", { meta: { ...deployment("web").meta, githubRepo: "fork" } }),
    deployment("web", { meta: { ...deployment("web").meta, githubCommitSha: "b".repeat(40) } }),
  ];
  for (const candidate of cases) {
    const clients = fakeClients({ deployments: { web: candidate } });
    await assert.rejects(register(clients, { repository: REPO, deployments: { web: "dpl_web" }, expectedSha: SHA, now: NOW }));
    assert.equal(clients.store.size, 0);
  }
  await assert.rejects(
    register(fakeClients(), { repository: "MonetizeKit/app-monetizekit-web", deployments: { web: "dpl_web" }, now: NOW }),
    /belongs to/,
  );
});

test("register does nothing for a commit that is no longer the branch head", async () => {
  const clients = fakeClients({ deployments: { web: deployment("web") }, head: "c".repeat(40) });
  const result = await register(clients, { repository: REPO, deployments: { web: "dpl_web" }, expectedSha: SHA, now: NOW });
  assert.equal(result.status, "stale");
  assert.deepEqual(clients.calls.assigned, []);
  assert.equal(clients.store.size, 0);
});

test("register skips excluded branches", async () => {
  const meta = { ...deployment("web").meta, githubCommitRef: "development" };
  const clients = fakeClients({ deployments: { web: deployment("web", { meta }) } });
  const result = await register(clients, { repository: REPO, deployments: { web: "dpl_web" }, now: NOW });
  assert.equal(result.status, "excluded");
  assert.equal(clients.store.size, 0);
});

test("unregister removes only this repository's entries for the branch, with their aliases", async () => {
  const docsKey = manifestKey(LABEL, "docs");
  const otherKey = manifestKey("another-branch", "docs");
  const clients = fakeClients({
    items: [
      { key: docsKey, value: { origin: `https://${LABEL}.learning.monetizekit.dev` } },
      { key: otherKey, value: { origin: "https://another-branch.learning.monetizekit.dev" } },
    ],
  });
  const result = await unregister(clients, { repository: REPO, branch: BRANCH });
  assert.deepEqual(result.removed, [docsKey]);
  assert.deepEqual(clients.calls.removedAliases, [`${LABEL}.learning.monetizekit.dev`]);
  assert.ok(clients.store.has(otherKey));
});

test("sweep removes expired and malformed preview entries and nothing else", async () => {
  const live = manifestKey("live", "web");
  const expired = manifestKey("old", "web");
  const malformed = manifestKey("bad", "docs");
  const clients = fakeClients({
    items: [
      { key: live, value: { origin: "https://live.app.monetizekit.dev", expiresAt: new Date(NOW + 1).toISOString() } },
      { key: expired, value: { origin: "https://old.app.monetizekit.dev", expiresAt: new Date(NOW - 1).toISOString() } },
      { key: malformed, value: "x" },
      { key: "unrelated", value: { expiresAt: new Date(NOW - 1).toISOString() } },
    ],
  });
  const result = await sweep(clients, { now: NOW });
  assert.deepEqual(result.removed.sort(), [expired, malformed].sort());
  assert.deepEqual([...clients.store.keys()].sort(), [live, "unrelated"].sort());
  assert.deepEqual(clients.calls.removedAliases, ["old.app.monetizekit.dev"]);
});

test("resolveLabel uses an explicit branch, else the commit's open same-repository PR", async () => {
  assert.deepEqual(await resolveLabel(fakeClients(), { repository: REPO, branch: BRANCH }), {
    branch: BRANCH,
    label: LABEL,
    pullRequest: null,
  });
  const pulls = [
    { number: 1, state: "open", head: { ref: "fork-branch", repo: { full_name: "someone/fork" } } },
    { number: 507, state: "open", head: { ref: BRANCH, repo: { full_name: REPO } } },
  ];
  assert.deepEqual(await resolveLabel(fakeClients({ pulls }), { repository: REPO, sha: SHA }), {
    branch: BRANCH,
    label: LABEL,
    pullRequest: 507,
  });
  assert.deepEqual(await resolveLabel(fakeClients({ pulls: [] }), { repository: REPO, sha: SHA }), {
    branch: null,
    label: null,
    pullRequest: null,
  });
});

function liveEntry(surface, overrides = {}) {
  const base = surface === "web" ? "app.monetizekit.dev" : "learning.monetizekit.dev";
  return {
    key: manifestKey(LABEL, surface),
    value: {
      repository: REPO,
      surface,
      origin: `https://${LABEL}.${base}`,
      sha: SHA,
      expiresAt: "2026-10-28T00:00:00.000Z",
      ...overrides,
    },
  };
}

function openPull(sha, repository = REPO) {
  return { number: 508, head: { sha, repo: { full_name: repository } } };
}

test("checkSiblings is complete only when every open fleet PR on the branch registered its head", async () => {
  const complete = await checkSiblings(
    fakeClients({ items: [liveEntry("web"), liveEntry("docs")], branchPulls: { [REPO]: [openPull(SHA)] } }),
    { branch: BRANCH, now: NOW },
  );
  assert.equal(complete.status, "complete");

  const newerHead = "b".repeat(40);
  const stale = await checkSiblings(
    fakeClients({ items: [liveEntry("web"), liveEntry("docs")], branchPulls: { [REPO]: [openPull(newerHead)] } }),
    { branch: BRANCH, now: NOW },
  );
  assert.equal(stale.status, "incomplete");
  assert.deepEqual(stale.missing, [{ repository: REPO, pullRequest: 508, sha: newerHead }]);
});

test("checkSiblings ignores expired or forged entries and fork PRs", async () => {
  for (const entry of [
    liveEntry("web", { expiresAt: "2026-09-27T00:00:00.000Z" }),
    liveEntry("web", { origin: "https://attacker.example" }),
    liveEntry("web", { repository: "MonetizeKit/other" }),
  ]) {
    const result = await checkSiblings(fakeClients({ items: [entry], branchPulls: { [REPO]: [openPull(SHA)] } }), {
      branch: BRANCH,
      now: NOW,
    });
    assert.equal(result.status, "incomplete");
  }
  const fork = await checkSiblings(fakeClients({ branchPulls: { [REPO]: [openPull(SHA, "someone/fork")] } }), {
    branch: BRANCH,
    now: NOW,
  });
  assert.equal(fork.status, "complete");
  assert.equal((await checkSiblings(fakeClients(), { branch: "dependabot/npm/x", now: NOW })).status, "excluded");
});

test("the Edge Config client unwraps single-item responses to the stored value", async () => {
  const value = { surface: "web", origin: `https://${LABEL}.app.monetizekit.dev` };
  const clients = createClients({
    vercelToken: "t",
    githubToken: "g",
    fetch: async (url) =>
      String(url).includes("missing")
        ? new Response("{}", { status: 404 })
        : Response.json({ key: "k", value, createdAt: 1, updatedAt: 1, edgeConfigId: "ecfg" }),
  });
  assert.deepEqual(await clients.getItem("present"), value);
  assert.equal(await clients.getItem("missing"), null);
});

test("the Vercel client removes an alias by looking up its ID", async () => {
  const requests = [];
  const clients = createClients({
    vercelToken: "t",
    githubToken: "g",
    fetch: async (url, init) => {
      requests.push(`${init.method} ${new URL(url).pathname}`);
      return String(url).includes("/v4/aliases/") ? Response.json({ uid: "als_123" }) : Response.json({ status: "SUCCESS" });
    },
  });
  await clients.removeAlias(`${LABEL}.app.monetizekit.dev`);
  assert.deepEqual(requests, [`GET /v4/aliases/${LABEL}.app.monetizekit.dev`, "DELETE /v2/aliases/als_123"]);
});
