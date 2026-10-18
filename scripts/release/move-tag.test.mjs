import assert from "node:assert/strict";
import test from "node:test";
import { decideMove } from "./move-tag.mjs";

test("moves only when the commit is ahead of the tag", () => {
  assert.equal(decideMove({ compareStatus: "ahead" }).action, "move");
});

test("skips identical, behind and diverged commits", () => {
  for (const compareStatus of ["identical", "behind", "diverged"]) {
    assert.equal(decideMove({ compareStatus }).action, "skip", compareStatus);
  }
});

test("rejects an unknown compare status", () => {
  assert.throws(() => decideMove({ compareStatus: "weird" }), /Unexpected compare status/);
});
