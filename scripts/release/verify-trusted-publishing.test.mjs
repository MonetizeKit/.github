import assert from "node:assert/strict";
import test from "node:test";
import { decodeClaims, escapedPackageName, expectedPublisher, pendingChangesets } from "./verify-trusted-publishing.mjs";

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

test("escapes scoped package names the way npm does", () => {
  assert.equal(escapedPackageName("@monetizekit/types"), "@monetizekit%2ftypes");
  assert.equal(escapedPackageName("left-pad"), "left-pad");
});

test("counts only changeset files as pending", () => {
  assert.deepEqual(pendingChangesets(["README.md", "config.json", "brave-owls.md"]), ["brave-owls.md"]);
  assert.deepEqual(pendingChangesets(["README.md", "config.json"]), []);
});

test("decodes the claims npm matches and drops the rest", () => {
  const claims = decodeClaims(
    jwt({
      repository: "MonetizeKit/types",
      repository_owner: "MonetizeKit",
      workflow_ref: "MonetizeKit/types/.github/workflows/release.yml@refs/heads/main",
      job_workflow_ref: "MonetizeKit/.github/.github/workflows/reusable-sdk-release.yml@refs/tags/v1",
      environment: "Production",
      ref: "refs/heads/main",
      event_name: "push",
      sub: "repo:MonetizeKit/types:environment:Production",
    }),
  );
  assert.equal(claims.environment, "Production");
  assert.equal(claims.sub, undefined);
});

test("derives the expected publisher from the caller workflow, not the reusable one", () => {
  const expected = expectedPublisher({
    repository: "MonetizeKit/types",
    workflow_ref: "MonetizeKit/types/.github/workflows/release.yml@refs/heads/main",
    environment: "Production",
  });
  assert.deepEqual(expected, { owner: "MonetizeKit", repository: "types", workflowFile: "release.yml", environment: "Production" });
});

test("reports a blank environment as null", () => {
  assert.equal(expectedPublisher({ repository: "MonetizeKit/design-system", workflow_ref: "x/y/.github/workflows/release.yml@refs/heads/main" }).environment, null);
});

test("rejects a token that is not a JWT", () => {
  assert.throws(() => decodeClaims("opaque"), /not a JWT/);
});
