import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEdgeConfigManifestReader,
  createSurfaceOriginResolver,
  manifestKey,
  parseEdgeConfigConnectionString,
  parsePreviewHost,
  previewOrigin,
} from "./index.mjs";
import { previewLabel } from "./label.mjs";

const NOW = Date.parse("2026-09-28T00:00:00Z");
const LATER = new Date(NOW + 60_000).toISOString();
const EARLIER = new Date(NOW - 60_000).toISOString();
const FALLBACKS = {
  web: "https://app.monetizekit.dev",
  docs: "https://learning.monetizekit.dev/",
  marketing: "https://www.monetizekit.app",
};
const LABEL = "cursor-preview-surface-resolution-plan-430f";

function entry(surface, overrides = {}) {
  return {
    repository: "MonetizeKit/app-monetizekit-monorepo",
    surface,
    vercelProjectId: "prj_x",
    deploymentId: "dpl_x",
    origin: previewOrigin(LABEL, surface),
    branch: "cursor/preview-surface-resolution-plan-430f",
    sha: "a".repeat(40),
    pullRequest: 507,
    updatedAt: EARLIER,
    expiresAt: LATER,
    ...overrides,
  };
}

test("previewLabel follows the tunnel sanitization rule", () => {
  assert.equal(previewLabel("cursor/preview-surface-resolution-plan-430f"), LABEL);
  assert.equal(previewLabel("feat/auth_flow.v2"), "feat-auth-flow-v2");
  assert.equal(previewLabel("refs/heads/Fix/Bug-123"), "fix-bug-123");
  assert.equal(previewLabel("--odd--/"), "odd");
});

test("previewLabel excludes stable, dependabot, empty and reserved branches", () => {
  for (const branch of ["main", "delivery", "development", "dependabot/npm_and_yarn/next-16", "", "///", "www", undefined]) {
    assert.equal(previewLabel(branch), null, String(branch));
  }
});

test("previewLabel keeps long labels unique within 63 characters", () => {
  const base = `cursor/${"x".repeat(70)}`;
  const first = previewLabel(`${base}-one`);
  const second = previewLabel(`${base}-two`);
  assert.ok(first.length <= 63 && second.length <= 63);
  assert.notEqual(first, second);
  assert.match(first, /^cursor-x+-[0-9a-f]{6}$/);
});

test("parsePreviewHost recognizes one label on a surface base domain only", () => {
  assert.deepEqual(parsePreviewHost(`${LABEL}.app.monetizekit.dev`), { surface: "web", label: LABEL });
  assert.deepEqual(parsePreviewHost(`${LABEL}.learning.monetizekit.dev:443`), { surface: "docs", label: LABEL });
  assert.deepEqual(parsePreviewHost(`PR-506.App.Monetizekit.Dev, proxy.example`), { surface: "web", label: "pr-506" });
  for (const host of [
    "app.monetizekit.dev",
    "learning.monetizekit.dev",
    "www.app.monetizekit.dev",
    "a.b.app.monetizekit.dev",
    "evil-app.monetizekit.dev",
    "x.app.monetizekit.dev.evil.com",
    "appmonetizekit-abc-coordinated.vercel.app",
    "localhost:3000",
    "",
    null,
  ]) {
    assert.equal(parsePreviewHost(host), null, String(host));
  }
});

test("a stable host resolves to the configured origins without reading the manifest", async () => {
  let reads = 0;
  const resolve = createSurfaceOriginResolver({
    fallbacks: FALLBACKS,
    readManifest: async () => {
      reads += 1;
      return {};
    },
    now: () => NOW,
  });
  const resolved = await resolve("app.monetizekit.dev");
  assert.equal(resolved.preview, null);
  assert.deepEqual(resolved.origins, {
    web: "https://app.monetizekit.dev",
    docs: "https://learning.monetizekit.dev",
    marketing: "https://www.monetizekit.app",
  });
  assert.equal(reads, 0);
});

test("a preview host resolves itself and every sibling built for the change set", async () => {
  const keys = [];
  const resolve = createSurfaceOriginResolver({
    fallbacks: FALLBACKS,
    readManifest: async (requested) => {
      keys.push(...requested);
      return { [manifestKey(LABEL, "docs")]: entry("docs") };
    },
    now: () => NOW,
  });
  const resolved = await resolve(`${LABEL}.app.monetizekit.dev`);
  assert.deepEqual(keys, [manifestKey(LABEL, "docs")]);
  assert.deepEqual(resolved.preview, { surface: "web", label: LABEL, builtSiblings: ["docs"] });
  assert.equal(resolved.origins.web, `https://${LABEL}.app.monetizekit.dev`);
  assert.equal(resolved.origins.docs, `https://${LABEL}.learning.monetizekit.dev`);
  assert.equal(resolved.origins.marketing, "https://www.monetizekit.app");
});

test("a sibling that was not built, expired, or points elsewhere resolves to its configured origin", async () => {
  for (const values of [
    {},
    { [manifestKey(LABEL, "docs")]: entry("docs", { expiresAt: EARLIER }) },
    { [manifestKey(LABEL, "docs")]: entry("docs", { origin: "https://attacker.example" }) },
    { [manifestKey(LABEL, "docs")]: entry("web") },
    { [manifestKey(LABEL, "docs")]: "not-an-object" },
  ]) {
    const resolve = createSurfaceOriginResolver({
      fallbacks: FALLBACKS,
      readManifest: async () => values,
      now: () => NOW,
    });
    const resolved = await resolve(`${LABEL}.app.monetizekit.dev`);
    assert.equal(resolved.origins.docs, "https://learning.monetizekit.dev");
    assert.deepEqual(resolved.preview.builtSiblings, []);
  }
});

test("a manifest failure degrades to configured origins and retries soon", async () => {
  let clock = NOW;
  let calls = 0;
  const errors = [];
  const resolve = createSurfaceOriginResolver({
    fallbacks: FALLBACKS,
    readManifest: async () => {
      calls += 1;
      if (calls === 1) throw new Error("edge config down");
      return { [manifestKey(LABEL, "docs")]: entry("docs") };
    },
    now: () => clock,
    onError: (error) => errors.push(error.message),
  });
  const first = await resolve(`${LABEL}.app.monetizekit.dev`);
  assert.equal(first.origins.docs, "https://learning.monetizekit.dev");
  assert.equal(first.origins.web, `https://${LABEL}.app.monetizekit.dev`);
  assert.deepEqual(errors, ["edge config down"]);
  clock += 2_001;
  const second = await resolve(`${LABEL}.app.monetizekit.dev`);
  assert.equal(second.origins.docs, `https://${LABEL}.learning.monetizekit.dev`);
});

test("manifest reads are cached per label for the TTL", async () => {
  let clock = NOW;
  let calls = 0;
  const resolve = createSurfaceOriginResolver({
    fallbacks: FALLBACKS,
    readManifest: async () => {
      calls += 1;
      return {};
    },
    cacheTtlMs: 10_000,
    now: () => clock,
  });
  await resolve(`${LABEL}.learning.monetizekit.dev`);
  await resolve(`${LABEL}.learning.monetizekit.dev`);
  assert.equal(calls, 1);
  clock += 10_001;
  await resolve(`${LABEL}.learning.monetizekit.dev`);
  assert.equal(calls, 2);
});

test("parseEdgeConfigConnectionString accepts only Edge Config URLs with a token", () => {
  assert.deepEqual(
    parseEdgeConfigConnectionString('"https://edge-config.vercel.com/ecfg_abc123?token=t0k"'),
    { id: "ecfg_abc123", token: "t0k" },
  );
  for (const value of [
    "",
    undefined,
    "https://edge-config.vercel.com/ecfg_abc123",
    "https://evil.example/ecfg_abc123?token=t",
    "http://edge-config.vercel.com/ecfg_abc123?token=t",
    "https://edge-config.vercel.com/other?token=t",
  ]) {
    assert.equal(parseEdgeConfigConnectionString(value), null, String(value));
  }
});

test("the Edge Config reader requests only the asked keys and rejects HTTP errors", async () => {
  const urls = [];
  const reader = createEdgeConfigManifestReader("https://edge-config.vercel.com/ecfg_abc123?token=t0k", {
    fetch: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ a: 1 }) };
    },
  });
  assert.deepEqual(await reader(["preview__x__docs", "preview__x__web"]), { a: 1 });
  assert.equal(
    urls[0],
    "https://edge-config.vercel.com/ecfg_abc123/items?token=t0k&key=preview__x__docs&key=preview__x__web",
  );

  const failing = createEdgeConfigManifestReader("https://edge-config.vercel.com/ecfg_abc123?token=t0k", {
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(failing(["k"]), /HTTP 503/);
  assert.equal(createEdgeConfigManifestReader(undefined), null);
});
