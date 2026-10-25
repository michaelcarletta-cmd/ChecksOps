/**
 * Settings > Stakeholder Accounts on PostgreSQL 16: the /data/write stakeholder_accounts executor
 * (write-app-metadata.mjs executeStakeholderAccounts) against the real SQL 114 grant
 * (aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql, run as its owner
 * checksops_admin) and the real aws_select_stakeholder_accounts / aws_write_stakeholder_accounts
 * policies (helpers/sql114-stakeholder-schema.mjs), as the API login checksops (a member of
 * authenticated) with request.app_user_id set as /data/write sets it:
 *
 *   - MEMBER_B (owner of TENANT_B, staff) changes their tenant's homeowner row to contractor:
 *     homeowner_name and homeowner_email are cleared; then removes it (is_active and
 *     is_primary false);
 *   - TENANT_A's row is not found for MEMBER_B (cross-tenant), and MEMBER_A (a viewer of
 *     TENANT_A without a write role) matches no row under aws_write_stakeholder_accounts:
 *     nothing changes;
 *   - a row with a connected payee (external_payment_recipients.disconnected_at IS NULL) is
 *     refused; once disconnected it can be removed.
 *
 * Run: node --test aws/tests/stakeholder-accounts-settings-write-pg.test.mjs (as root the PG
 * helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import { MEMBER_A, MEMBER_B, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { STAKEHOLDERS, STAKEHOLDER_A, STAKEHOLDER_B, STAKEHOLDER_SETTINGS_SCHEMA } from './helpers/sql114-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL114 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql'), 'utf8');
const PAYEE_ROW = 'b1000000-0000-4000-8000-0000000000b2';

// origin (SQL 113 writes provider_recipient) and a minimal external_payment_recipients
// (SQL 113: stakeholder_account_id, disconnected_at; SELECT for checksops and authenticated).
const PAYEE_SCHEMA = `
ALTER TABLE ${STAKEHOLDERS} ADD COLUMN IF NOT EXISTS origin text;
CREATE TABLE public.external_payment_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  stakeholder_account_id uuid,
  disconnected_at timestamptz
);
GRANT SELECT ON TABLE public.external_payment_recipients TO checksops, authenticated;
INSERT INTO ${STAKEHOLDERS} (id, tenant_id, name, account_type, is_primary, origin) VALUES
  ('${PAYEE_ROW}', '${TENANT_B}', 'B payee', 'vendor', false, 'provider_recipient');
INSERT INTO public.external_payment_recipients (tenant_id, stakeholder_account_id) VALUES ('${TENANT_B}', '${PAYEE_ROW}');`;

async function withPg(t, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-stakeholder-settings-', 59724, { extra: [STAKEHOLDER_SETTINGS_SCHEMA, PAYEE_SCHEMA] });
  try {
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL114);
    } finally {
      await owner.end();
    }
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** One /data/write as the API login for `user`, committed when it succeeds. */
async function writeAs(connectAs, user, values, id) {
  const client = await connectAs('checksops');
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const out = await executeAppMetadataWrite({
      client,
      mapping: { application_user_id: user },
      table: 'stakeholder_accounts',
      op: 'update',
      values,
      filters: [{ column: 'id', op: 'eq', value: id }],
    });
    await client.query(out.error ? 'ROLLBACK' : 'COMMIT');
    return out;
  } finally {
    await client.end();
  }
}

const state = async (admin, id) => (await admin.query(
  `SELECT account_type, is_active, is_primary, homeowner_name, homeowner_email FROM ${STAKEHOLDERS} WHERE id = $1`,
  [id],
)).rows[0];

test('PostgreSQL 16: Settings changes a stakeholder\'s type and removes it under SQL 114 and aws_write_stakeholder_accounts; other tenants and payees are refused', { timeout: 600000 }, async (t) => withPg(t, async ({ admin, connectAs }) => {
  const untouchedA = await state(admin, STAKEHOLDER_A);

  // Type change: homeowner to contractor clears the homeowner fields.
  const typed = await writeAs(connectAs, MEMBER_B, { account_type: 'contractor' }, STAKEHOLDER_B);
  assert.equal(typed.error, undefined, JSON.stringify(typed));
  assert.equal(typed.rows.length, 1);
  assert.deepEqual(await state(admin, STAKEHOLDER_B), {
    account_type: 'contractor', is_active: true, is_primary: true, homeowner_name: null, homeowner_email: null,
  });

  // Cross-tenant: TENANT_A's row is not one of MEMBER_B's tenants.
  for (const values of [{ account_type: 'vendor' }, { is_active: false, is_primary: false }]) {
    const out = await writeAs(connectAs, MEMBER_B, values, STAKEHOLDER_A);
    assert.equal(out.error, 'rls_denied', JSON.stringify(values));
  }
  // MEMBER_A is a member of TENANT_A without a write role: the policy matches no row.
  for (const values of [{ account_type: 'vendor' }, { is_active: false, is_primary: false }]) {
    const out = await writeAs(connectAs, MEMBER_A, values, STAKEHOLDER_A);
    assert.equal(out.error, 'rls_denied', JSON.stringify(values));
  }
  assert.deepEqual(await state(admin, STAKEHOLDER_A), untouchedA);

  // A connected payee is not deactivated here ...
  const payee = await writeAs(connectAs, MEMBER_B, { is_active: false, is_primary: false }, PAYEE_ROW);
  assert.equal(payee.error, 'operation_not_allowlisted');
  assert.equal(payee.reason, 'payee_disconnect_required');
  assert.equal((await state(admin, PAYEE_ROW)).is_active, true);
  // ... its type can change (a label; no provider or verification column) ...
  assert.equal((await writeAs(connectAs, MEMBER_B, { account_type: 'subcontractor' }, PAYEE_ROW)).error, undefined);
  // ... and once disconnected it can be removed.
  await admin.query('UPDATE public.external_payment_recipients SET disconnected_at = now() WHERE stakeholder_account_id = $1', [PAYEE_ROW]);
  assert.equal((await writeAs(connectAs, MEMBER_B, { is_active: false, is_primary: false }, PAYEE_ROW)).error, undefined);
  assert.deepEqual(await state(admin, PAYEE_ROW), {
    account_type: 'subcontractor', is_active: false, is_primary: false, homeowner_name: null, homeowner_email: null,
  });

  // Remove the non-payee row; reactivation is refused before any statement.
  const removed = await writeAs(connectAs, MEMBER_B, { is_active: false, is_primary: false }, STAKEHOLDER_B);
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  assert.equal((await state(admin, STAKEHOLDER_B)).is_active, false);
  assert.equal((await writeAs(connectAs, MEMBER_B, { is_active: true }, STAKEHOLDER_B)).error, 'invalid_field');
  // An inactive row's type is not changed.
  assert.equal((await writeAs(connectAs, MEMBER_B, { account_type: 'vendor' }, STAKEHOLDER_B)).error, 'rls_denied');
  assert.equal((await state(admin, STAKEHOLDER_B)).account_type, 'contractor');
}));
