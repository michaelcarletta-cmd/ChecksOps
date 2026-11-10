/**
 * Starter Package (SQL 151, owner 2026-11-10): the API waives Monthly Maintenance for the months the
 * package covers, validates what the platform owner saves, and the usage page summarizes it. Fixtures only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  assembleInvoiceTotals,
  invoiceSummaryLines,
  parseStarterPackage,
  saveBillingSettings,
  starterPackageCoversMaintenance,
  starterPackageFromRow,
  SET_TENANT_STARTER_PACKAGE_SQL,
} from '../functions/api/tenant-billing-engine.mjs';
import {
  defaultMaintenanceEndsOn,
  starterPackageFromRow as spaPackageFromRow,
  starterPackageSummary,
} from '../../src/lib/billing/starterPackageModel.ts';

const PKG = { enabled: true, starts_on: '2026-11-10', maintenance_ends_on: '2027-11-09', included_checks: 250, checks_used: 0, checks_left: 250 };

test('1 maintenance is included for each whole month inside the package: twelve months from Nov 10', () => {
  const covered = [];
  for (let i = 0; i < 16; i += 1) {
    const d = new Date(Date.UTC(2026, 9 + i, 1));
    const period = d.toISOString().slice(0, 7);
    if (starterPackageCoversMaintenance(PKG, period)) covered.push(period);
  }
  assert.deepEqual(covered, ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10']);
  assert.equal(starterPackageCoversMaintenance({ ...PKG, enabled: false }, '2026-12'), false);
  assert.equal(starterPackageCoversMaintenance(null, '2026-12'), false);
  assert.equal(starterPackageCoversMaintenance(PKG, 'bad'), false);
});

test('2 a covered month charges usage only (no maintenance, no discount); other months are unchanged', () => {
  const tenant = { monthly_rate_cents: 10000, referral_discount_cents: 2500, starter_package: PKG };
  const checks = [{ unit_price_cents: 0 }, { unit_price_cents: 400 }];
  const nextDay = [{ unit_price_cents: 75 }];
  const covered = assembleInvoiceTotals({ tenant, period: '2027-01', checks, nextDay, sameDay: [] });
  assert.equal(covered.maintenance_included, true);
  assert.equal(covered.maintenance_net_cents, 0);
  assert.equal(covered.discount_cents, 0);
  assert.equal(covered.amount_cents, 475);
  assert.deepEqual(invoiceSummaryLines({ ok: true, ...covered })[0],
    { key: 'maintenance', label: 'Monthly maintenance (included in Starter Package)', count: 1, amount_cents: 0 });
  const after = assembleInvoiceTotals({ tenant, period: '2027-11', checks, nextDay, sameDay: [] });
  assert.equal(after.maintenance_included, false);
  assert.equal(after.maintenance_net_cents, 7500);
  assert.equal(after.amount_cents, 7500 + 475);
  // No package (or before SQL 151): exactly as before.
  const plain = assembleInvoiceTotals({ tenant: { monthly_rate_cents: 10000 }, period: '2027-01', checks: [], nextDay: [], sameDay: [] });
  assert.equal(plain.maintenance_included, false);
  assert.equal(plain.amount_cents, 10000);
});

test('3 the package read: null before SQL 151, checks left never negative', () => {
  assert.equal(starterPackageFromRow(undefined), null);
  assert.equal(starterPackageFromRow({}), null);
  assert.deepEqual(starterPackageFromRow({
    starter_package_enabled: true, starter_package_starts_on: '2026-11-10', starter_package_maintenance_ends_on: '2027-11-09',
    starter_package_included_checks: 250, starter_package_checks_used: 260,
  }), { enabled: true, starts_on: '2026-11-10', maintenance_ends_on: '2027-11-09', included_checks: 250, checks_used: 260, checks_left: 0 });
});

test('4 what the platform owner saves is validated before the database sees it', () => {
  assert.equal(parseStarterPackage({ enabled: true, starts_on: '2026-11-10' }).ok, true);
  assert.equal(parseStarterPackage({ enabled: false }).ok, true);
  for (const bad of [null, [], { enabled: 'yes' }, { enabled: true }, { enabled: true, starts_on: '11/10/2026' },
    { enabled: true, starts_on: '2026-11-10', maintenance_ends_on: '2027-13-01' },
    { enabled: true, starts_on: '2026-11-10', included_checks: -1 }, { enabled: true, starts_on: '2026-11-10', included_checks: 2.5 }]) {
    assert.equal(parseStarterPackage(bad).ok, false, JSON.stringify(bad));
  }
});

test('5 saveBillingSettings calls the SQL 151 setter with the parsed values; a missing setter is a clear 503', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql === SET_TENANT_STARTER_PACKAGE_SQL) {
        const error = new Error('function does not exist');
        error.code = '42883';
        throw error;
      }
      return { rows: [] };
    },
  };
  const result = await saveBillingSettings(client, {
    tenantId: '11111111-1111-4111-8111-111111111111', userId: 'u',
    starterPackage: { enabled: true, starts_on: '2026-11-10', maintenance_ends_on: null, included_checks: 250 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'starter_package_setter_missing');
  assert.equal(result.statusCode, 503);
  assert.deepEqual(calls.find(([sql]) => sql === SET_TENANT_STARTER_PACKAGE_SQL)[1],
    ['11111111-1111-4111-8111-111111111111', true, '2026-11-10', null, 250]);
  const bad = await saveBillingSettings(client, { tenantId: 't', userId: 'u', starterPackage: { enabled: true } });
  assert.equal(bad.error, 'invalid_starter_package');
});

test('6 the handler passes starter_package through; the SPA helpers default and summarize', () => {
  const handlers = fs.readFileSync(new URL('../functions/api/tenant-billing-handlers.mjs', import.meta.url), 'utf8');
  assert.match(handlers, /starterPackage: body\.starter_package,/);
  assert.equal(defaultMaintenanceEndsOn('2026-11-10'), '2027-11-09');
  assert.equal(defaultMaintenanceEndsOn('2028-02-29'), '2029-02-28');
  assert.equal(defaultMaintenanceEndsOn(''), null);
  const pkg = spaPackageFromRow({
    starter_package_enabled: true, starter_package_starts_on: '2026-11-10', starter_package_maintenance_ends_on: '2027-11-09',
    starter_package_included_checks: 250,
  }, 63);
  assert.equal(pkg.checks_left, 187);
  assert.equal(starterPackageSummary(pkg, new Date('2026-12-01T00:00:00Z')), '187 of 250 included checks left · maintenance included through Nov 9, 2027');
  assert.equal(starterPackageSummary({ ...pkg, enabled: false }), null);
  assert.equal(spaPackageFromRow({}, 0), null);
});
