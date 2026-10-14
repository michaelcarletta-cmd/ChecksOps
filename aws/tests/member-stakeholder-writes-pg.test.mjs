/**
 * SQL 79 against PostgreSQL 16: the real RLS helper files, check_stakeholders
 * with its real policies and SQL 77 grant, the real SQL 78 table, then the real
 * SQL 79 file, driven through the real /data/write executor and directly.
 *
 * A plain member of the check owner's tenant (no user_roles row) can add and
 * remove stakeholders on that tenant's checks; members of another tenant and of
 * a partner tenant the check is shared with (even its admins) cannot; UPDATE
 * stays denied.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { executeAllowlistedWrite } from '../functions/api/write.mjs';
import { SQL_79, applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const A_MEMBER = 'a1000000-0000-4000-8000-00000000000a';
const B_MEMBER = 'a1000000-0000-4000-8000-00000000000b';
const P_MEMBER = 'a1000000-0000-4000-8000-0000000000f1';
const P_ADMIN = 'a1000000-0000-4000-8000-0000000000f2';
const CHECK_A = 'c1000000-0000-4000-8000-0000000000a1';
const CHECK_B = 'c1000000-0000-4000-8000-0000000000b1';
const ACCOUNT_A = '5a000000-0000-4000-8000-0000000000a1';
const ACCOUNT_B = '5a000000-0000-4000-8000-0000000000b1';

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B'), ('${PARTNER}', 'Partner');
INSERT INTO public.identity_accounts (application_user_id, status) VALUES
  ('${A_MEMBER}', 'active'), ('${B_MEMBER}', 'active'), ('${P_MEMBER}', 'active'), ('${P_ADMIN}', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${P_ADMIN}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${A_MEMBER}', 'member'), ('${TENANT_B}', '${B_MEMBER}', 'member'),
  ('${PARTNER}', '${P_MEMBER}', 'member'), ('${PARTNER}', '${P_ADMIN}', 'admin');
INSERT INTO public.check_intake_items (id, tenant_id, status) VALUES ('${CHECK_A}', '${TENANT_A}', 'received'), ('${CHECK_B}', '${TENANT_B}', 'received');
INSERT INTO public.stakeholder_accounts (id, tenant_id, name) VALUES ('${ACCOUNT_A}', '${TENANT_A}', 'Adjuster A'), ('${ACCOUNT_B}', '${TENANT_B}', 'Adjuster B');
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id) VALUES ('${CHECK_A}', '${TENANT_A}', '${PARTNER}');
`;

test('PostgreSQL 16: SQL 79 lets plain members of the owner tenant write check stakeholders, and nobody else', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql79-members-', 55300);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await applyBaseSchema(client);
    await client.query(SEED);

    /** One API request: a transaction as checksops (RLS on) for this user. */
    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const write = (user, table, body) => as(user, () => executeAllowlistedWrite({
      client,
      mapping: { application_user_id: user },
      body: { table, ...body },
      checkWorkflowEnabled: true,
      applicationWorkflowEnabled: false,
    }));
    const link = (user, checkId = CHECK_A, accountId = ACCOUNT_A) => write(user, 'check_stakeholders', {
      op: 'insert', values: { check_intake_item_id: checkId, stakeholder_account_id: accountId },
    });
    const removePartner = (user, checkId = CHECK_A) => write(user, 'check_partner_stakeholder_removals', {
      op: 'insert', values: { check_intake_item_id: checkId, partner_tenant_id: PARTNER },
    });
    const direct = (user, sql, params) => as(user, () => client.query(sql, params));
    const count = async (table) => Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    const OUTSIDERS = [B_MEMBER, P_MEMBER, P_ADMIN];

    // Before SQL 79 a plain member passes the API's membership gate but RLS refuses.
    await assert.rejects(link(A_MEMBER), /row-level security/);
    await assert.rejects(removePartner(A_MEMBER), /row-level security/);

    await client.query(fs.readFileSync(SQL_79, 'utf8'));

    // check_stakeholders: plain member links and unlinks on its own tenant's check.
    let result = await link(A_MEMBER);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.rows[0].tenant_id, TENANT_A);
    assert.equal(result.rows[0].added_by, A_MEMBER);
    const linkId = result.rows[0].id;
    // Another tenant's account is still refused.
    assert.equal((await link(A_MEMBER, CHECK_A, ACCOUNT_B)).error, 'rls_denied');
    // Not on another tenant's check either.
    assert.equal((await link(A_MEMBER, CHECK_B, ACCOUNT_B)).error, 'rls_denied');
    for (const user of OUTSIDERS) {
      assert.equal((await link(user)).error, 'rls_denied', user);
      assert.equal((await write(user, 'check_stakeholders', { op: 'delete', filters: [{ column: 'id', op: 'eq', value: linkId }] })).error, 'rls_denied', user);
      await assert.rejects(direct(user,
        'INSERT INTO public.check_stakeholders (check_intake_item_id, stakeholder_account_id, tenant_id) VALUES ($1, $2, $3)',
        [CHECK_A, ACCOUNT_A, TENANT_A]), /row-level security/, user);
      assert.equal((await direct(user, 'DELETE FROM public.check_stakeholders WHERE tenant_id = $1', [TENANT_A])).rowCount, 0, user);
    }
    await assert.rejects(direct(A_MEMBER, 'UPDATE public.check_stakeholders SET added_via = $1', ['manual']), /permission denied/);
    // A member cannot write a row for another tenant directly either.
    await assert.rejects(direct(A_MEMBER,
      'INSERT INTO public.check_stakeholders (check_intake_item_id, stakeholder_account_id, tenant_id) VALUES ($1, $2, $3)',
      [CHECK_B, ACCOUNT_B, TENANT_B]), /row-level security/);
    // The member insert policy also needs a manual link on a check the row's tenant owns.
    const insertLink = 'INSERT INTO public.check_stakeholders (check_intake_item_id, stakeholder_account_id, tenant_id, added_via) VALUES ($1, $2, $3, $4)';
    await assert.rejects(direct(A_MEMBER, insertLink, [CHECK_B, ACCOUNT_A, TENANT_A, 'manual']), /row-level security/);
    await assert.rejects(direct(A_MEMBER, insertLink, [CHECK_A, ACCOUNT_B, TENANT_A, 'partner_share']), /row-level security/);
    // B shared check B with A: A's member still cannot link on B's check under tenant A.
    await client.query(`INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id) VALUES ('${CHECK_B}', '${TENANT_B}', '${TENANT_A}')`);
    await assert.rejects(direct(A_MEMBER, insertLink, [CHECK_B, ACCOUNT_A, TENANT_A, 'manual']), /row-level security/);
    await client.query(`DELETE FROM public.shared_checks WHERE check_id = '${CHECK_B}'`);
    // The same insert, manual and on A's own check, passes (the EXISTS reads the check under its RLS).
    const manual = await direct(A_MEMBER, `${insertLink} RETURNING id`, [CHECK_A, ACCOUNT_B, TENANT_A, 'manual']);
    assert.equal(manual.rowCount, 1);
    assert.equal((await direct(A_MEMBER, 'DELETE FROM public.check_stakeholders WHERE id = $1', [manual.rows[0].id])).rowCount, 1);
    assert.equal(await count('public.check_stakeholders'), 1);
    result = await write(A_MEMBER, 'check_stakeholders', { op: 'delete', filters: [{ column: 'id', op: 'eq', value: linkId }] });
    assert.equal(result.rows.length, 1, JSON.stringify(result));
    assert.equal(await count('public.check_stakeholders'), 0);

    // check_partner_stakeholder_removals: same rules.
    result = await removePartner(A_MEMBER);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.rows[0].tenant_id, TENANT_A);
    assert.equal(result.rows[0].removed_by, A_MEMBER);
    const removalId = result.rows[0].id;
    for (const user of OUTSIDERS) {
      assert.equal((await removePartner(user)).error, 'rls_denied', user);
      assert.equal((await write(user, 'check_partner_stakeholder_removals', { op: 'delete', filters: [{ column: 'id', op: 'eq', value: removalId }] })).error, 'rls_denied', user);
      await assert.rejects(direct(user,
        'INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id) VALUES ($1, $2, $3)',
        [CHECK_A, TENANT_A, PARTNER]), /row-level security|duplicate key/, user);
      assert.equal((await direct(user, 'DELETE FROM public.check_partner_stakeholder_removals WHERE tenant_id = $1', [TENANT_A])).rowCount, 0, user);
    }
    await assert.rejects(direct(A_MEMBER, 'UPDATE public.check_partner_stakeholder_removals SET removed_by = NULL'), /permission denied/);
    assert.equal(await count('public.check_partner_stakeholder_removals'), 1);
    result = await write(A_MEMBER, 'check_partner_stakeholder_removals', {
      op: 'delete',
      filters: [{ column: 'check_intake_item_id', op: 'eq', value: CHECK_A }, { column: 'partner_tenant_id', op: 'eq', value: PARTNER }],
    });
    assert.equal(result.rows.length, 1, JSON.stringify(result));
    assert.equal(await count('public.check_partner_stakeholder_removals'), 0);
    // With no row present, a partner's direct insert is refused by RLS itself.
    for (const user of OUTSIDERS) {
      await assert.rejects(direct(user,
        'INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id) VALUES ($1, $2, $3)',
        [CHECK_A, TENANT_A, PARTNER]), /row-level security/, user);
    }
  } finally {
    await client.end();
    server.stop();
  }
});
