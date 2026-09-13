import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WRITE_ALLOWLIST, denyTableReason } from '../functions/api/write-allowlist.mjs';
import { PARTNER_SHARE_RPCS, executePartnerShareRpc } from '../functions/api/partner-share-lifecycle.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql32 = fs.readFileSync(path.join(ROOT, 'rls/sql/32_partner_share_lifecycle.sql'), 'utf8');
const writeHelpers = fs.readFileSync(path.join(ROOT, 'rls/sql/20_write_helpers.sql'), 'utf8');
const allowlist = fs.readFileSync(path.join(ROOT, 'functions/api/write-allowlist.mjs'), 'utf8');
const oneshot = fs.readFileSync(path.join(ROOT, 'rls/oneshot/index.mjs'), 'utf8');
const completeAuth = fs.readFileSync(path.join(ROOT, 'rls/oneshot/completeAuth.mjs'), 'utf8');

test('Phase 3 SQL drops global invite_code uniqueness and creates pair unique + DEFINER ops', () => {
  assert.match(sql32, /DROP CONSTRAINT IF EXISTS tenant_partnerships_invite_code_key/);
  assert.match(sql32, /tenant_partnerships_unique_pair/);
  assert.match(sql32, /aws_connect_partner_by_code/);
  assert.match(sql32, /aws_share_check_with_partner/);
  assert.match(sql32, /aws_revoke_shared_check/);
  assert.match(sql32, /aws_revoke_tenant_partnership/);
  assert.match(sql32, /SET row_security = off/);
  assert.match(sql32, /lookup_tenant_by_partner_code/);
  assert.match(sql32, /aws_can_write_check\(_check_id\)/);
  assert.match(sql32, /source_tenant_id = _source/);
  assert.equal(/GRANT INSERT ON TABLE public\.shared_checks/.test(sql32), false);
  assert.equal(/GRANT UPDATE ON TABLE public\.tenant_partnerships/.test(sql32), false);
  assert.match(sql32, /GRANT EXECUTE ON FUNCTION public\.aws_connect_partner_by_code/);
});

test('aws_can_write_check remains owner-only and share tables stay off the generic write allowlist', () => {
  const writeExpr = writeHelpers.match(/CREATE OR REPLACE FUNCTION public\.aws_can_write_check[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1] || '';
  assert.equal(/shared_checks/.test(writeExpr), false);
  assert.equal(/tenant_partnerships/.test(writeExpr), false);
  assert.equal(WRITE_ALLOWLIST.shared_checks, undefined);
  assert.equal(WRITE_ALLOWLIST.tenant_partnerships, undefined);
  assert.equal(denyTableReason('shared_checks'), 'unknown_table');
  assert.equal(denyTableReason('tenant_partnerships'), 'unknown_table');
  assert.equal(allowlist.includes("'shared_checks'"), false);
  assert.equal(allowlist.includes("'tenant_partnerships'"), false);
  assert.match(oneshot, /32_partner_share_lifecycle\.sql/);
  assert.match(completeAuth, /32_partner_share_lifecycle\.sql/);
});

test('dedicated RPCs ignore client ownership overrides', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ result: { ok: true, created: true } }] };
    },
  };
  const connected = await executePartnerShareRpc({
    client,
    name: 'connect_partner_by_code',
    args: {
      _code: 'AB3K7X9P',
      _source_tenant_id: '11111111-1111-4111-8111-111111111111',
      invitee_tenant_id: '99999999-9999-4999-8999-999999999999',
    },
  });
  assert.equal(connected.data.ok, true);
  assert.equal(connected.data.ignoredTargetTenantId, true);
  assert.equal(calls[0].params.length, 2);
  assert.equal(calls[0].params[0], 'AB3K7X9P');

  const shared = await executePartnerShareRpc({
    client,
    name: 'share_check_with_partner',
    args: {
      _check_id: 'c1111111-1111-4111-8111-111111111111',
      _target_tenant_id: '22222222-2222-4222-8222-222222222222',
      source_tenant_id: '99999999-9999-4999-8999-999999999999',
    },
  });
  assert.equal(shared.data.ignoredSourceTenantId, true);
  assert.equal(calls[1].params.length, 2);
  assert.equal(PARTNER_SHARE_RPCS.has('connect_partner_by_code'), true);
  assert.equal(PARTNER_SHARE_RPCS.has('lookup_tenant_by_partner_code'), false);
});
