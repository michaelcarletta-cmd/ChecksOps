import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { authorizeCheckAltProduction } from '../functions/api/providers/production/checkalt-authz.mjs';
import { membershipForTenant, verifyOwnershipChain } from '../functions/api/financial-ownership.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'rls/sql');

const SOURCE_TENANT = '11111111-1111-4111-8111-111111111111';
const PARTNER_TENANT = '22222222-2222-4222-8222-222222222222';
const PARTNER_USER = 'a1000000-0000-4000-8000-000000000002';
const SHARED_CHECK = 'c1000000-0000-4000-8000-000000000001';

const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

const functionBody = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const next = sql.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
  const revoke = sql.indexOf(`REVOKE ALL ON FUNCTION public.${name}(`, start);
  const end = Math.min(
    next === -1 ? sql.length : next,
    revoke === -1 ? sql.length : revoke,
  );
  return sql.slice(start, end);
};

const selectPoliciesUsing = (sql, needle) => {
  const policies = [];
  const re = /CREATE POLICY (aws_select_[a-z0-9_]+) ON public\.([a-z0-9_]+)\n\s+FOR SELECT TO authenticated\n\s+USING \(([\s\S]*?)\);/g;
  let match;
  while ((match = re.exec(sql))) {
    if (match[3].includes(needle)) {
      policies.push({ policy: match[1], table: match[2], using: match[3].replace(/\s+/g, ' ').trim() });
    }
  }
  return policies;
};

test('aws_can_access_check is SELECT-only and write helpers stay owner-tenant', () => {
  const helpers = readSql('11_access_helpers.sql');
  const writeHelpers = readSql('20_write_helpers.sql');
  const selectSql = readSql('12_final_select_policies.sql');
  const writeSql = readSql('24_complete_write_policies.sql');
  const proposedWrite = readSql('21_proposed_write_policies.sql');
  const workflow = fs.readFileSync(path.join(ROOT, 'workflows/sql/65_staging_workflow_rpc_grants.sql'), 'utf8');
  const grants = readSql('15_access_grants.sql');
  const oneshot = fs.readFileSync(path.join(ROOT, 'rls/oneshot/index.mjs'), 'utf8');

  const access = functionBody(helpers, 'aws_can_access_check');
  const shareTarget = functionBody(helpers, 'aws_is_active_shared_check_target');
  const writeCheck = functionBody(writeHelpers, 'aws_can_write_check');
  const writeExpr = writeCheck.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1] || '';

  assert.match(shareTarget, /revoked_at IS NULL/);
  assert.match(shareTarget, /aws_can_access_tenant\(sc\.target_tenant_id\)/);
  assert.match(access, /aws_is_active_shared_check_target\(_check_id\)/);
  assert.ok(writeExpr);
  assert.equal(/shared_checks/.test(writeExpr), false);
  assert.equal(/aws_can_access_check/.test(writeExpr), false);
  assert.equal(/aws_is_active_shared_check_target/.test(writeExpr), false);
  assert.match(writeHelpers, /Do not add shared_checks/);

  assert.match(grants, /GRANT EXECUTE ON FUNCTION public\.aws_is_active_shared_check_target\(uuid\)/);
  assert.match(oneshot, /aws_is_active_shared_check_target/);

  const helperSelect = selectPoliciesUsing(selectSql, 'aws_can_access_check(');
  assert.ok(helperSelect.length >= 20, `expected helper SELECT policies, got ${helperSelect.length}`);
  for (const row of helperSelect) {
    assert.match(row.policy, /^aws_select_/);
  }

  const writeUsesAccess = /aws_can_access_check/.test(writeSql)
    || /aws_can_access_check/.test(proposedWrite)
    || /aws_can_access_check/.test(workflow);
  assert.equal(writeUsesAccess, false);

  const policyByTable = {};
  const re = /CREATE POLICY (aws_select_[a-z0-9_]+) ON public\.([a-z0-9_]+)\n\s+FOR SELECT TO authenticated\n\s+USING \(([\s\S]*?)\);/g;
  let match;
  while ((match = re.exec(selectSql))) {
    policyByTable[match[2]] = match[3].replace(/\s+/g, ' ').trim();
  }
  assert.match(policyByTable.check_intake_items, /aws_is_active_shared_check_target\(id\)/);
  assert.equal(/aws_is_active_shared_check_target/.test(policyByTable.check_payees || ''), false);
  assert.equal(/aws_is_active_shared_check_target/.test(policyByTable.check_endorsements || ''), false);
  assert.match(policyByTable.check_payment_directions, /aws_can_access_check_non_partner/);
  assert.equal(/aws_can_access_check\(check_id\)/.test(policyByTable.check_payment_directions || ''), false);
  assert.match(policyByTable.deposit_items, /aws_can_access_check_non_partner/);

  const signatureAccess = functionBody(helpers, 'aws_can_access_signature_request');
  const depositAccess = functionBody(helpers, 'aws_can_access_deposit_item');
  assert.match(signatureAccess, /aws_can_access_check_non_partner/);
  assert.equal(/aws_can_access_check\(sr\.check_intake_item_id\)/.test(signatureAccess), false);
  assert.match(depositAccess, /aws_can_access_check_non_partner/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION public\.aws_can_access_check_non_partner\(uuid\)/);
  assert.match(oneshot, /aws_can_access_check_non_partner/);
  assert.match(oneshot, /31_partner_safe_read\.sql/);
});

test('child SELECT inventory via aws_can_access_check is check-scoped and excludes tenant secrets', () => {
  const selectSql = readSql('12_final_select_policies.sql');
  const viaHelper = selectPoliciesUsing(selectSql, 'aws_can_access_check(').map((row) => row.table).sort();
  const expected = [
    'check_deletion_log',
    'check_deposit_image_backfill_queue',
    'check_eligibility_results',
    'check_endorsement_events',
    'check_files',
    'check_intake_mortgage_draws',
    'check_message_reads',
    'check_messages',
    'check_reconciliation_alerts',
    'check_status_audit',
    'claim_check_mortgage_draws',
    'claim_checks',
    'claim_disbursements',
    'claim_payments',
    'endorsement_audit_log',
    'endorsement_requests',
    'loss_draft_tracking',
    'mortgage_releases',
    'shared_check_messages',
    'shared_checks',
    'signature_requests',
  ];
  assert.deepEqual(viaHelper, expected);

  for (const secretTable of [
    'checkalt_config',
    'checkalt_tenant_accounts',
    'payment_wallets',
    'stakeholder_accounts',
    'micro_deposit_verifications',
    'tenant_email_settings',
    'tenants',
  ]) {
    assert.equal(viaHelper.includes(secretTable), false, secretTable);
    assert.match(
      selectSql,
      new RegExp(`aws_select_${secretTable}[\\s\\S]*aws_can_access_tenant|aws_select_${secretTable}[\\s\\S]*aws_is_cross_tenant_reader`),
    );
  }
});

test('API money movement still requires owner-tenant membership, not shared-check read', async () => {
  const partnerMemberships = [{ tenant_id: PARTNER_TENANT, role: 'admin' }];
  const ownerCheck = { id: SHARED_CHECK, tenant_id: SOURCE_TENANT, amount: 125.5 };

  assert.equal(membershipForTenant(partnerMemberships, SOURCE_TENANT), null);

  const ownership = verifyOwnershipChain({
    applicationUserId: PARTNER_USER,
    memberships: partnerMemberships,
    check: ownerCheck,
    claimed: { tenant_id: SOURCE_TENANT, check_id: SHARED_CHECK },
  });
  assert.equal(ownership.ok, false);
  assert.equal(ownership.error, 'tenant_membership_required');

  const wallet = verifyOwnershipChain({
    applicationUserId: PARTNER_USER,
    memberships: partnerMemberships,
    check: ownerCheck,
    wallet: { id: 'w-owner', tenant_id: SOURCE_TENANT },
  });
  assert.equal(wallet.ok, false);
  assert.equal(wallet.error, 'tenant_membership_required');

  const moov = verifyOwnershipChain({
    applicationUserId: PARTNER_USER,
    memberships: partnerMemberships,
    check: ownerCheck,
    providerAccount: { id: 'acct', tenant_id: SOURCE_TENANT },
  });
  assert.equal(moov.ok, false);
  assert.equal(moov.error, 'tenant_membership_required');

  const checkalt = await authorizeCheckAltProduction({
    client: {
      query: async () => {
        throw new Error('CheckAlt must deny before tenant-role or step-up queries');
      },
    },
    mapping: { application_user_id: PARTNER_USER },
    memberships: partnerMemberships,
    check: ownerCheck,
  });
  assert.equal(checkalt.ok, false);
  assert.equal(checkalt.statusCode, 403);
  assert.equal(checkalt.error, 'cross_tenant_denied');
  assert.equal(checkalt.liveProviderCalled, false);
});

const FORBIDDEN_PARTNER_COLUMNS = [
  'token',
  'token_expires_at',
  'endorsement_token',
  'endorsement_token_expires_at',
  'secure_token',
  'access_token',
  'token_hash',
  'signature_data',
  'provider_payload',
  'provider_response',
  'provider_status_raw',
  'increase_raw_response',
];

test('partner-safe views omit capability secrets and are allowlisted for /data', () => {
  const views = readSql('31_partner_safe_read.sql');
  const allowed = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'functions/api/allowed-tables.json'),
    'utf8',
  ));
  for (const name of [
    'aws_partner_check_endorsements',
    'aws_partner_check_payees',
    'aws_partner_signature_signers',
  ]) {
    assert.match(views, new RegExp(`CREATE VIEW public\\.${name}`));
    assert.equal(allowed.includes(name), true, name);
    assert.match(views, /aws_is_active_shared_check_target/);
  }
  for (const col of FORBIDDEN_PARTNER_COLUMNS) {
    assert.equal(
      new RegExp(`\\b${col}\\b`).test(views.replace(/COMMENT ON VIEW[\s\S]*?;/g, '')),
      false,
      col,
    );
  }
  assert.match(views, /security_invoker = false/);
  assert.match(views, /GRANT SELECT ON TABLE public\.aws_partner_check_endorsements TO checksops, authenticated/);
});

