/**
 * Rail router tests — pure logic, no network, no database.
 *
 * Run:  bun scripts/test-rail-router.mjs
 */
import assert from "node:assert/strict";
import {
  MOOV_RAIL_BY_SPEED,
  RTP_MAX_CENTS,
  normalizeSpeed,
  sameDayWindowOpen,
  selectRail,
} from "../supabase/functions/_shared/railRouter.ts";

const ALL_RAILS = {
  "ach-credit-standard": "pm_std",
  "ach-credit-same-day": "pm_sd",
  "rtp-credit": "pm_rtp",
};
const ACH_ONLY = { "ach-credit-standard": "pm_std" };

// Business hours on a Wednesday (10:00 ET) and after cutoff (18:00 ET).
const DURING = new Date("2026-08-19T14:00:00Z");
const AFTER_CUTOFF = new Date("2026-08-19T22:00:00Z");
const SATURDAY = new Date("2026-08-22T14:00:00Z");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("speed normalization", () => {
  assert.equal(normalizeSpeed("same-day"), "same_day");
  assert.equal(normalizeSpeed("next_day"), "standard");
  assert.equal(normalizeSpeed("RTP"), "instant");
  assert.equal(normalizeSpeed(undefined), "standard");
});

test("standard ACH uses the standard rail", () => {
  const d = selectRail({ requestedSpeed: "standard", amountCents: 100_00, railPaymentMethodIds: ALL_RAILS, now: DURING });
  assert.equal(d.selectedSpeed, "standard");
  assert.equal(d.railType, MOOV_RAIL_BY_SPEED.standard);
  assert.equal(d.paymentMethodId, "pm_std");
  assert.equal(d.downgraded, false);
});

test("same-day ACH before cutoff is honoured", () => {
  const d = selectRail({ requestedSpeed: "same_day", amountCents: 5_000_00, railPaymentMethodIds: ALL_RAILS, now: DURING });
  assert.equal(d.railType, "ach-credit-same-day");
  assert.equal(d.paymentMethodId, "pm_sd");
  assert.equal(d.downgraded, false);
});

test("same-day after ET cutoff downgrades to standard", () => {
  const d = selectRail({ requestedSpeed: "same_day", amountCents: 5_000_00, railPaymentMethodIds: ALL_RAILS, now: AFTER_CUTOFF });
  assert.equal(d.selectedSpeed, "standard");
  assert.equal(d.reason, "past_same_day_cutoff");
  assert.equal(d.downgraded, true);
  assert.equal(sameDayWindowOpen(AFTER_CUTOFF), false);
});

test("same-day on a weekend downgrades to standard", () => {
  const d = selectRail({ requestedSpeed: "same_day", amountCents: 100_00, railPaymentMethodIds: ALL_RAILS, now: SATURDAY });
  assert.equal(d.selectedSpeed, "standard");
  assert.equal(d.reason, "past_same_day_cutoff");
});

test("instant uses RTP when the recipient supports it", () => {
  const d = selectRail({ requestedSpeed: "instant", amountCents: 2_500_00, railPaymentMethodIds: ALL_RAILS, now: DURING });
  assert.equal(d.railType, "rtp-credit");
  assert.equal(d.paymentMethodId, "pm_rtp");
  assert.equal(d.downgraded, false);
});

test("instant over the network ceilings falls all the way back to standard", () => {
  // Above the RTP ceiling, and also above the same-day ACH ceiling, so the
  // whole chain downgrades to standard ACH rather than failing the payout.
  const big = RTP_MAX_CENTS + 1;
  const d = selectRail({ requestedSpeed: "instant", amountCents: big, railPaymentMethodIds: ALL_RAILS, now: DURING });
  assert.equal(d.selectedSpeed, "standard");
  assert.equal(d.reason, "amount_exceeds_rtp_limit");
  assert.equal(d.downgraded, true);
  assert.deepEqual(
    d.evaluated.map((e) => [e.speed, e.reason]),
    [
      ["instant", "amount_exceeds_rtp_limit"],
      ["same_day", "amount_exceeds_same_day_limit"],
      ["standard", null],
    ],
  );
});

test("instant recipient without RTP, after cutoff, lands on standard", () => {
  const d = selectRail({ requestedSpeed: "instant", amountCents: 500_00, railPaymentMethodIds: ACH_ONLY, now: AFTER_CUTOFF });
  assert.equal(d.selectedSpeed, "standard");
  assert.equal(d.railType, "ach-credit-standard");
  assert.equal(d.downgraded, true);
});

test("non-eligible recipient (ACH only) downgrades instant to standard", () => {
  const d = selectRail({ requestedSpeed: "instant", amountCents: 100_00, railPaymentMethodIds: ACH_ONLY, now: DURING });
  assert.equal(d.selectedSpeed, "standard");
  assert.equal(d.railType, "ach-credit-standard");
  assert.equal(d.reason, "rail_not_supported_by_recipient");
  assert.equal(d.paymentMethodId, "pm_std");
});

test("no rail metadata preserves legacy behaviour", () => {
  const d = selectRail({
    requestedSpeed: "same_day",
    amountCents: 100_00,
    railPaymentMethodIds: {},
    fallbackPaymentMethodId: "legacy_bank_id",
    now: DURING,
  });
  assert.equal(d.railType, null, "no rail hint is sent to Moov");
  assert.equal(d.paymentMethodId, "legacy_bank_id");
  assert.equal(d.reason, "rail_metadata_unavailable");
});

test("supportedRails without ids still routes, using the fallback id", () => {
  const d = selectRail({
    requestedSpeed: "same_day",
    amountCents: 100_00,
    supportedRails: ["ach-credit-standard", "ach-credit-same-day"],
    fallbackPaymentMethodId: "legacy_bank_id",
    now: DURING,
  });
  assert.equal(d.railType, "ach-credit-same-day");
  assert.equal(d.paymentMethodId, "legacy_bank_id");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} rail router tests passed.`);
process.exit(failed === 0 ? 0 : 1);
