/**
 * Moov readiness + bulk-import validation tests (pure logic).
 *
 * Run:  bun scripts/test-moov-readiness.mjs
 */
import assert from "node:assert/strict";
import {
  bankState,
  capabilityFamily,
  capabilityState,
  evaluateReadiness,
  findCapability,
} from "../supabase/functions/_shared/moovReadiness.ts";
import { previewImport, validateRow, MAX_IMPORT_ROWS } from "../supabase/functions/_shared/moovImportRules.ts";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const readyInput = {
  environment: "sandbox",
  accountId: "acct_1",
  capabilities: [
    { capability: "send-funds.ach", status: "enabled" },
    { capability: "wallet.balance", status: "enabled" },
    { capability: "transfers", status: "enabled" },
  ],
  banks: [{ status: "verified" }],
  verificationStatus: "verified",
  termsAccepted: true,
  feePlanCode: "standard",
};

test("dotted capability ids resolve to their family", () => {
  assert.equal(capabilityFamily("send-funds.ach"), "send-funds");
  assert.ok(findCapability([{ capability: "send-funds", status: "enabled" }], "send-funds.ach"));
  assert.ok(findCapability([{ capability: "send-funds.ach", status: "enabled" }], "send-funds"));
});

test("capability status mapping", () => {
  assert.equal(capabilityState(null), "not_started");
  assert.equal(capabilityState({ capability: "x", status: "enabled" }), "ready");
  assert.equal(capabilityState({ capability: "x", status: "pending" }), "pending");
  assert.equal(capabilityState({ capability: "x", status: "errored" }), "action_required");
});

test("bank linking alone is not verification", () => {
  assert.equal(bankState([]), "not_started");
  assert.equal(bankState([{ status: "pending" }]), "pending");
  assert.equal(bankState([{ status: "errored" }]), "action_required");
  assert.equal(bankState([{ status: "pending" }, { status: "verified" }]), "ready");
});

test("fully provisioned sandbox account is ready", () => {
  const r = evaluateReadiness(readyInput);
  assert.equal(r.canMoveMoney, true);
  assert.equal(r.overall, "ready");
  assert.equal(r.isSandbox, true);
});

test("production environment is not flagged sandbox", () => {
  const r = evaluateReadiness({ ...readyInput, environment: "production" });
  assert.equal(r.isSandbox, false);
});

test("missing terms of service blocks money movement", () => {
  const r = evaluateReadiness({ ...readyInput, termsAccepted: false });
  assert.equal(r.canMoveMoney, false);
  assert.equal(r.overall, "action_required");
});

test("unverified bank blocks money movement", () => {
  const r = evaluateReadiness({ ...readyInput, banks: [{ status: "pending" }] });
  assert.equal(r.canMoveMoney, false);
  assert.equal(r.overall, "pending");
});

test("missing send-funds capability blocks money movement", () => {
  const r = evaluateReadiness({
    ...readyInput,
    capabilities: [{ capability: "wallet.balance", status: "enabled" }],
  });
  assert.equal(r.canMoveMoney, false);
});

test("wallet.balance pending does not block ACH sends", () => {
  const r = evaluateReadiness({
    ...readyInput,
    capabilities: [
      { capability: "send-funds.ach", status: "enabled" },
      { capability: "wallet.balance", status: "pending" },
    ],
  });
  assert.equal(r.canMoveMoney, true);
});

test("missing fee plan never blocks money movement", () => {
  const r = evaluateReadiness({ ...readyInput, feePlanCode: null, feePlanUnavailable: true });
  assert.equal(r.canMoveMoney, true);
  assert.equal(r.checks.find((c) => c.id === "fee_plan").state, "pending");
});

test("no account yet reports not_started", () => {
  const r = evaluateReadiness({
    environment: "sandbox",
    accountId: null,
    capabilities: [],
    banks: [],
    termsAccepted: false,
  });
  assert.equal(r.overall, "not_started");
  assert.equal(r.canMoveMoney, false);
});

test("currently-due requirements surface as action required", () => {
  const r = evaluateReadiness({
    ...readyInput,
    verificationStatus: "pending",
    capabilities: [
      {
        capability: "send-funds.ach",
        status: "pending",
        requirements: { currentlyDue: ["individual.ssn"] },
      },
    ],
  });
  assert.deepEqual(r.requirements, ["individual.ssn"]);
  assert.equal(r.checks.find((c) => c.id === "identity_verification").state, "action_required");
});

test("import rejects sensitive identity fields", () => {
  const r = validateRow({ tenant_id: "0f9b1d0e-1111-4222-8333-444455556666", legal_business_name: "A", ssn: "123" }, 0);
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.field === "ssn"));
});

test("import flags duplicates and counts validity", () => {
  const id = "0f9b1d0e-1111-4222-8333-444455556666";
  const p = previewImport([
    { tenant_id: id, legal_business_name: "Acme", email: "a@b.com" },
    { tenant_id: id, legal_business_name: "Acme", email: "a@b.com" },
    { legal_business_name: "No Tenant" },
  ]);
  assert.equal(p.totalRows, 3);
  assert.deepEqual(p.duplicateTenantIds, [id]);
  assert.equal(p.validRows, 1);
  assert.equal(p.invalidRows, 2);
});

test("import caps row count", () => {
  const rows = Array.from({ length: MAX_IMPORT_ROWS + 5 }, () => ({}));
  const p = previewImport(rows);
  assert.ok(p.errors.some((e) => e.includes("limited to")));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
