import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKS_BY_TENANT_SQL } from '../functions/api/authorization.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql33 = fs.readFileSync(path.join(ROOT, 'rls/sql/33_partner_stage_totals.sql'), 'utf8');
const sql34 = fs.readFileSync(path.join(ROOT, 'rls/sql/34_c1c_partner_visibility.sql'), 'utf8');
const oneshot = fs.readFileSync(path.join(ROOT, 'rls/oneshot/index.mjs'), 'utf8');
const completeAuth = fs.readFileSync(path.join(ROOT, 'rls/oneshot/completeAuth.mjs'), 'utf8');
const inspectOneshot = fs.readFileSync(path.join(ROOT, 'c1c-partner-share/oneshot/index.mjs'), 'utf8');
const shareDialog = fs.readFileSync(path.join(ROOT, '../src/components/check-review/ShareCheckDialog.tsx'), 'utf8');
const commandCenter = fs.readFileSync(path.join(ROOT, '../src/pages/CheckCommandCenter.tsx'), 'utf8');

test('34 restores share-target read without changing ownership or write policies', () => {
  assert.match(sql34, /aws_is_active_shared_check_target/);
  assert.match(sql34, /aws_select_check_intake_items/);
  assert.match(sql34, /aws_is_active_shared_check_target\(id\)/);
  assert.equal(/aws_write_check_intake_items/.test(sql34), false);
  assert.equal(/UPDATE public\.check_intake_items/.test(sql34), false);
  assert.match(oneshot, /34_c1c_partner_visibility\.sql/);
  assert.match(completeAuth, /34_c1c_partner_visibility\.sql/);
});

test('get_check_stage_totals includes active shared_checks without changing ownership', () => {
  assert.match(sql33, /CREATE OR REPLACE FUNCTION public\.get_check_stage_totals/);
  assert.match(sql33, /shared_checks/);
  assert.match(sql33, /sc\.target_tenant_id = p_tenant_id/);
  assert.match(sql33, /sc\.revoked_at IS NULL/);
  assert.match(sql33, /c\.tenant_id = p_tenant_id/);
  assert.equal(/UPDATE public\.check_intake_items/.test(sql33), false);
  assert.equal(/tenant_id = C1C/.test(sql33), false);
  assert.match(oneshot, /33_partner_stage_totals\.sql/);
  assert.match(completeAuth, /33_partner_stage_totals\.sql/);
});

test('isolation SQL distinguishes owned vs shared accessible checks', () => {
  assert.match(CHECKS_BY_TENANT_SQL, /freedom_owned/);
  assert.match(CHECKS_BY_TENANT_SQL, /c1c_owned/);
  assert.match(CHECKS_BY_TENANT_SQL, /c1c_shared_accessible/);
  assert.match(CHECKS_BY_TENANT_SQL, /aws_is_active_shared_check_target/);
});

test('inspect oneshot is read-only by default and restore is fail-closed', () => {
  assert.match(inspectOneshot, /step === 'inspect'/);
  assert.match(inspectOneshot, /RESTORE_MISSING_ACTIVE_SHARES/);
  assert.match(inspectOneshot, /APPLY_PARTNER_SAFE_DDL/);
  assert.match(inspectOneshot, /31_partner_safe_read\.sql/);
  assert.match(inspectOneshot, /ownership_not_freedom/);
  assert.equal(/UPDATE public\.check_intake_items/.test(inspectOneshot), false);
  assert.match(inspectOneshot, /deleted: 0/);
});

test('Share button and partner queue resolve partner names via tenants_public', () => {
  assert.match(shareDialog, /tenants_public/);
  assert.match(shareDialog, /share_check_with_partner/);
  assert.match(shareDialog, /revoke_shared_check/);
  assert.match(commandCenter, /tenants_public/);
  assert.match(commandCenter, /attachPartnerPayees/);
  assert.equal(/tenants!shared_checks_source_tenant_id_fkey/.test(commandCenter), false);
  assert.equal(/tenants!shared_checks_target_tenant_id_fkey/.test(shareDialog), false);
});

test('TenantPartnerManager resolves names via tenants_public and does not embed tenants', () => {
  const partnerManager = fs.readFileSync(
    path.join(ROOT, '../src/components/white-label/TenantPartnerManager.tsx'),
    'utf8',
  );
  assert.match(partnerManager, /tenants_public/);
  assert.match(partnerManager, /partnerName/);
  assert.equal(/tenants!tenant_partnerships_inviter_tenant_id_fkey/.test(partnerManager), false);
  assert.equal(/invitee:tenants!/.test(partnerManager), false);
  assert.match(partnerManager, /connect_partner_by_code/);
  assert.match(partnerManager, /revoke_tenant_partnership/);
});
