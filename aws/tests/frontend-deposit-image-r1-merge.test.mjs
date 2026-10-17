import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ccc = readFileSync(new URL("../../src/pages/CheckCommandCenter.tsx", import.meta.url), "utf8");
const invariants = readFileSync(new URL("../../src/lib/checkImageInvariants.ts", import.meta.url), "utf8");
const adjuster = readFileSync(new URL("../../src/components/checks/EndorsementAdjuster.tsx", import.meta.url), "utf8");

// Ported from Cursor ce4370a5d / 05acf1a65. Cursor's two R1 Claim Check UI pins
// ("no Reviewed By", linked-claim copy) are not ported: they pin a Claim Check
// layout that main has since redesigned and are unrelated to back-original recovery.

test("merge ports deposit recovery onto R1 CCC without replacing the file", () => {
  assert.match(ccc, /recoverCleanBackOriginalPath/);
  assert.match(ccc, /resolveCleanBackOriginalPath/);
  assert.match(ccc, /loadAudits:/);
  assert.match(ccc, /loadSiblingNames:/);
  assert.match(ccc, /probeCleanStemPaths:/);
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
