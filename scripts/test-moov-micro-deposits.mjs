import assert from "node:assert/strict";

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("micro-deposit code validation", () => {
  const validate = (code) => {
    return typeof code === "string" && /^\d{4}$/.test(code);
  };

  assert.ok(validate("1234"), "Valid 4-digit code");
  assert.ok(!validate("123"), "Too short");
  assert.ok(!validate("12345"), "Too long");
  assert.ok(!validate("abcd"), "Non-numeric");
});

test("micro-deposit status mapping", () => {
  const mapStatus = (moovStatus) => {
    const s = String(moovStatus).toLowerCase();
    if (s === "verified") return "connected";
    if (s === "errored" || s === "failed") return "failed";
    if (s === "expired") return "expired";
    if (s === "awaiting-code" || s === "initiated") return "pending";
    return "pending";
  };
  
  assert.equal(mapStatus("verified"), "connected");
  assert.equal(mapStatus("initiated"), "pending");
  assert.equal(mapStatus("awaiting-code"), "pending");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("expired"), "expired");
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
