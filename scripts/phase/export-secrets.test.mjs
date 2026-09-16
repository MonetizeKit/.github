// node --test scripts/phase/
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ENV, parseExport, planExport } from "./export-secrets.mjs";

test("parseExport reads the CLI's JSON object form, the [{key,value}] form and {key:{value}} form, tolerating a preamble", () => {
  assert.deepEqual(parseExport('{"GH_PAT":"ghp_x","CURSOR_API_KEY":"key_y"}'), { GH_PAT: "ghp_x", CURSOR_API_KEY: "key_y" });
  assert.deepEqual(parseExport('[{"key":"GH_PAT","value":"ghp_x"},{"key":"NOPE"}]'), { GH_PAT: "ghp_x", NOPE: "" });
  assert.deepEqual(parseExport('{"GH_PAT":{"value":"ghp_x","path":"/"}}'), { GH_PAT: "ghp_x" });
  assert.deepEqual(parseExport("Fetched 2 secrets\n{\"A\":\"1\"}"), { A: "1" });
  assert.deepEqual(parseExport(""), {});
  assert.throws(() => parseExport("not json at all"), /no JSON object/);
});

test("planExport exports only the requested, non-empty keys as masked heredocs and reports the missing ones", () => {
  const plan = planExport({ GH_PAT: "ghp_x", CURSOR_API_KEY: "", EXTRA: "ignored", MULTI: "line1\nline2" }, ["GH_PAT", "CURSOR_API_KEY", "MULTI", "ABSENT"], { delimiter: "EOF" });
  assert.deepEqual(plan.fetched, ["GH_PAT", "MULTI"]);
  assert.deepEqual(plan.missing, ["CURSOR_API_KEY", "ABSENT"]);
  assert.deepEqual(plan.envLines, ["GH_PAT<<EOF", "ghp_x", "EOF", "MULTI<<EOF", "line1\nline2", "EOF"]);
  assert.ok(!plan.envLines.join("\n").includes("ignored"), "keys the job did not ask for are never exposed");
});

test("planExport refuses names that are not environment variables and values that contain the delimiter", () => {
  assert.throws(() => planExport({}, ["gh-pat"]), /not an environment variable name/);
  assert.throws(() => planExport({}, ["$(rm -rf)"]), /not an environment variable name/);
  assert.throws(() => planExport({ A: "x EOF y" }, ["A"], { delimiter: "EOF" }), /heredoc delimiter/);
  assert.equal(DEFAULT_ENV, "sdlc");
});
