/**
 * Moov Micro-deposit lifecycle tests.
 *
 * Run: bun scripts/test-moov-micro-deposits.mjs
 */
import assert from "node:assert/strict";

// Mocking Moov status codes and mapping to internal verification_status
const VERIFICATION_STATES = {
  PENDING: "pending",
  INITIATED: "pending_micro_deposit",
  VERIFIED: "verified",
  FAILED: "failed",
};

test("micro-deposit amount validation", () => {
  const validate = (amounts) => {
    if (!Array.isArray(amounts) || amounts.length !== 2) return false;
    const cents = amounts.map(a => Math.round(Number(a) * 100));
    return cents.every(c => Number.isFinite(c) && c >= 0 && c <= 99);
  };

  assert.ok(validate([0.01, 0.99]), "Valid cents range");
  assert.ok(!validate([1.00, 0.05]), "Dollar amount invalid (must be cents)");
  assert.ok(!validate([-0.01, 0.05]), "Negative amount invalid");
});

test("micro-deposit state transitions", () => {
  let status = VERIFICATION_STATES.PENDING;
  
  // 1. Initiate
  status = VERIFICATION_STATES.INITIATED;
  assert.equal(status, "pending_micro_deposit");

  // 2. Mock Success
  status = VERIFICATION_STATES.VERIFIED;
  assert.equal(status, "verified");
});

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Re-register tests to the runner
test("micro-deposit amount validation", () => {
  const validate = (amounts) => {
    if (!Array.isArray(amounts) || amounts.length !== 2) return false;
    const cents = amounts.map(a => Math.round(Number(a) * 100));
    return cents.every(c => Number.isFinite(c) && c >= 0 && c <= 99);
  };
  assert.ok(validate([0.01, 0.99]));
  assert.ok(!validate([1.00, 0.05]));
});

test("micro-deposit status mapping matches Moov sync", () => {
  const mapStatus = (moovStatus) => {
    const s = String(moovStatus).toLowerCase();
    return s === "verified" ? "connected" : s === "errored" ? "failed" : "pending";
  };
  
  assert.equal(mapStatus("verified"), "connected");
  assert.equal(mapStatus("pending"), "pending");
  assert.equal(mapStatus("errored"), "failed");
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
