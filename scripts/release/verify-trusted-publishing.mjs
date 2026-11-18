// Preflight for npm trusted publishing. npm swallows a failed OIDC token
// exchange (it logs it only at verbose level) and the publish then dies with a
// bare ENEEDAUTH, so this performs the same exchange npm does and reports the
// registry's answer next to the OIDC claims npm matches against. Prints claims,
// never tokens. Dependency-free: consumers fetch it from the `v1` tag.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const REGISTRY = "https://registry.npmjs.org";

export function escapedPackageName(name) {
  return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

export function pendingChangesets(files) {
  return files.filter((file) => file.endsWith(".md") && file !== "README.md");
}

export function decodeClaims(jwt) {
  const payload = jwt.split(".")[1];
  if (!payload) throw new Error("OIDC token is not a JWT");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const pick = ["repository", "repository_owner", "workflow_ref", "job_workflow_ref", "environment", "ref", "event_name"];
  return Object.fromEntries(pick.map((key) => [key, claims[key] ?? null]));
}

export function expectedPublisher(claims) {
  const [owner, repo] = String(claims.repository ?? "").split("/");
  const workflowFile = String(claims.workflow_ref ?? "").split("@")[0].split("/").pop() || null;
  return { owner: owner || null, repository: repo || null, workflowFile, environment: claims.environment ?? null };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (manifest.private) {
    console.log(`${manifest.name ?? "package"} is private; nothing to publish`);
    return;
  }
  const pending = existsSync(".changeset") ? pendingChangesets(readdirSync(".changeset")) : [];
  if (pending.length > 0) {
    console.log(`${pending.length} pending changeset(s): this run opens the release PR and does not publish`);
    return;
  }
  const name = manifest.name;
  const packument = await fetch(`${REGISTRY}/${escapedPackageName(name)}`);
  if (packument.ok && (await packument.json()).versions?.[manifest.version]) {
    console.log(`${name}@${manifest.version} is already on npm; nothing to publish`);
    return;
  }

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    console.log("::error::No GitHub OIDC token available: grant `id-token: write` in both the caller and the reusable workflow");
    process.exit(1);
  }
  const url = new URL(requestUrl);
  url.searchParams.append("audience", `npm:${new URL(REGISTRY).hostname}`);
  const idResponse = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${requestToken}` } });
  const idToken = idResponse.ok ? (await idResponse.json()).value : null;
  if (!idToken) {
    console.log(`::error::GitHub refused the OIDC token request (HTTP ${idResponse.status})`);
    process.exit(1);
  }
  const claims = decodeClaims(idToken);
  console.log(`OIDC claims npm matches against: ${JSON.stringify(claims)}`);

  const exchange = await fetch(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escapedPackageName(name)}`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${idToken}` },
  });
  const body = await readJson(exchange);
  if (exchange.ok && body.token) {
    console.log(`npm accepted the trusted publisher for ${name}@${manifest.version}`);
    return;
  }
  const expected = expectedPublisher(claims);
  console.log(
    `::error::npm rejected the OIDC exchange for ${name} (HTTP ${exchange.status}: ${body.message ?? body.error ?? "no message"}). ` +
      `The trusted publisher on npmjs.com must read exactly (case-sensitive): organization ${expected.owner}, repository ${expected.repository}, ` +
      `workflow ${expected.workflowFile}, environment ${expected.environment ?? "(blank)"}; package.json repository.url must be https://github.com/${claims.repository}`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.log(`::error::Trusted publishing preflight failed: ${error.message}`);
    process.exit(1);
  });
}
