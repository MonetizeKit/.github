import { createHash } from "node:crypto";

import { isPreviewLabel } from "./index.mjs";

export const STABLE_BRANCHES = Object.freeze(["main", "delivery", "development"]);
export const EXCLUDED_BRANCH_PREFIXES = Object.freeze(["dependabot/"]);

const MAX_LABEL_LENGTH = 63;
const TRUNCATED_PREFIX_LENGTH = 56;

// The preview label of a git branch: the branch as one DNS label, with the same
// rule scripts/tunnel.mjs applies in the monorepo, plus a hash suffix when the
// label would exceed 63 characters. Null for branches that never form a
// preview set.
export function previewLabel(branch) {
  if (typeof branch !== "string") return null;
  const name = branch.trim().replace(/^refs\/heads\//, "");
  if (!name || STABLE_BRANCHES.includes(name)) return null;
  if (EXCLUDED_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;

  let label = name
    .replace(/[/_.]/g, "-")
    .replace(/[^a-z0-9-]/gi, "")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  if (label.length > MAX_LABEL_LENGTH) {
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 6);
    label = `${label.slice(0, TRUNCATED_PREFIX_LENGTH).replace(/-+$/, "")}-${digest}`;
  }
  return isPreviewLabel(label) ? label : null;
}
