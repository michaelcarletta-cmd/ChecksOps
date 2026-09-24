/**
 * Moov generally-available rollout tests.
 *
 * Proves:
 *   - every tenant (including existing non-Freedom orgs) may start onboarding
 *   - new tenants receive the same production Moov configuration
 *   - test accounts stay on sandbox
 *   - the emergency kill switch still works
 *   - identity/KYB, ToS, bank, wallet, and capability gates still block money
 *
 * Run: bun scripts/test-moov-ga.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMoovAllowedForTenant, PAYMENT_FLAGS } from "../src/lib/payments/featureFlags.ts";
import {
  tenantMoovDefaults,
  shouldPromoteExistingTenantToProduction,
} from "../src/lib/payments/tenantMoovDefaults.ts";
import { evaluateReadiness } from "../supabase/functions/_shared/moovReadiness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function moovGloballyEnabled(env = {}) {
  const raw = env.MOOV_ENABLED;
  if (raw == null || raw === "") return true;
  return String(raw).toLowerCase() === "true";
}

const readyInput = {
  environment: "production",
  accountId: "acct_existing",
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

test("global Moov flag defaults on for GA", () => {
  assert.equal(PAYMENT_FLAGS.USE_MOOV, true);
});

test("existing non-Freedom tenant is eligible even when historically not allowlisted", () => {
  // C1C / Condition 1 Commercial is a live ChecksOps tenant that was never on
  // the Freedom-only Moov allowlist. After GA they can start onboarding.
  const c1c = {
    id: "4f172140-f57a-4744-8050-95f4f07b13b4",
    slug: "c1c",
    name: "Condition 1 Commercial",
    moov_allowlisted: false,
    moov_environment: "sandbox",
    is_test_account: false,
    has_moov_account: false,
  };
  assert.notEqual(c1c.slug, "freedom");
  assert.equal(isMoovAllowedForTenant(c1c.moov_allowlisted), true);
  assert.equal(shouldPromoteExistingTenantToProduction(c1c), true);
  assert.equal(isMoovAllowedForTenant(false), true);
  assert.equal(isMoovAllowedForTenant(null), true);
  assert.equal(isMoovAllowedForTenant(undefined), true);
});

test("Freedom and every other tenant share the same eligibility rule", () => {
  assert.equal(isMoovAllowedForTenant(true), isMoovAllowedForTenant(false));
});

test("new live tenants receive production Moov configuration", () => {
  const created = {
    name: "North Shore Restoration",
    slug: "north-shore-restoration",
    ...tenantMoovDefaults(),
  };
  assert.deepEqual(created, {
    name: "North Shore Restoration",
    slug: "north-shore-restoration",
    payment_provider: "moov",
    moov_allowlisted: true,
    moov_environment: "production",
  });
  assert.deepEqual(tenantMoovDefaults(), {
    payment_provider: "moov",
    moov_allowlisted: true,
    moov_environment: "production",
  });
});

test("new test tenants receive sandbox Moov configuration", () => {
  assert.deepEqual(tenantMoovDefaults({ isTestAccount: true }), {
    payment_provider: "moov",
    moov_allowlisted: true,
    moov_environment: "sandbox",
  });
});

test("existing live tenant without a Moov account is promoted to production", () => {
  assert.equal(
    shouldPromoteExistingTenantToProduction({
      is_test_account: false,
      moov_environment: "sandbox",
      has_moov_account: false,
    }),
    true,
  );
});

test("existing tenant mid-onboarding keeps its current Moov environment", () => {
  assert.equal(
    shouldPromoteExistingTenantToProduction({
      is_test_account: false,
      moov_environment: "sandbox",
      has_moov_account: true,
    }),
    false,
  );
});

test("test accounts are not promoted to production", () => {
  assert.equal(
    shouldPromoteExistingTenantToProduction({
      is_test_account: true,
      moov_environment: "sandbox",
      has_moov_account: false,
    }),
    false,
  );
});

test("MOOV_ENABLED defaults on and remains an emergency kill switch", () => {
  assert.equal(moovGloballyEnabled({}), true);
  assert.equal(moovGloballyEnabled({ MOOV_ENABLED: "" }), true);
  assert.equal(moovGloballyEnabled({ MOOV_ENABLED: "true" }), true);
  assert.equal(moovGloballyEnabled({ MOOV_ENABLED: "false" }), false);
});

test("readiness still blocks money movement without ToS, KYB, bank, or send-funds", () => {
  assert.equal(evaluateReadiness({ ...readyInput, termsAccepted: false }).canMoveMoney, false);
  const kyc = evaluateReadiness({
    ...readyInput,
    verificationStatus: "pending",
    capabilities: [
      {
        capability: "send-funds.ach",
        status: "pending",
        requirements: { currentlyDue: ["business.ein"] },
      },
      { capability: "wallet.balance", status: "enabled" },
      { capability: "transfers", status: "enabled" },
    ],
  });
  assert.equal(kyc.canMoveMoney, false);
  assert.equal(kyc.checks.find((c) => c.id === "identity_verification")?.state, "action_required");
  assert.equal(evaluateReadiness({ ...readyInput, banks: [{ status: "pending" }] }).canMoveMoney, false);
  assert.equal(
    evaluateReadiness({
      ...readyInput,
      capabilities: [{ capability: "wallet.balance", status: "enabled" }],
    }).canMoveMoney,
    false,
  );
  const ready = evaluateReadiness(readyInput);
  assert.equal(ready.checks.find((c) => c.id === "terms_of_service")?.state, "ready");
  assert.equal(ready.checks.find((c) => c.id === "identity_verification")?.state, "ready");
  assert.equal(ready.checks.find((c) => c.id === "bank_verified")?.state, "ready");
  assert.equal(ready.checks.find((c) => c.id === "send_funds_ach")?.state, "ready");
});

test("migration backfills every tenant and defaults new inserts to production Moov", () => {
  const sql = readFileSync(
    join(root, "supabase/migrations/20260924120000_moov_generally_available.sql"),
    "utf8",
  );
  assert.match(sql, /SET moov_allowlisted = true/);
  assert.match(sql, /WHERE moov_allowlisted IS DISTINCT FROM true/);
  assert.match(sql, /payment_provider = 'moov'/);
  assert.match(sql, /moov_environment SET DEFAULT 'production'/);
  assert.match(sql, /apply_tenant_moov_ga_defaults/);
  assert.match(sql, /BEFORE INSERT ON public\.tenants/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /payment_provider_accounts/);
  assert.doesNotMatch(sql, /slug = 'freedom'/);
  assert.doesNotMatch(sql, /UPDATE public\.checkalt/i);
  assert.doesNotMatch(sql, /ALTER TABLE public\.checkalt/i);
});

test("runtime gates no longer consult moov_allowlisted", () => {
  const files = [
    "supabase/functions/_shared/moovGuard.ts",
    "supabase/functions/_shared/moovPlaidBridge.ts",
    "supabase/functions/wallet-fund-on-clear/index.ts",
    "aws/functions/api/providers/parity/caller.mjs",
    "src/hooks/usePaymentProviderEligibility.ts",
    "src/components/settings/TenantPaymentAccountPanel.tsx",
  ];
  for (const rel of files) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.doesNotMatch(src, /moov_allowlisted/, rel);
    assert.doesNotMatch(src, /not enabled for this payment provider/, rel);
  }
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
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\n${tests.length} passed`);
