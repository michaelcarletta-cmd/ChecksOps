/**
 * Signature Request write-txn compatibility for live email-branding.mjs.
 * Optional / unapplied SES columns must not abort the create/send transaction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveEmailBranding } from '../functions/api/email-branding.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRANDING = path.join(ROOT, 'aws/functions/api/email-branding.mjs');
const ESIGN = path.join(ROOT, 'aws/functions/api/esign.mjs');
const SUBMIT = path.join(ROOT, 'aws/functions/api/signature-submit.mjs');
const NOT_APPLIED = path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260910_tenant_email_ses_domain.sql');

const DEPLOYED_TES_COLUMNS = [
  'from_name',
  'reply_to',
  'sending_mode',
  'sending_domain',
  'from_address',
  'domain_status',
];
const UNAPPLIED_SES_COLUMNS = ['ses_identity_name', 'custom_sending_enabled'];
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const POISONING_TES_SQL = `SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status,
                ses_identity_name, custom_sending_enabled
         FROM public.tenant_email_settings WHERE tenant_id = $1::uuid LIMIT 1`;

const createWriteTxn = ({ missingColumns = new Set() } = {}) => {
  let aborted = false;
  const queries = [];
  return {
    queries,
    get aborted() { return aborted; },
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push(text);
      if (aborted) {
        const error = new Error('current transaction is aborted, commands ignored until end of transaction block');
        error.code = '25P02';
        throw error;
      }
      for (const column of missingColumns) {
        if (new RegExp(`\\b${column}\\b`).test(text)) {
          aborted = true;
          const error = new Error(`column "${column}" does not exist`);
          error.code = '42703';
          throw error;
        }
      }
      if (/INSERT INTO public\.signature_requests/i.test(text)) {
        return { rowCount: 1, rows: [{ id: 'sr-1' }] };
      }
      if (/UPDATE public\.signature_signers/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      if (/FROM public\.tenants/i.test(text)) {
        return { rows: [{ id: TENANT_ID, name: 'Acme', is_system_tenant: false }] };
      }
      if (/FROM public\.tenant_email_settings/i.test(text)) {
        return { rows: [{
          from_name: 'Acme Claims',
          reply_to: 'office@acme.test',
          sending_mode: 'platform',
          sending_domain: null,
          from_address: null,
          domain_status: 'unverified',
        }] };
      }
      return { rows: [], rowCount: 0, params };
    },
  };
};

const tesSelectFrom = (queries) => queries.find((sql) => sql.includes('tenant_email_settings'));

test('resolveEmailBranding selects only the deployed tenant_email_settings columns', async () => {
  const src = fs.readFileSync(BRANDING, 'utf8');
  assert.match(src, /resolveEmailTenantLogoUrl/);
  assert.match(src, /SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status\n\s+FROM public\.tenant_email_settings/);
  assert.doesNotMatch(src, /SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status,\s*\n\s*ses_identity_name, custom_sending_enabled/);

  const client = createWriteTxn({ missingColumns: new Set(UNAPPLIED_SES_COLUMNS) });
  const branding = await resolveEmailBranding(client, { tenantId: TENANT_ID });
  const tes = tesSelectFrom(client.queries);
  assert.ok(tes, 'expected a tenant_email_settings SELECT');
  for (const column of DEPLOYED_TES_COLUMNS) {
    assert.match(tes, new RegExp(`\\b${column}\\b`));
  }
  for (const column of UNAPPLIED_SES_COLUMNS) {
    assert.doesNotMatch(tes, new RegExp(`\\b${column}\\b`));
  }
  assert.equal(client.aborted, false);
  assert.equal(branding.usingCustomFrom, false);
  assert.match(branding.logoUrl, /checksops-logo\.png|\/prep\/branding\/logo\//);
});

test('unapplied SES columns poison an SR write txn; deployed-column branding does not', async () => {
  const missing = new Set(UNAPPLIED_SES_COLUMNS);

  const poisoned = createWriteTxn({ missingColumns: missing });
  await poisoned.query(`INSERT INTO public.signature_requests (id) VALUES ($1)`, ['sr-1']);
  await assert.rejects(
    () => poisoned.query(POISONING_TES_SQL, [TENANT_ID]),
    (error) => error.code === '42703' && /ses_identity_name/.test(error.message),
  );
  await assert.rejects(
    () => poisoned.query(
      `UPDATE public.signature_signers SET access_token = $2, token_hash = $3, expires_at = $4::timestamptz WHERE id = $1::uuid`,
      ['signer-1', 'raw', 'hash', new Date().toISOString()],
    ),
    (error) => error.code === '25P02' && /transaction is aborted/.test(error.message),
  );
  assert.equal(poisoned.aborted, true);

  const safe = createWriteTxn({ missingColumns: missing });
  await safe.query(`INSERT INTO public.signature_requests (id) VALUES ($1)`, ['sr-1']);
  const branding = await resolveEmailBranding(safe, { tenantId: TENANT_ID });
  const updated = await safe.query(
    `UPDATE public.signature_signers SET access_token = $2, token_hash = $3, expires_at = $4::timestamptz WHERE id = $1::uuid`,
    ['signer-1', 'raw', 'hash', new Date().toISOString()],
  );
  assert.equal(safe.aborted, false);
  assert.equal(updated.rowCount, 1);
  assert.equal(branding.usingCustomFrom, false);
  assert.equal(
    tesSelectFrom(safe.queries).includes('ses_identity_name'),
    false,
  );
});

test('this repair does not apply the SES domain migration or change esign/signature-submit', () => {
  const sql = fs.readFileSync(NOT_APPLIED, 'utf8');
  assert.match(sql, /NOT APPLIED/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS ses_identity_name/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS custom_sending_enabled/);
  assert.equal(fs.existsSync(ESIGN), true);
  assert.equal(fs.existsSync(SUBMIT), true);
  const branding = fs.readFileSync(BRANDING, 'utf8');
  assert.doesNotMatch(branding, /SAVEPOINT/);
});
