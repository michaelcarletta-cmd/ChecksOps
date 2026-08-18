import assert from "node:assert/strict";

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("micro-deposit amount validation", () => {
  const validate = (amounts) => {
    if (!Array.isArray(amounts) || amounts.length !== 2) return false;
    const cents = amounts.map(a => Math.round(Number(a) * 100));
    return cents.every(c => Number.isFinite(c) && c >= 1 && c <= 99);
  };

  assert.ok(validate([0.01, 0.99]), "Valid cents range");
  assert.ok(!validate([1.00, 0.05]), "Dollar amount invalid");
});

test("micro-deposit status mapping", () => {
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
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.error("FAIL  " + name + "\n      " + e.message);
  }
}
console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
