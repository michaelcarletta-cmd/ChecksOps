import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleDataQuery, handleDataRpc, sanitizeLogText, logDataQueryFailure } from '../functions/api/data.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { handleTaxProfiles } from '../functions/api/tax-profiles.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { denyTableReason, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import {
  denyTaxSecretQuery,
  denyTaxSecretRpc,
  denyTaxSecretWrite,
  evaluateTaxAccess,
  isTaxSecretTable,
  jsonHasFullTin,
  maskTinMetadata,
  normalizeSqlName,
  publicTaxProfile,
  sanitizeTaxError,
} from '../functions/api/tax-secrets.mjs';
import { canAccessTaxUi } from '../../src/lib/taxAccess.ts';
import {
  LEGACY_INFORMATIONAL_THRESHOLD,
  aggregateRecipientRows,
  buildPaymentReportingCsv,
  csvContainsTin,
} from '../../src/lib/taxYtdSummary.ts';
import {
  taxProfileMutationHasTin,
  taxProfileMutationVariables,
} from '../../src/lib/taxProfileMutation.ts';
import {
  TAX_PROFILES_UNAVAILABLE_HEADING,
  TAX_PROFILES_UNAVAILABLE_MESSAGE,
  TAX_PROFILE_STATUS_MISSING,
  TAX_PROFILE_STATUS_UNAVAILABLE,
  sanitizeBrowserTaxError,
  taxProfileEditorEnabled,
  taxProfileTinStatusLabel,
} from '../../src/lib/taxProfileStatus.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';
const SAMPLE_TIN = '12-3456789';
const SAMPLE_SSN = '123-45-6789';
const SAMPLE_UNFORMATTED = '123456789';

const jwtEvent = (pathName, method, body, headers = {}) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token', ...headers },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    requestId: 'req-tax-containment-test',
    authorizer: {
      jwt: {
        claims: {
          sub: COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          token_use: 'id',
        },
      },
    },
  },
});

const mappingFor = () => ({
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const maskedRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenant_id: TENANT_A,
  recipient_key: 'acct:1',
  recipient_name: 'Pat Contractor',
  address_street: '1 Main',
  address_city: 'Austin',
  address_state: 'TX',
  address_zip: '78701',
  account_number: null,
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  tin_on_file: true,
  tin_last_4: '6789',
  tin_type: 'ein',
};

const mockTaxClient = ({
  isOwner = false,
  platformRoles = [],
  tenantRole = null,
  membershipTenantId = TENANT_A,
  profiles = [maskedRow],
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [mappingFor()] : [] };
      }
      if (/is_platform_owner\(\)/.test(sql)) {
        return { rows: [{ is_owner: isOwner, is_master: isOwner }] };
      }
      if (/FROM public\.user_roles/.test(sql)) {
        return { rows: platformRoles.map((role) => ({ role })) };
      }
      if (/FROM public\.tenant_users/.test(sql)) {
        const requestedTenant = params?.[1];
        if (tenantRole && requestedTenant === membershipTenantId) {
          return { rows: [{ role: tenantRole }] };
        }
        return { rows: [] };
      }
      if (/INSERT INTO public\.recipient_tax_profiles/.test(sql)) {
        return { rows: [maskedRow] };
      }
      if (/FROM public\.recipient_tax_profiles/.test(sql)) {
        return { rows: profiles };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
  forceEnabled: true,
});

const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('tax access: ordinary member, operator, and platform staff are denied', () => {
  assert.equal(evaluateTaxAccess({ tenantMembershipRole: 'member' }).allowed, false);
  assert.equal(evaluateTaxAccess({ tenantMembershipRole: 'operator' }).allowed, false);
  assert.equal(evaluateTaxAccess({ tenantMembershipRole: 'viewer' }).allowed, false);
  assert.equal(evaluateTaxAccess({ platformRoles: ['staff'], tenantMembershipRole: 'operator' }).allowed, false);
  assert.equal(canAccessTaxUi({ tenantRole: 'operator' }), false);
  assert.equal(canAccessTaxUi({ platformRole: 'staff', tenantRole: 'viewer' }), false);
});

test('tax access: tenant owner/admin, platform admin, and platform owner allowed', () => {
  assert.equal(evaluateTaxAccess({ tenantMembershipRole: 'admin' }).reason, 'tenant_finance_admin');
  assert.equal(evaluateTaxAccess({ tenantMembershipRole: 'owner' }).allowed, true);
  assert.equal(evaluateTaxAccess({ platformRoles: ['admin'] }).reason, 'platform_admin');
  assert.equal(evaluateTaxAccess({ isPlatformOwner: true }).reason, 'platform_owner');
  assert.equal(canAccessTaxUi({ tenantRole: 'admin' }), true);
  assert.equal(canAccessTaxUi({ platformRole: 'admin' }), true);
  assert.equal(canAccessTaxUi({ isPlatformOwner: true }), true);
});

test('ordinary tenant member cannot list tax profiles', async () => {
  const client = mockTaxClient({ tenantRole: 'member' });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'forbidden');
  assert.equal(result.code, 'not_authorized');
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
});

test('unauthorized tenant operator/admin-equivalent is denied', async () => {
  const client = mockTaxClient({ tenantRole: 'operator' });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.code, 'not_authorized');
});

test('authorized tenant admin retrieves masked metadata only', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.ok, true);
  assert.equal(result.access, 'tenant_finance_admin');
  assert.equal(result.profiles[0].tin_on_file, true);
  assert.equal(result.profiles[0].tin_last_4, '6789');
  assert.equal(result.profiles[0].tin_type, 'ein');
  assert.equal('tin' in result.profiles[0], false);
  assert.equal('tin_encrypted' in result.profiles[0], false);
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
});

test('platform owner can list masked profiles for a tenant', async () => {
  const client = mockTaxClient({ isOwner: true, tenantRole: null });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.access, 'platform_owner');
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
});

test('platform admin can list masked profiles', async () => {
  const client = mockTaxClient({ platformRoles: ['admin'] });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.access, 'platform_admin');
});

test('cross-tenant access is denied even for a tenant admin', async () => {
  const client = mockTaxClient({ tenantRole: 'admin', membershipTenantId: TENANT_B });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.code, 'not_authorized');
});

test('upsert response never echoes the submitted TIN', async () => {
  const client = mockTaxClient({ tenantRole: 'owner' });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'upsert',
      tenant_id: TENANT_A,
      recipient_key: 'acct:1',
      recipient_name: 'Pat Contractor',
      tin: SAMPLE_TIN,
    }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.profile.tin_last_4, '6789');
  assert.equal('tin' in result.profile, false);
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
  const insert = client.queries.find((q) => /INSERT INTO public\.recipient_tax_profiles/.test(q.sql));
  assert.ok(insert);
  assert.ok(insert.params.includes(SAMPLE_TIN));
});

test('no dedicated endpoint returns a full TIN even if SQL leaked it', () => {
  const leaked = publicTaxProfile({ ...maskedRow, tin: SAMPLE_TIN, tin_encrypted: Buffer.from(SAMPLE_TIN) });
  assert.equal('tin' in leaked, false);
  assert.equal('tin_encrypted' in leaked, false);
  assert.equal(jsonHasFullTin(leaked, SAMPLE_TIN), false);
  assert.equal(maskTinMetadata(SAMPLE_TIN).tin_last_4, '6789');
  assert.equal(maskTinMetadata(SAMPLE_SSN).tin_type, 'ssn');
});

test('generic /data/query cannot retrieve recipient_tax_profiles or tin', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const table = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'recipient_tax_profiles',
    op: 'select',
    select: 'id, tin, recipient_name',
  }), depsFor(client));
  assert.equal(table.statusCode, 403);
  assert.equal(table.error, 'tax_secret_denied');
  assert.equal(jsonHasFullTin(table, SAMPLE_TIN), false);

  const column = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'profiles',
    op: 'select',
    select: 'id, tin',
  }), depsFor(client));
  assert.equal(column.statusCode, 403);
  assert.equal(column.error, 'tax_secret_denied');

  const embed = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'disbursement_splits',
    op: 'select',
    select: 'id, recipient_tax_profiles(tin, recipient_name)',
  }), depsFor(client));
  assert.equal(embed.statusCode, 403);
  assert.equal(embed.error, 'tax_secret_denied');
});

test('generic /data/write cannot write tax profiles or TIN values', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'recipient_tax_profiles',
    op: 'upsert',
    values: { tenant_id: TENANT_A, recipient_key: 'acct:1', tin: SAMPLE_TIN },
  }), depsFor(client));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'tax_secret_denied');
  assert.equal(result.reason, 'financial_or_provider');
  assert.equal(denyTableReason('recipient_tax_profiles'), 'financial_or_provider');
  assert.equal('recipient_tax_profiles' in WRITE_ALLOWLIST, false);
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
});

test('PDF/CSV output contains no TIN', () => {
  const rows = aggregateRecipientRows({
    year: 2026,
    payments: [{
      settled_at: '2026-03-15T00:00:00Z',
      amount: 600,
      stakeholder_accounts: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        nickname: 'Pat',
        custname: 'Pat Contractor',
        account_type: 'subcontractor',
        chk_acct: '9999',
      },
    }],
  });
  const csv = buildPaymentReportingCsv({
    year: 2026,
    recipients: rows,
    monthlyTotals: rows[0].monthly,
    totalPaid: rows[0].total,
  });
  assert.equal(csvContainsTin(csv, SAMPLE_TIN), false);
  assert.equal(csvContainsTin(csv, SAMPLE_SSN), false);
  assert.match(csv, /Legacy informational \$600 flag/);
  const taxSummary = sourceOf('src/components/ledger/TaxSummary.tsx');
  assert.doesNotMatch(taxSummary, /from\(["']recipient_tax_profiles["']\)/);
  assert.doesNotMatch(taxSummary, /generate1099/);
  assert.doesNotMatch(taxSummary, /pdf-lib/);
  assert.doesNotMatch(taxSummary, /f1099nec/);
  assert.doesNotMatch(taxSummary, /payerEin|\.ein/);
  assert.doesNotMatch(taxSummary, /tin_replace/);
  assert.doesNotMatch(taxSummary, /saveProfile\.mutate\(form\)/);
  assert.match(taxSummary, /taxProfileMutationVariables/);
  assert.match(taxSummary, /tinInputRef/);
  assert.doesNotMatch(taxSummary, /localStorage/);
  assert.doesNotMatch(taxSummary, /sessionStorage/);
  assert.doesNotMatch(taxSummary, /value=\{form\.tin/);
  assert.match(taxSummary, /Secure tax-form generation coming soon/);
  assert.match(taxSummary, /tenant-tax-profiles/);
  assert.match(taxSummary, /data: taxProfiles = \[\]/);
  assert.match(taxSummary, /No TIN on file/);
  assert.match(taxSummary, /taxProfilesIsError/);
  assert.match(taxSummary, /canEditTaxProfile/);
  assert.match(taxSummary, /sanitizeBrowserTaxError/);
  assert.match(taxSummary, /TAX_PROFILES_UNAVAILABLE_HEADING/);
  assert.match(taxSummary, /TAX_PROFILES_UNAVAILABLE_MESSAGE/);
});

test('failed tax-profile list is not treated as no TIN on file', () => {
  const onFile = { tin_on_file: true, tin_last_4: '6789' };
  assert.equal(taxProfileTinStatusLabel(undefined, {}), TAX_PROFILE_STATUS_MISSING);
  assert.equal(taxProfileTinStatusLabel(undefined, { isError: true }), TAX_PROFILE_STATUS_UNAVAILABLE);
  assert.equal(taxProfileTinStatusLabel(onFile, { isError: true }), TAX_PROFILE_STATUS_UNAVAILABLE);
  assert.equal(taxProfileTinStatusLabel(undefined, { isLoading: true }), 'Checking TIN status');
  assert.equal(taxProfileTinStatusLabel(onFile, {}), 'On file ••••6789');
  assert.equal(taxProfileTinStatusLabel({ tin_on_file: true, tin_last_4: null }, {}), 'On file');
  assert.equal(taxProfileEditorEnabled({ tenantId: TENANT_A }), true);
  assert.equal(taxProfileEditorEnabled({ tenantId: TENANT_A, isError: true }), false);
  assert.equal(taxProfileEditorEnabled({ tenantId: TENANT_A, isLoading: true }), false);
  assert.equal(taxProfileEditorEnabled({ tenantId: null }), false);
  assert.match(TAX_PROFILES_UNAVAILABLE_HEADING, /Tax\/1099 recipient profiles unavailable/);
  assert.match(TAX_PROFILES_UNAVAILABLE_MESSAGE, /Do not assume no TIN is on file/);
  const leaked = sanitizeBrowserTaxError(`upsert failed tin=${SAMPLE_TIN} ssn=${SAMPLE_SSN} ${SAMPLE_UNFORMATTED}`);
  assert.equal(leaked.includes(SAMPLE_TIN), false);
  assert.equal(leaked.includes(SAMPLE_SSN), false);
  assert.equal(leaked.includes(SAMPLE_UNFORMATTED), false);
  assert.equal(sanitizeBrowserTaxError(''), 'request_failed');
  const taxSummary = sourceOf('src/components/ledger/TaxSummary.tsx');
  assert.doesNotMatch(taxSummary, /from\(["']recipient_tax_profiles["']\)/);
  const bannerStart = taxSummary.indexOf('taxProfilesIsError &&');
  const banner = taxSummary.slice(bannerStart, bannerStart + 1200);
  assert.match(banner, /TAX_PROFILES_UNAVAILABLE_HEADING/);
  assert.doesNotMatch(banner, /error\.message|e\.message/);
});

test('logs and error responses redact TIN values', () => {
  assert.equal(sanitizeTaxError(`tin: ${SAMPLE_TIN}`).includes(SAMPLE_TIN), false);
  assert.equal(sanitizeTaxError(SAMPLE_SSN).includes('123'), false);
  const logged = sanitizeLogText(`failed tin=${SAMPLE_TIN} ssn ${SAMPLE_SSN}`);
  assert.equal(logged.includes(SAMPLE_TIN), false);
  assert.equal(logged.includes(SAMPLE_SSN), false);
  const err = { ok: false, error: sanitizeTaxError(`duplicate key tin=${SAMPLE_TIN}`) };
  assert.equal(jsonHasFullTin(err, SAMPLE_TIN), false);
});

test('existing non-sensitive YTD calculations still work', () => {
  const rows = aggregateRecipientRows({
    year: 2026,
    payments: [
      {
        settled_at: '2026-01-10T00:00:00Z',
        amount: 400,
        stakeholder_accounts: {
          id: 'acct-1',
          nickname: 'Pat',
          custname: 'Pat Contractor',
          account_type: 'subcontractor',
          chk_acct: '1111',
        },
      },
      {
        settled_at: '2026-06-10T00:00:00Z',
        amount: 250,
        stakeholder_accounts: {
          id: 'acct-1',
          nickname: 'Pat',
          custname: 'Pat Contractor',
          account_type: 'subcontractor',
          chk_acct: '1111',
        },
      },
    ],
    cashPayments: [{
      payment_date: '2026-07-01',
      amount: 50,
      payee_name: 'Cash Pat',
    }],
  });
  const pat = rows.find((r) => r.id === "acct:acct-1");
  const cash = rows.find((r) => r.id.startsWith("cash:"));
  assert.equal(pat.total, 650);
  assert.equal(pat.payment_count, 2);
  assert.equal(pat.needs_1099, true);
  assert.equal(pat.monthly[0], 400);
  assert.equal(pat.monthly[5], 250);
  assert.equal(cash.total, 50);
  assert.equal(LEGACY_INFORMATIONAL_THRESHOLD, 600);
  const under = aggregateRecipientRows({
    year: 2026,
    payments: [{
      settled_at: '2026-02-01T00:00:00Z',
      amount: 599.99,
      stakeholder_accounts: {
        id: 'acct-2',
        nickname: 'Sam',
        custname: 'Sam Vendor',
        account_type: 'vendor',
        chk_acct: '2222',
      },
    }],
  });
  assert.equal(under[0].needs_1099, false);
  assert.equal(under[0].total, 599.99);
});

test('allowlists and Class A registry contain the tax handler and not generic TIN access', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-tax-profiles'), true);
  const allowed = JSON.parse(sourceOf('aws/functions/api/allowed-tables.json'));
  assert.equal(allowed.includes('recipient_tax_profiles'), false);
  const awsClient = sourceOf('src/integrations/aws/client.ts');
  assert.doesNotMatch(awsClient, /"recipient_tax_profiles"/);
  const payments = sourceOf('src/pages/Payments.tsx');
  assert.match(payments, /canAccessTaxUi/);
  assert.match(payments, /Tax reporting \(not IRS filing\)/);
});

test('unapplied containment SQL is transactional, fail-closed, and not on a runner path', () => {
  const sqlRel = 'aws/tax/sql/unapplied-do-not-run/NOT_APPLIED_80_recipient_tax_profiles_containment.sql';
  const downRel = 'aws/tax/sql/unapplied-do-not-run/NOT_APPLIED_80_recipient_tax_profiles_containment.down.sql';
  const sql = sourceOf(sqlRel);
  const down = sourceOf(downRel);
  const readme = sourceOf('aws/tax/sql/README.md');
  const nestReadme = sourceOf('aws/tax/sql/unapplied-do-not-run/README.md');
  assert.match(sql, /NOT SAFE TO APPLY/);
  assert.match(sql, /DESIGN ONLY/);
  assert.match(sql, /DO NOT APPLY/);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.match(sql, /failed closed/i);
  assert.match(sql, /tin_encrypted/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.recipient_tax_profiles/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.recipient_tax_profiles/i);
  assert.doesNotMatch(sql, /SET\s+tin\s*=/i);
  assert.match(down, /NOT SAFE TO APPLY/);
  assert.match(down, /DROP COLUMN IF EXISTS tin_encrypted/);
  assert.doesNotMatch(down, /UPDATE\s+public\.recipient_tax_profiles/i);
  assert.match(down, /aws_can_write_tenant/);
  assert.match(readme, /NOT SAFE TO APPLY/);
  assert.match(nestReadme, /NOT SAFE TO APPLY/);
  assert.equal(sqlRel.includes('supabase/migrations'), false);
  assert.match(path.basename(sqlRel), /^NOT_APPLIED_/);
  assert.equal(fs.existsSync(path.join(ROOT, 'aws/tax/sql/80_recipient_tax_profiles_containment.sql')), false);
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
  assert.equal(migrations.some((name) => name.includes('recipient_tax_profiles_containment')), false);
  assert.equal(migrations.some((name) => name.includes('revoke_postgrest_tax_profiles')), false);
  for (const rel of [
    'aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs',
    'aws/workflows/oneshot/index.mjs',
    'aws/financial/oneshot/index.mjs',
  ]) {
    assert.doesNotMatch(sourceOf(rel), /aws\/tax\/sql/);
  }
});

const assertTaxSecretDenied = (result) => {
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'tax_secret_denied');
  assert.notEqual(result.error, 'data_query_failed');
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
  assert.equal(jsonHasFullTin(result, SAMPLE_UNFORMATTED), false);
};

test('public.recipient_tax_profiles with select * is tax_secret_denied', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'public.recipient_tax_profiles',
    op: 'select',
    select: '*',
  }), depsFor(client));
  assertTaxSecretDenied(result);
});

test('case and whitespace table-name variations are tax_secret_denied, not parser 503', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const variants = [
    'Recipient_Tax_Profiles',
    '  recipient_tax_profiles  ',
    '"recipient_tax_profiles"',
    'PUBLIC.recipient_tax_profiles',
    ' public."Recipient_Tax_Profiles" ',
  ];
  for (const table of variants) {
    const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
      table,
      op: 'select',
      select: 'id, tin',
    }), depsFor(client));
    assert.equal(result.statusCode, 403, table);
    assert.equal(result.error, 'tax_secret_denied', table);
    assert.notEqual(result.statusCode, 503, table);
  }
});

test('alias full_tin:tin is tax_secret_denied', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'recipient_tax_profiles',
    op: 'select',
    select: 'full_tin:tin',
  }), depsFor(client));
  assertTaxSecretDenied(result);

  const otherTable = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'profiles',
    op: 'select',
    select: 'id, full_tin:tin',
  }), depsFor(client));
  assertTaxSecretDenied(otherTable);
});

test('schema-qualified generic write is tax_secret_denied', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'public.recipient_tax_profiles',
    op: 'upsert',
    values: { tenant_id: TENANT_A, recipient_key: 'acct:1', tin: SAMPLE_TIN },
  }), depsFor(client));
  assertTaxSecretDenied(result);
  assert.equal(result.reason, 'financial_or_provider');
});

test('omitted tenant_id is tenant_id_required', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list' }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'tenant_id_required');
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
});

test('spoofed x-tenant-id conflicting with body tenant_id is ignored', async () => {
  const client = mockTaxClient({ tenantRole: 'admin', membershipTenantId: TENANT_A });
  const allowed = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'list',
      tenant_id: TENANT_A,
    }, { 'x-tenant-id': TENANT_B, 'x-user-id': 'spoofed-user' }),
    depsFor(client),
  );
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.spoofFieldsIgnored.headerTenantId, TENANT_B);
  assert.equal(allowed.spoofFieldsIgnored.bodyTenantId, TENANT_A);

  const denied = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'upsert',
      tenant_id: TENANT_B,
      recipient_key: 'acct:1',
      tin: SAMPLE_TIN,
    }, { 'x-tenant-id': TENANT_A }),
    depsFor(client),
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.code, 'not_authorized');
  assert.equal(jsonHasFullTin(denied, SAMPLE_TIN), false);
});

test('member and operator upsert is denied', async () => {
  for (const role of ['member', 'operator']) {
    const client = mockTaxClient({ tenantRole: role });
    const result = await handleTaxProfiles(
      jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
        action: 'upsert',
        tenant_id: TENANT_A,
        recipient_key: 'acct:1',
        tin: SAMPLE_TIN,
      }),
      depsFor(client),
    );
    assert.equal(result.statusCode, 403, role);
    assert.equal(result.code, 'not_authorized', role);
    assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
    const insert = client.queries.find((q) => /INSERT INTO public\.recipient_tax_profiles/.test(q.sql));
    assert.equal(insert, undefined, role);
  }
});

test('cross-tenant list and upsert are denied', async () => {
  const client = mockTaxClient({ tenantRole: 'admin', membershipTenantId: TENANT_B });
  const list = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', { action: 'list', tenant_id: TENANT_A }),
    depsFor(client),
  );
  assert.equal(list.statusCode, 403);
  assert.equal(list.code, 'not_authorized');

  const upsert = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'upsert',
      tenant_id: TENANT_A,
      recipient_key: 'acct:1',
      tin: SAMPLE_TIN,
    }),
    depsFor(client),
  );
  assert.equal(upsert.statusCode, 403);
  assert.equal(upsert.code, 'not_authorized');
  assert.equal(jsonHasFullTin(upsert, SAMPLE_TIN), false);
});

test('unformatted nine-digit values are redacted from logs', () => {
  const logged = sanitizeLogText(`failed lookup ${SAMPLE_UNFORMATTED} tin=${SAMPLE_TIN}`);
  assert.equal(logged.includes(SAMPLE_UNFORMATTED), false);
  assert.equal(logged.includes(SAMPLE_TIN), false);
  assert.match(logged, /\[redacted\]/);

  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    logDataQueryFailure(
      new Error(`duplicate key DETAIL: Key (tin)=(${SAMPLE_UNFORMATTED}) already exists.`),
      {
        table: 'recipient_tax_profiles',
        select: '*',
        tin: SAMPLE_TIN,
        values: { tin: SAMPLE_UNFORMATTED },
      },
    );
  } finally {
    console.error = original;
  }
  const blob = logs.join('\n');
  assert.equal(blob.includes(SAMPLE_UNFORMATTED), false);
  assert.equal(blob.includes(SAMPLE_TIN), false);
  assert.equal(blob.includes('"tin":'), false);
  const payload = JSON.parse(logs[0]);
  assert.equal(payload.errorClass, 'data_query_failed');
  assert.equal(payload.table, 'recipient_tax_profiles');
  assert.equal(payload.status, 503);
});

test('database errors do not log request body, TIN, SQL params, or PG detail', async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  const client = mockTaxClient({ tenantRole: 'admin' });
  const origQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    if (/INSERT INTO public\.recipient_tax_profiles/.test(sql)) {
      const err = new Error(`duplicate key value violates unique constraint DETAIL: Key (tin)=(${SAMPLE_UNFORMATTED})`);
      err.code = '23505';
      err.detail = `Key (tin)=(${SAMPLE_UNFORMATTED}) already exists.`;
      err.hint = `submitted tin=${SAMPLE_TIN}`;
      err.where = `SQL parameter $4=${SAMPLE_TIN}`;
      throw err;
    }
    return origQuery(sql, params);
  };
  try {
    const result = await handleTaxProfiles(
      jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
        action: 'upsert',
        tenant_id: TENANT_A,
        recipient_key: 'acct:1',
        tin: SAMPLE_TIN,
      }),
      depsFor(client),
    );
    assert.equal(result.statusCode, 503);
    assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
    assert.equal(jsonHasFullTin(result, SAMPLE_UNFORMATTED), false);
    const blob = logs.join('\n');
    assert.equal(blob.includes(SAMPLE_TIN), false);
    assert.equal(blob.includes(SAMPLE_UNFORMATTED), false);
    assert.equal(blob.includes('Key (tin)='), false);
    assert.doesNotMatch(blob, /"values"/);
  } finally {
    console.error = original;
  }
});

test('extra fields and tin_encrypted mass-assignment are ignored', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const result = await handleTaxProfiles(
    jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'upsert',
      tenant_id: TENANT_A,
      recipient_key: 'acct:1',
      recipient_name: 'Pat Contractor',
      tin: SAMPLE_TIN,
      tin_encrypted: 'SHOULD_NOT_BE_WRITTEN',
      role: 'owner',
      extra_field: 'nope',
    }),
    depsFor(client),
  );
  assert.equal(result.statusCode, 200);
  assert.equal('tin' in result.profile, false);
  assert.equal('tin_encrypted' in result.profile, false);
  assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
  const insert = client.queries.find((q) => /INSERT INTO public\.recipient_tax_profiles/.test(q.sql));
  assert.ok(insert);
  assert.equal(insert.sql.includes('tin_encrypted'), false);
  assert.equal(insert.sql.includes('extra_field'), false);
  assert.equal(insert.params.includes('SHOULD_NOT_BE_WRITTEN'), false);
  assert.equal(insert.params.includes('owner'), false);
  assert.equal(insert.params.includes('nope'), false);
  assert.ok(insert.params.includes(SAMPLE_TIN));
});

test('RPC denylist blocks tax-secret workarounds', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const names = [
    'get_recipient_tin',
    'upsert_recipient_tax_profile',
    'recipient_tax_profiles',
    'Get_Recipient_Tin',
  ];
  for (const name of names) {
    const result = await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
      name,
      args: { tenant_id: TENANT_A },
    }), depsFor(client));
    assert.equal(result.statusCode, 403, name);
    assert.equal(result.error, 'tax_secret_denied', name);
    assert.notEqual(result.error, 'rpc_disabled', name);
  }
  const args = await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'get_check_dashboard_counts_for_tenant',
    args: { tin: SAMPLE_TIN },
  }), depsFor(client));
  assert.equal(args.statusCode, 403);
  assert.equal(args.error, 'tax_secret_denied');
  assert.equal(denyTaxSecretRpc('list_recipient_tax_profiles').denied, true);
});

test('no TIN in TanStack mutation or query cache variables', () => {
  const vars = taxProfileMutationVariables({
    recipient_key: 'acct:1',
    recipient_name: 'Pat',
    address_street: '1 Main',
    address_city: 'Austin',
    address_state: 'TX',
    address_zip: '78701',
    account_number: '',
    notes: '',
  });
  assert.equal(taxProfileMutationHasTin(vars), false);
  assert.equal('tin' in vars, false);
  assert.equal('tin_replace' in vars, false);
  const helperSrc = sourceOf('src/lib/taxProfileMutation.ts');
  assert.match(helperSrc, /must never appear in mutation variables/);
  assert.match(helperSrc, /not zero browser presence/);
  const taxSummary = sourceOf('src/components/ledger/TaxSummary.tsx');
  assert.match(taxSummary, /pendingTinRef/);
  assert.match(taxSummary, /mutate\(taxProfileMutationVariables\(form\)\)/);
});

test('no TIN in CSV, PDF, logs, errors, or network responses', async () => {
  const client = mockTaxClient({ tenantRole: 'admin' });
  const responses = [
    await handleTaxProfiles(jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'list', tenant_id: TENANT_A,
    }), depsFor(client)),
    await handleTaxProfiles(jwtEvent('/functions/v1/tenant-tax-profiles', 'POST', {
      action: 'upsert', tenant_id: TENANT_A, recipient_key: 'acct:1', tin: SAMPLE_SSN,
    }), depsFor(client)),
    await handleDataQuery(jwtEvent('/data/query', 'POST', {
      table: 'recipient_tax_profiles', select: '*',
    }), depsFor(client)),
    await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'recipient_tax_profiles', op: 'insert', values: { tin: SAMPLE_UNFORMATTED },
    }), depsFor(client)),
    await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
      name: 'get_recipient_tin', args: { tin: SAMPLE_TIN },
    }), depsFor(client)),
  ];
  for (const result of responses) {
    assert.equal(jsonHasFullTin(result, SAMPLE_TIN), false);
    assert.equal(jsonHasFullTin(result, SAMPLE_SSN), false);
    assert.equal(jsonHasFullTin(result, SAMPLE_UNFORMATTED), false);
  }
  const csv = buildPaymentReportingCsv({
    year: 2026,
    recipients: aggregateRecipientRows({
      year: 2026,
      payments: [{
        settled_at: '2026-03-15T00:00:00Z',
        amount: 600,
        stakeholder_accounts: {
          id: 'acct-csv',
          nickname: 'Pat',
          custname: 'Pat Contractor',
          account_type: 'subcontractor',
          chk_acct: '9999',
        },
      }],
    }),
    monthlyTotals: Array(12).fill(0),
    totalPaid: 600,
  });
  assert.equal(csvContainsTin(csv, SAMPLE_TIN), false);
  assert.equal(csvContainsTin(csv, SAMPLE_UNFORMATTED), false);
  const taxSummary = sourceOf('src/components/ledger/TaxSummary.tsx');
  assert.doesNotMatch(taxSummary, /pdf-lib|generate1099|f1099nec/);
  const unusedPdf = sourceOf('src/assets/f1099nec.pdf.asset.json');
  assert.ok(unusedPdf.length >= 0);
  assert.doesNotMatch(sourceOf('src/pages/Payments.tsx'), /f1099nec/);
});

test('protection remains if the tax table is hypothetically re-allowlisted', () => {
  const allowed = JSON.parse(sourceOf('aws/functions/api/allowed-tables.json'));
  const hypothetical = new Set([...allowed, 'recipient_tax_profiles']);
  assert.equal(hypothetical.has('recipient_tax_profiles'), true);
  assert.equal(isTaxSecretTable('recipient_tax_profiles'), true);
  assert.equal(normalizeSqlName('public."Recipient_Tax_Profiles"'), 'recipient_tax_profiles');
  assert.equal(denyTaxSecretQuery('recipient_tax_profiles', { columns: ['*'], embeds: [] }, '*').denied, true);
  assert.equal(denyTaxSecretQuery('public.recipient_tax_profiles', null, '*').denied, true);
  assert.equal(denyTaxSecretWrite('recipient_tax_profiles', { values: { tin: SAMPLE_TIN } }).denied, true);
  const dataSrc = sourceOf('aws/functions/api/data.mjs');
  const handleStart = dataSrc.indexOf('export const handleDataQuery');
  const denyIdx = dataSrc.indexOf('denyTaxSecretQuery(rawTable', handleStart);
  const runIdx = dataSrc.indexOf('runSelect(client, body)', handleStart);
  assert.ok(handleStart > 0 && denyIdx > handleStart && runIdx > denyIdx);
  const writeSrc = sourceOf('aws/functions/api/write.mjs');
  const writeDenyIdx = writeSrc.indexOf('denyTaxSecretWrite(body.table');
  const identIdx = writeSrc.indexOf("ident(body.table, 'table')");
  assert.ok(writeDenyIdx > 0 && identIdx > writeDenyIdx);
});
