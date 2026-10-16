import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTenantDocumentBranding } from '../functions/api/email-branding.mjs';
import { replaceMergeFields } from '../functions/api/esign.mjs';
import { isPublicBrandingPath } from '../functions/api/storage.mjs';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { executeTenantsNarrow } from '../functions/api/write-app-metadata.mjs';
import { pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SYSTEM_TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-2222-4333-8444-555555555555';

const PLATFORM_ROW = {
  company_name: 'ChecksOps',
  company_address: '1 Platform Way',
  company_phone: '800-555-0000',
  company_email: 'platform@checksops.test',
  letterhead_url: 'letterhead_1700000000000.png',
};

const tenantRows = {
  [TENANT_A]: {
    is_system_tenant: false,
    company_address: '9 Tenant Rd',
    company_phone: '215-555-0101',
    company_email: 'office@tenant-a.test',
    letterhead_url: `${TENANT_A}/letterhead-1790000000000.png`,
  },
  [TENANT_B]: {
    is_system_tenant: false,
    company_address: null,
    company_phone: '',
    company_email: null,
    letterhead_url: null,
  },
  [SYSTEM_TENANT]: {
    is_system_tenant: true,
    company_address: null,
    company_phone: '800-555-9999',
    company_email: null,
    letterhead_url: null,
  },
};

const docClient = ({ missingColumns = false } = {}) => ({
  query: async (sql, params = []) => {
    const text = String(sql);
    if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(text)) return { rows: [] };
    if (text.includes('FROM public.tenants')) {
      if (missingColumns && text.includes('company_address')) {
        throw new Error('column "company_address" does not exist');
      }
      const row = tenantRows[params[0]];
      if (!row) return { rows: [] };
      return { rows: [missingColumns ? { is_system_tenant: row.is_system_tenant } : row] };
    }
    return { rows: [] };
  },
});

test('tenant documents use the tenant\'s own company info and letterhead', async () => {
  const branding = await resolveTenantDocumentBranding(docClient(), { tenantId: TENANT_A, platformRow: PLATFORM_ROW });
  assert.deepEqual(branding, {
    company_address: '9 Tenant Rd',
    company_phone: '215-555-0101',
    company_email: 'office@tenant-a.test',
    letterhead_url: `${TENANT_A}/letterhead-1790000000000.png`,
    source: 'tenant',
  });
});

test('a tenant without its own values never inherits the platform company_branding', async () => {
  const branding = await resolveTenantDocumentBranding(docClient(), { tenantId: TENANT_B, platformRow: PLATFORM_ROW });
  assert.deepEqual(branding, {
    company_address: null,
    company_phone: null,
    company_email: null,
    letterhead_url: null,
    source: 'tenant',
  });
  // Unknown tenant: still no platform leakage.
  const unknown = await resolveTenantDocumentBranding(docClient(), {
    tenantId: '99999999-9999-4999-8999-999999999999',
    platformRow: PLATFORM_ROW,
  });
  assert.equal(unknown.source, 'tenant');
  assert.equal(unknown.company_phone, null);
});

test('platform\'s own documents fall back to company_branding', async () => {
  const noTenant = await resolveTenantDocumentBranding(docClient(), { tenantId: null, platformRow: PLATFORM_ROW });
  assert.deepEqual(noTenant, {
    company_address: '1 Platform Way',
    company_phone: '800-555-0000',
    company_email: 'platform@checksops.test',
    letterhead_url: 'letterhead_1700000000000.png',
    source: 'platform',
  });
  // System tenant: its own value wins, the rest falls back to the platform row.
  const system = await resolveTenantDocumentBranding(docClient(), { tenantId: SYSTEM_TENANT, platformRow: PLATFORM_ROW });
  assert.equal(system.source, 'platform');
  assert.equal(system.company_phone, '800-555-9999');
  assert.equal(system.company_address, '1 Platform Way');
  assert.equal(system.letterhead_url, 'letterhead_1700000000000.png');
});

test('missing SQL 93 columns read as unset and never throw', async () => {
  const tenant = await resolveTenantDocumentBranding(docClient({ missingColumns: true }), {
    tenantId: TENANT_A,
    platformRow: PLATFORM_ROW,
  });
  assert.equal(tenant.source, 'tenant');
  assert.equal(tenant.company_phone, null);
  const system = await resolveTenantDocumentBranding(docClient({ missingColumns: true }), {
    tenantId: SYSTEM_TENANT,
    platformRow: PLATFORM_ROW,
  });
  assert.equal(system.source, 'platform');
  assert.equal(system.company_phone, '800-555-0000');
  await assert.doesNotReject(() => resolveTenantDocumentBranding({ query: async () => { throw new Error('down'); } }, {
    tenantId: TENANT_A,
    platformRow: PLATFORM_ROW,
  }));
});

test('esign merge fields render the tenant\'s own company phone/email', async () => {
  const src = read('aws/functions/api/esign.mjs');
  assert.match(src, /resolveTenantDocumentBranding\(client, \{ tenantId, platformRow: brandingRow \}\)/);
  assert.match(src, /branding\.company_phone = documentBranding\.company_phone;/);

  const doc = await resolveTenantDocumentBranding(docClient(), { tenantId: TENANT_A, platformRow: PLATFORM_ROW });
  const text = replaceMergeFields('{company.phone} {company.email}', {}, {}, 'https://sign', {
    company_phone: doc.company_phone,
    company_email: doc.company_email,
  });
  assert.equal(text, '215-555-0101 office@tenant-a.test');
  assert.doesNotMatch(text, /800-555-0000|platform@checksops/);
});

const storageClient = ({ letterheadRows = [], logoRows = [], throwLetterhead = false } = {}) => ({
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM tenants_public')) return { rows: logoRows };
    if (text.includes('letterhead_url FROM public.tenants')) {
      if (throwLetterhead) throw new Error('column "letterhead_url" does not exist');
      const wanted = String(params[0] || '').split('/')[0].toLowerCase();
      return { rows: letterheadRows.filter((row) => row.id === wanted) };
    }
    return { rows: [] };
  },
});

test('a tenant letterhead is public only from that tenant\'s own folder', async () => {
  const own = `${TENANT_A}/letterhead-1790000000000.png`;
  const rows = [{ id: TENANT_A, letterhead_url: own }];
  assert.equal(await isPublicBrandingPath(storageClient({ letterheadRows: rows }), 'tenant-logos', own), true);
  // Not the stored letterhead.
  assert.equal(
    await isPublicBrandingPath(storageClient({ letterheadRows: rows }), 'tenant-logos', `${TENANT_A}/other.png`),
    false,
  );
  // Tenant B pointing letterhead_url at tenant A's folder does not publish it.
  assert.equal(
    await isPublicBrandingPath(storageClient({ letterheadRows: [{ id: TENANT_B, letterhead_url: own }] }), 'tenant-logos', own),
    false,
  );
  // Before SQL 93: column missing reads as not public, logo lookups unaffected.
  assert.equal(await isPublicBrandingPath(storageClient({ throwLetterhead: true }), 'tenant-logos', own), false);
  const logo = `${TENANT_A}/logo-1.png`;
  assert.equal(
    await isPublicBrandingPath(storageClient({ throwLetterhead: true, logoRows: [{ logo_url: logo }] }), 'tenant-logos', logo),
    true,
  );
});

const writeAuthClient = ({ memberOf = [] } = {}) => ({
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid')) {
      return { rows: memberOf.includes(params[1]) ? [{ '?column?': 1 }] : [] };
    }
    if (text.includes('is_platform_owner')) return { rows: [{ is_platform: false, is_master: false }] };
    return { rows: [] };
  },
});

test('letterhead upload path uses the tenant-logos {tenantId}/ scope and member check', async () => {
  const pathA = `${TENANT_A}/letterhead-1790000000000.png`;
  const allowed = await authorizeStorageWritePath(writeAuthClient({ memberOf: [TENANT_A] }), 'tenant-logos', pathA, USER);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.tenantId, TENANT_A);

  const otherTenant = await authorizeStorageWritePath(writeAuthClient({ memberOf: [TENANT_B] }), 'tenant-logos', pathA, USER);
  assert.equal(otherTenant.ok, false);
  assert.equal(otherTenant.error, 'rls_denied');

  const unscoped = await authorizeStorageWritePath(writeAuthClient({ memberOf: [TENANT_A] }), 'tenant-logos', 'letterhead-1.png', USER);
  assert.equal(unscoped.ok, false);
  assert.equal(unscoped.error, 'path_not_allowlisted');
});

test('tenants write accepts company info for members of that tenant only', async () => {
  const picked = pickAllowlistedValues('tenants', {
    company_address: '9 Tenant Rd',
    company_phone: '215-555-0101',
    company_email: 'office@tenant-a.test',
    letterhead_url: `${TENANT_A}/letterhead-1.png`,
  });
  assert.equal(picked.error, undefined);

  const updates = [];
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('tenant_users')) {
        return { rows: params.includes(TENANT_A) ? [{ ok: 1 }] : [] };
      }
      if (text.startsWith('UPDATE public.tenants')) {
        updates.push({ text, params });
        return { rows: [{ id: params.at(-1) }] };
      }
      return { rows: [] };
    },
  };
  const mapping = { application_user_id: USER };
  const ok = await executeTenantsNarrow({
    client, mapping, op: 'update', values: picked.values, filters: [{ column: 'id', op: 'eq', value: TENANT_A }],
  });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(updates.length, 1);
  for (const col of ['company_address', 'company_phone', 'company_email', 'letterhead_url']) {
    assert.match(updates[0].text, new RegExp(`${col} = \\$`));
  }
  assert.equal(updates[0].params.at(-1), TENANT_A);

  const denied = await executeTenantsNarrow({
    client, mapping, op: 'update', values: picked.values, filters: [{ column: 'id', op: 'eq', value: TENANT_B }],
  });
  assert.equal(denied.error, 'not_authorized');
  assert.equal(updates.length, 1);
});

test('SQL 93 adds nullable tenant columns idempotently with a member-only update policy', () => {
  const sql = read('aws/workflows/sql/93_tenant_company_info.sql');
  for (const col of ['company_address', 'company_phone', 'company_email', 'letterhead_url']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.tenants ADD COLUMN IF NOT EXISTS ${col} TEXT;`));
  }
  assert.doesNotMatch(sql, /NOT NULL|DEFAULT/);
  assert.match(sql, /DROP POLICY IF EXISTS aws_member_update_tenant_branding ON public\.tenants;/);
  assert.match(sql, /FOR UPDATE TO authenticated/);
  assert.equal((sql.match(/id IN \(SELECT public\.aws_user_tenant_ids\(\)\)/g) || []).length, 2);
  assert.doesNotMatch(sql, /has_role|aws_can_write_tenant\(id\)|admin'::|staff'::/);
  assert.doesNotMatch(sql, /company_branding\s+(SET|ADD)|ALTER TABLE public\.company_branding/);
});
