import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKS_BY_TENANT_SQL, runAuthorizationProbe } from '../functions/api/authorization.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { loadJson } from '../../scripts/lib/release-locks.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = '2418c458-c011-70b7-07ac-6b9da2d9415d';

const sql31 = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/31_partner_safe_read.sql'), 'utf8');
const sql32 = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/32_partner_share_lifecycle.sql'), 'utf8');
const sql33 = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/33_partner_stage_totals.sql'), 'utf8');
const sql34 = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/34_c1c_partner_visibility.sql'), 'utf8');
const invariant = fs.readFileSync(path.join(ROOT, 'aws/rls/PARTNER_SHARING_INVARIANT.md'), 'utf8');
const proof = fs.readFileSync(path.join(ROOT, 'ops/release-locks/proof/c1c-partner-share-production-apply.md'), 'utf8');
const shareDialog = fs.readFileSync(path.join(ROOT, 'src/components/check-review/ShareCheckDialog.tsx'), 'utf8');
const commandCenter = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
const partnerSafeReads = fs.readFileSync(path.join(ROOT, 'src/lib/partnerSafeReads.ts'), 'utf8');

const FORBIDDEN_OWNERSHIP_REPAIR = /UPDATE\s+public\.check_intake_items/i;

test('PARTNER SHARING INVARIANT is recorded as ownership ≠ visibility', () => {
  assert.match(invariant, /PARTNER SHARING INVARIANT/);
  assert.match(invariant, /Check ownership and check visibility are separate concepts/);
  assert.match(invariant, /check_intake_items\.tenant_id = viewing_partner/);
  assert.match(invariant, /active `shared_checks` relationship/);
  assert.match(invariant, /Never "repair" partner visibility by transferring check ownership/);
  assert.match(invariant, /duplicating the parent check/);
  assert.match(invariant, /0. C1C-owned historical rows is \*\*not\*\* equivalent to `0` C1C-accessible checks/);
  assert.match(invariant, new RegExp(C1C));
  assert.match(invariant, new RegExp(FREEDOM));
});

test('production SQL proof records 31/32/33/34 APPLIED IN PRODUCTION and forbids reapply', () => {
  assert.match(proof, /APPLIED IN PRODUCTION/);
  assert.match(proof, /Do \*\*not\*\* reapply/);
  assert.match(proof, /31_partner_safe_read\.sql/);
  assert.match(proof, /32_partner_share_lifecycle\.sql/);
  assert.match(proof, /33_partner_stage_totals\.sql/);
  assert.match(proof, /34_c1c_partner_visibility\.sql/);
  assert.match(proof, /9aac7bb5b1ed0a8d03e305552797a9acfacc7f64/);
  assert.match(proof, /a85a29698e3cfa65ec29b0a834d24c74b2a7cac9c83c72d8ba9f4bb88949dd0f/);
  assert.match(proof, /3e2e12811c8795fed6e139aca60d4b1b43d1c5223b132e34a767fada99331af8/);
  assert.match(proof, /d4e12f1b6a35fcf37730f57fbfa116e24bf8f6ab69a7001182a9f2687ff7ab17/);
  assert.match(proof, /131792eef8cfca02d4cf837b3afc8f4e4bda76b281d9db8c4e825c428d65f0bd/);
});

test('ledger appends production apply_evidence for the four partner-share SQL files', () => {
  const ledger = loadJson(path.join(ROOT, 'ops/release-locks/applied-migrations.ledger.json'));
  const evidence = ledger.entries.filter((row) => row.record_kind === 'apply_evidence');
  const byPath = Object.fromEntries(evidence.map((row) => [row.path, row]));
  for (const rel of [
    'aws/rls/sql/31_partner_safe_read.sql',
    'aws/rls/sql/32_partner_share_lifecycle.sql',
    'aws/rls/sql/33_partner_stage_totals.sql',
    'aws/rls/sql/34_c1c_partner_visibility.sql',
  ]) {
    const row = byPath[rel];
    assert.equal(row?.applied, true, rel);
    assert.equal(row?.applied_environment, 'production', rel);
    assert.equal(row?.applied_sha256, row?.source_sha256, rel);
    assert.equal(row?.proof_path, 'ops/release-locks/proof/c1c-partner-share-production-apply.md', rel);
    assert.match(row?.status || '', /applied_in_production/);
  }
});

test('repair SQL never transfers ownership or duplicates the parent check', () => {
  for (const [name, sql] of [['31', sql31], ['32', sql32], ['33', sql33], ['34', sql34]]) {
    assert.equal(FORBIDDEN_OWNERSHIP_REPAIR.test(sql), false, name);
    assert.equal(/INSERT\s+INTO\s+public\.check_intake_items/i.test(sql), false, name);
  }
  assert.match(sql34, /aws_is_active_shared_check_target/);
  assert.match(sql34, /aws_select_check_intake_items/);
  assert.match(sql34, /OR public\.aws_is_active_shared_check_target\(id\)/);
  assert.equal(/aws_write_check_intake_items/.test(sql34), false);
  assert.match(sql33, /get_check_stage_totals/);
  assert.match(sql33, /sc\.target_tenant_id = p_tenant_id/);
  assert.match(sql33, /sc\.revoked_at IS NULL/);
  assert.match(sql32, /aws_share_check_with_partner/);
  assert.match(sql32, /aws_revoke_shared_check/);
  assert.match(sql31, /aws_partner_check_payees/);
  assert.match(sql31, /aws_partner_check_endorsements/);
});

test('Checks query and isolation distinguish owned vs shared accessible', () => {
  assert.match(CHECKS_BY_TENANT_SQL, /freedom_owned/);
  assert.match(CHECKS_BY_TENANT_SQL, /c1c_owned/);
  assert.match(CHECKS_BY_TENANT_SQL, /c1c_shared_accessible/);
  assert.match(CHECKS_BY_TENANT_SQL, /aws_is_active_shared_check_target/);
  assert.match(CHECKS_BY_TENANT_SQL, new RegExp(C1C));
  assert.match(CHECKS_BY_TENANT_SQL, new RegExp(FREEDOM));
});

test('0 C1C-owned historical rows is not 0 C1C-accessible checks', async () => {
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql.includes('auth.uid()') && sql.includes('has_role')) {
        return { rows: [{ has_staff: true, has_admin: false }] };
      }
      if (sql.includes('auth.uid()')) return { rows: [{ auth_uid: APP_ID }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{
          application_user_id: APP_ID,
          cognito_sub: COGNITO_SUB,
          email: 'c1c@example.test',
          status: 'active',
        }] };
      }
      if (sql.includes('FROM public._aws_rls_probe_items')) {
        return { rows: [] };
      }
      if (sql.includes('aws_user_tenant_ids')) {
        return { rows: [{ tenant_id: C1C }] };
      }
      if (sql === USER_ROLES_SQL) {
        return { rows: [{ role: 'admin' }] };
      }
      if (sql.includes('FROM public.claims')) {
        return { rows: [{ n: 0, freedom: 0, org_null: 0 }] };
      }
      if (sql === CHECKS_BY_TENANT_SQL) {
        return { rows: [{
          freedom: 94,
          c1c: 0,
          freedom_owned: 94,
          c1c_owned: 0,
          c1c_shared_accessible: 94,
          freedom_shared_accessible: 0,
          visible: 94,
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await runAuthorizationProbe({
    cognitoSub: COGNITO_SUB,
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checksVisible.owned.c1c, 0);
  assert.equal(result.checksVisible.sharedAccessible.c1c, 94);
  assert.equal(result.checksVisible.hasCheckAccess, true);
  assert.equal(result.isolation.hasCheckAccess, true);
  assert.notEqual(result.checksVisible.owned.c1c, result.checksVisible.sharedAccessible.c1c);
});

test('Share dialog and Checks queue use tenants_public plus partner-safe children', () => {
  assert.match(shareDialog, /tenants_public/);
  assert.match(shareDialog, /share_check_with_partner/);
  assert.match(shareDialog, /revoke_shared_check/);
  assert.match(commandCenter, /tenants_public/);
  assert.match(commandCenter, /attachPartnerPayees/);
  assert.match(commandCenter, /get_check_stage_totals/);
  assert.match(commandCenter, /shared_checks/);
  assert.match(partnerSafeReads, /aws_partner_check_payees/);
  assert.match(partnerSafeReads, /aws_partner_check_endorsements/);
});
