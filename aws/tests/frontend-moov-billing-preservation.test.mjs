import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const admin = readFileSync(new URL("../../src/pages/admin/AdminTenants.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../src/components/admin/MonthlyTenantBillingPanel.tsx", import.meta.url), "utf8");
const account = readFileSync(new URL("../../src/components/settings/TenantBillingAccountPanel.tsx", import.meta.url), "utf8");

test("Moov monthly-billing admin panel remains wired", () => {
  assert.match(admin, /MonthlyTenantBillingPanel/);
  assert.match(account, /Monthly subscription billing account authorized/);
});

test("PR #492 Mortgage Ops billing UI remains on AdminTenants / panel", () => {
  assert.match(admin, /mortgage_ops_initial/);
  assert.match(panel, /Mortgage Ops — First Check/);
  assert.match(panel, /Mortgage Ops — Additional Check/);
  assert.match(panel, /Consolidated ChecksOps invoice/);
});
