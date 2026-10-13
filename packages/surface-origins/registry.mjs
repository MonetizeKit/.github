// The fleet's page-serving surfaces. A surface appears here once its preview
// base domain has a wildcard certificate on the Vercel team and, when it shares
// the Clerk session, a wildcard entry in Clerk's allowed_subdomains.
export const SURFACES = Object.freeze({
  web: Object.freeze({
    repository: "MonetizeKit/app-monetizekit-monorepo",
    vercelProjectId: "prj_vX6VlHMfXiYfvWyL7Cw9LbynHka0",
    previewBaseDomain: "app.monetizekit.dev",
  }),
  docs: Object.freeze({
    repository: "MonetizeKit/app-monetizekit-monorepo",
    vercelProjectId: "prj_9FFzvedTje2SCnqHYld5c6wCQp2s",
    previewBaseDomain: "learning.monetizekit.dev",
  }),
});

export const PREVIEW_MANIFEST = Object.freeze({
  vercelTeamId: "team_LD2xNXAMxzwLqSTsdi5ZNOOU",
  edgeConfigId: "ecfg_dag0ibmzs4fgctk1t9n7lcgwrptg",
  keyPrefix: "preview",
  maxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
});

// Host labels on a surface base domain that are never preview labels.
export const RESERVED_LABELS = Object.freeze(["www"]);
