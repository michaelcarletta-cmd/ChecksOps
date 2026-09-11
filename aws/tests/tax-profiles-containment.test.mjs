import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleDataQuery, sanitizeLogText } from '../functions/api/data.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { handleTaxProfiles } from '../functions/api/tax-profiles.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { denyTableReason, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import {
  evaluateTaxAccess,
  jsonHasFullTin,
  maskTinMetadata,
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';
const SAMPLE_TIN = '12-3456789';
const SAMPLE_SSN = '123-45-6789';

const jwtEvent = (pathName, method, body) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
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
  assert.match(taxSummary, /Secure tax-form generation coming soon/);
  assert.match(taxSummary, /tenant-tax-profiles/);
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
  const pat = rows.find((r) => r.id === 'acct-1');
  const cash = rows.find((r) => r.id.startsWith('cash:'));
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

test('unapplied containment SQL is transactional, fail-closed, and does not rewrite tin', () => {
  const sql = sourceOf('aws/tax/sql/80_recipient_tax_profiles_containment.sql');
  const down = sourceOf('aws/tax/sql/80_recipient_tax_profiles_containment.down.sql');
  const readme = sourceOf('aws/tax/sql/README.md');
  assert.match(sql, /DO NOT APPLY/);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.match(sql, /failed closed/i);
  assert.match(sql, /tin_encrypted/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.recipient_tax_profiles/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.recipient_tax_profiles/i);
  assert.doesNotMatch(sql, /SET\s+tin\s*=/i);
  assert.match(down, /DROP COLUMN IF EXISTS tin_encrypted/);
  assert.doesNotMatch(down, /UPDATE\s+public\.recipient_tax_profiles/i);
  assert.match(readme, /DO NOT APPLY/);
});
