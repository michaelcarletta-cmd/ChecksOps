/**
 * Moov sweep rules tests — pure logic, no network, no database.
 *
 * Run:  bun scripts/test-sweep-rules.mjs
 */
import assert from "node:assert/strict";
import {
  availablePushRails,
  centsToDecimalString,
  minimumBalanceToCents,
  normalizeStatementDescriptor,
  normalizeSweepStatus,
  parseMinimumBalanceCents,
  selectSweepPullMethod,
  selectSweepPushMethod,
  SWEEP_PULL_RAIL,
} from "../supabase/functions/_shared/sweepRules.ts";

const FULL = {
  railPaymentMethodIds: {
    "instant-bank-credit": "pm_instant",
    "ach-credit-same-day": "pm_sd",
    "ach-credit-standard": "pm_std",
    "ach-debit-fund": "pm_debit",
  },
};
const ACH_ONLY = { railPaymentMethodIds: { "ach-credit-standard": "pm_std" } };
const NONE = { railPaymentMethodIds: {} };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("prefers instant-bank-credit when supported", () => {
  const s = selectSweepPushMethod(FULL);
  assert.equal(s.railType, "instant-bank-credit");
  assert.equal(s.paymentMethodId, "pm_instant");
  assert.equal(s.reason, null);
});

test("falls back to the fastest available rail", () => {
  const s = selectSweepPushMethod({
    railPaymentMethodIds: { "ach-credit-same-day": "pm_sd", "ach-credit-standard": "pm_std" },
  });
  assert.equal(s.railType, "ach-credit-same-day");
});

test("standard ACH only", () => {
  assert.equal(selectSweepPushMethod(ACH_ONLY).railType, "ach-credit-standard");
});

test("no push rail available is rejected", () => {
  const s = selectSweepPushMethod(NONE);
  assert.equal(s.paymentMethodId, null);
  assert.equal(s.reason, "no_push_rail_available");
});

test("explicit rail that is not supported is rejected, not downgraded", () => {
  const s = selectSweepPushMethod(ACH_ONLY, "instant-bank-credit");
  assert.equal(s.railType, null);
  assert.equal(s.reason, "rail_not_available_on_method");
});

test("unknown rail name is rejected", () => {
  assert.equal(selectSweepPushMethod(FULL, "wire").reason, "unsupported_rail_requested");
  assert.equal(selectSweepPushMethod(FULL, SWEEP_PULL_RAIL).reason, "unsupported_rail_requested");
});

test("available rails exclude the debit funding method", () => {
  assert.deepEqual(availablePushRails(FULL), [
    "instant-bank-credit",
    "ach-credit-same-day",
    "ach-credit-standard",
  ]);
});

test("pull method resolves only from ach-debit-fund", () => {
  assert.equal(selectSweepPullMethod(FULL), "pm_debit");
  assert.equal(selectSweepPullMethod(ACH_ONLY), null);
});

test("minimum balance conversion", () => {
  assert.equal(parseMinimumBalanceCents("125.50"), 12550);
  assert.equal(parseMinimumBalanceCents("$1,000"), 100000);
  assert.equal(parseMinimumBalanceCents(0), 0);
  assert.equal(parseMinimumBalanceCents(""), 0);
  assert.equal(parseMinimumBalanceCents(null), 0);
  assert.equal(parseMinimumBalanceCents(12.34), 1234);
});

test("minimum balance rejects bad input", () => {
  assert.throws(() => parseMinimumBalanceCents("-5"));
  assert.throws(() => parseMinimumBalanceCents("1.234"));
  assert.throws(() => parseMinimumBalanceCents("abc"));
  assert.throws(() => parseMinimumBalanceCents(-1));
  assert.throws(() => parseMinimumBalanceCents(20_000_000));
});

test("cents render as a Moov decimal string", () => {
  assert.equal(centsToDecimalString(12550), "125.50");
  assert.equal(centsToDecimalString(0), "0.00");
});

test("minimum balance parses back from both Moov shapes", () => {
  assert.equal(minimumBalanceToCents("125.50"), 12550);
  assert.equal(minimumBalanceToCents({ valueDecimal: "125.50" }), 12550);
  assert.equal(minimumBalanceToCents({ value: 12550 }), 12550);
  assert.equal(minimumBalanceToCents(null), 0);
});

test("statement descriptor validation", () => {
  assert.equal(normalizeStatementDescriptor("CHECKSOPS"), "CHECKSOPS");
  assert.equal(normalizeStatementDescriptor("  "), null);
  assert.equal(normalizeStatementDescriptor(null), null);
  assert.throws(() => normalizeStatementDescriptor("THIS IS TOO LONG"));
  assert.throws(() => normalizeStatementDescriptor("emoji🙂"));
});

test("status normalization defaults to disabled", () => {
  assert.equal(normalizeSweepStatus("enabled"), "enabled");
  assert.equal(normalizeSweepStatus("ENABLED"), "enabled");
  assert.equal(normalizeSweepStatus("weird"), "disabled");
  assert.equal(normalizeSweepStatus(undefined), "disabled");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`fail  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
