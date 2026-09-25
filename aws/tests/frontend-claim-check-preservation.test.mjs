import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../../src/pages/CheckCommandCenter.tsx", import.meta.url), "utf8");

test("Claim Check details keep accepted linked-claim strings and do not show Reviewed By or raw claim_id", () => {
  assert.equal(src.includes("Reviewed By"), false);
  assert.equal(src.includes("claim_id.slice"), false);
  assert.match(src, /Not linked/);
  assert.match(src, /Link \/ Select/);
  assert.match(src, /Linked claim \(unavailable\)/);
  assert.match(src, /Linked claim \(not found\)/);
});
