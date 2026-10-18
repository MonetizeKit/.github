// Moves the fleet's `v1` tag forward to a commit on main once CI is green.
// Forward-only: rollback stays a deliberate manual re-point (see README).
import { execFileSync } from "node:child_process";

export function decideMove({ compareStatus }) {
  switch (compareStatus) {
    case "identical":
      return { action: "skip", reason: "tag already at this commit" };
    case "ahead":
      return { action: "move", reason: "commit is ahead of the tag" };
    case "behind":
      return { action: "skip", reason: "commit is behind the tag; not moving backwards" };
    case "diverged":
      return { action: "skip", reason: "commit has diverged from the tag; manual decision required" };
    default:
      throw new Error(`Unexpected compare status: ${compareStatus}`);
  }
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.TARGET_SHA;
  const tag = process.env.TAG_NAME || "v1";
  const dryRun = process.env.DRY_RUN === "true";
  if (!repo || !sha) throw new Error("GITHUB_REPOSITORY and TARGET_SHA are required");

  const compareStatus = gh(["api", `repos/${repo}/compare/${tag}...${sha}`, "--jq", ".status"]);
  const decision = decideMove({ compareStatus });
  console.log(`${tag} -> ${sha}: ${decision.action} (${decision.reason})`);
  if (decision.action !== "move") return;
  if (dryRun) {
    console.log("dry run: tag not moved");
    return;
  }
  gh(["api", "-X", "PATCH", `repos/${repo}/git/refs/tags/${tag}`, "-f", `sha=${sha}`, "-F", "force=true"]);
  console.log(`moved ${tag} to ${sha}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
