import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const admin = readFileSync(new URL("../../src/pages/admin/AdminTenants.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../src/components/admin/MonthlyTenantBillingPanel.tsx", import.meta.url), "utf8");
const account = readFileSync(new URL("../../src/components/settings/TenantBillingAccountPanel.tsx", import.meta.url), "utf8");

test("Moov monthly-billing admin panel remains wired", () => {
  assert.match(admin, /MonthlyTenantBillingPanel/);
  assert.match(panel, /Monthly subscription billing/);
  assert.match(account, /Monthly subscription billing account authorized/);
});
