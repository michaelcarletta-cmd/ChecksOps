import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ccc = readFileSync(new URL("../../src/pages/CheckCommandCenter.tsx", import.meta.url), "utf8");
const invariants = readFileSync(new URL("../../src/lib/checkImageInvariants.ts", import.meta.url), "utf8");
const adjuster = readFileSync(new URL("../../src/components/checks/EndorsementAdjuster.tsx", import.meta.url), "utf8");

test("merge keeps R1 Claim Check: no Reviewed By", () => {
  assert.equal(ccc.includes("Reviewed By"), false);
});

test("merge keeps R1 Claim Check linked-claim contract", () => {
  assert.equal(ccc.includes("claim_id.slice"), false);
  assert.match(ccc, /linkedClaim\.claim_number/);
  assert.match(ccc, /linkedClaim\.policyholder_name/);
  assert.match(ccc, /Claim #\$\{num\}/);
  assert.match(ccc, /title="Open claim ledger"/);
  assert.match(ccc, /Not linked/);
  assert.match(ccc, /Link \/ Select/);
  assert.match(ccc, /Linked claim \(unavailable\)/);
  assert.match(ccc, /Linked claim \(not found\)/);
});

test("merge ports deposit recovery onto R1 CCC without replacing the file", () => {
  assert.match(ccc, /recoverCleanBackOriginalPath/);
  assert.match(ccc, /resolveCleanBackOriginalPath/);
  assert.match(ccc, /loadAudits:/);
  assert.match(ccc, /loadSiblingNames:/);
  assert.match(ccc, /assertCleanBackOriginalPath\(recovered\.path\)/);
  assert.match(ccc, /assertCleanBackOriginalPath\(\s*recovered\.ok \? recovered\.path : endorsementAdjusterSourcePath/);
});

test("merge keeps generated-artifact guard and checkalt rejection", () => {
  assert.match(invariants, /export function assertCleanBackOriginalPath/);
  assert.match(invariants, /Refusing to treat a generated artifact as the clean original back image/);
  assert.match(invariants, /\\\.checkalt\\\.jpg/);
  assert.match(invariants, /export function recoverCleanBackOriginalPath/);
  assert.match(invariants, /export function depositImagePersistPatch/);
  assert.match(adjuster, /depositImagePersistPatch/);
  assert.match(adjuster, /assertCleanBackOriginalPath\(originalImagePath\)/);
});
