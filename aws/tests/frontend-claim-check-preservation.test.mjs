import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../../src/pages/CheckCommandCenter.tsx", import.meta.url), "utf8");
const deleteBtn = readFileSync(new URL("../../src/components/checks/AdminDeleteCheckButton.tsx", import.meta.url), "utf8");

test("R1-1 Reviewed By is absent from Claim Check details", () => {
  assert.equal(src.includes("Reviewed By"), false);
});

test("R1-2 Audit tab still owns review attribution surface", () => {
  assert.match(src, /TabsTrigger value="audit"/);
  assert.match(src, /check_audit_log/);
});

test("R1-3/4 linked claim resolves claim number + homeowner, not UUID slice", () => {
  assert.equal(src.includes("claim_id.slice"), false);
  assert.match(src, /linkedClaim\.claim_number/);
  assert.match(src, /linkedClaim\.policyholder_name/);
  assert.match(src, /Claim #\$\{num\}/);
});

test("R1-5 linked claim is clickable to Funds / Claim Ledger", () => {
  assert.match(src, /title="Open claim ledger"/);
  assert.match(src, /onClick=\{\(\) => setDetailTab\("funds"\)\}/);
});

test("R1-6 genuinely unlinked shows Not linked + Link/Select", () => {
  assert.match(src, /Not linked/);
  assert.match(src, /Link \/ Select/);
});

test("R1-7 lookup failure is distinguishable from unlinked", () => {
  assert.match(src, /Loading linked claim…/);
  assert.match(src, /Linked claim \(unavailable\)/);
  assert.match(src, /Linked claim \(not found\)/);
  assert.match(src, /title="Retry linked claim lookup"/);
});

test("R1-8 Delete Check still trims reason and requires >= 3 characters", () => {
  assert.match(deleteBtn, /reason\.trim\(\)/);
  assert.match(deleteBtn, /trimmed\.length >= 3/);
  assert.match(deleteBtn, /p_reason: trimmed/);
});
