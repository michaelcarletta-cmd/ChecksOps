/**
 * Signature Request write-txn compatibility for email-branding.mjs.
 * Ported from the Cursor SR repair (24d83b4ab) and reconciled with main:
 * main still reads the optional SES metadata columns when they exist, but a
 * missing column (NOT_APPLIED SES migration) must not abort the caller's
 * create/send write transaction. Savepoints give both behaviours.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveEmailBranding } from '../functions/api/email-branding.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOT_APPLIED = path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260910_tenant_email_ses_domain.sql');

const UNAPPLIED_SES_COLUMNS = ['ses_identity_name', 'custom_sending_enabled'];
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/** Postgres-like write transaction: an error aborts it until ROLLBACK TO SAVEPOINT. */
const createWriteTxn = ({ missingColumns = new Set(), inTransaction = true, settingsRow = null } = {}) => {
  let aborted = false;
  const savepoints = [];
  const queries = [];
  return {
    queries,
    get aborted() { return aborted; },
    query: async (sql, params = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      queries.push(text);
      const sp = text.match(/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) (\w+)$/);
      if (sp) {
        if (!inTransaction) {
          const error = new Error('SAVEPOINT can only be used in transaction blocks');
          error.code = '25P01';
          throw error;
        }
        if (sp[1] === 'ROLLBACK TO SAVEPOINT') {
          assert.ok(savepoints.includes(sp[2]), `unknown savepoint ${sp[2]}`);
          aborted = false;
          return { rows: [] };
        }
        if (aborted) {
          const error = new Error('current transaction is aborted, commands ignored until end of transaction block');
          error.code = '25P02';
          throw error;
        }
        if (sp[1] === 'SAVEPOINT') savepoints.push(sp[2]);
        else savepoints.splice(savepoints.lastIndexOf(sp[2]), 1);
        return { rows: [] };
      }
      if (aborted) {
        const error = new Error('current transaction is aborted, commands ignored until end of transaction block');
        error.code = '25P02';
        throw error;
      }
      for (const column of missingColumns) {
        if (new RegExp(`\\b${column}\\b`).test(text)) {
          if (inTransaction) aborted = true;
          const error = new Error(`column "${column}" does not exist`);
          error.code = '42703';
          throw error;
        }
      }
      if (/INSERT INTO public\.signature_requests/i.test(text)) return { rowCount: 1, rows: [{ id: 'sr-1' }] };
      if (/UPDATE public\.signature_signers/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.tenants/i.test(text)) {
        return { rows: [{ id: TENANT_ID, name: 'Acme', is_system_tenant: false }] };
      }
      if (/FROM public\.tenant_email_settings/i.test(text)) {
        return { rows: [settingsRow || {
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

const UPDATE_SIGNER = 'UPDATE public.signature_signers SET access_token = $2, token_hash = $3, expires_at = $4::timestamptz WHERE id = $1::uuid';

test('unapplied SES columns no longer poison a Signature Request write transaction', async () => {
  const txn = createWriteTxn({ missingColumns: new Set(UNAPPLIED_SES_COLUMNS) });
  await txn.query('INSERT INTO public.signature_requests (id) VALUES ($1)', ['sr-1']);
  const branding = await resolveEmailBranding(txn, { tenantId: TENANT_ID });
  const updated = await txn.query(UPDATE_SIGNER, ['signer-1', 'raw', 'hash', new Date().toISOString()]);
  assert.equal(txn.aborted, false);
  assert.equal(updated.rowCount, 1);
  assert.equal(branding.usingCustomFrom, false);
  assert.ok(txn.queries.some((sql) => sql === 'ROLLBACK TO SAVEPOINT email_branding_settings'));
  const deployed = txn.queries.filter((sql) => sql.includes('tenant_email_settings'));
  assert.equal(deployed.length, 2, 'SES-aware read, then the deployed-column fallback');
  for (const column of UNAPPLIED_SES_COLUMNS) {
    assert.doesNotMatch(deployed[1], new RegExp(`\\b${column}\\b`));
  }
});

test('without savepoints the same missing column aborts the transaction (regression proof)', async () => {
  const poisoned = createWriteTxn({ missingColumns: new Set(UNAPPLIED_SES_COLUMNS) });
  await assert.rejects(
    () => poisoned.query(
      'SELECT from_name, ses_identity_name, custom_sending_enabled FROM public.tenant_email_settings WHERE tenant_id = $1::uuid',
      [TENANT_ID],
    ),
    (error) => error.code === '42703',
  );
  await assert.rejects(
    () => poisoned.query(UPDATE_SIGNER, ['signer-1', 'raw', 'hash', new Date().toISOString()]),
    (error) => error.code === '25P02',
  );
});

test('main SES metadata is still honoured when the columns exist', async () => {
  const txn = createWriteTxn({
    settingsRow: {
      from_name: 'Acme Claims',
      reply_to: 'office@acme.test',
      sending_mode: 'custom',
      sending_domain: 'acme.test',
      from_address: 'claims@acme.test',
      domain_status: 'verified',
      ses_identity_name: 'other.test',
      custom_sending_enabled: true,
    },
  });
  const branding = await resolveEmailBranding(txn, { tenantId: TENANT_ID });
  const reads = txn.queries.filter((sql) => sql.includes('tenant_email_settings'));
  assert.equal(reads.length, 1);
  assert.match(reads[0], /ses_identity_name/);
  assert.equal(branding.usingCustomFrom, false, 'SES identity mismatch must still block custom From');
  assert.equal(txn.aborted, false);
});

test('outside a transaction the branding reads run directly', async () => {
  const client = createWriteTxn({ missingColumns: new Set(UNAPPLIED_SES_COLUMNS), inTransaction: false });
  const branding = await resolveEmailBranding(client, { tenantId: TENANT_ID });
  assert.equal(branding.usingCustomFrom, false);
  assert.equal(client.queries.filter((sql) => sql.includes('tenant_email_settings')).length, 2);
});

test('this repair does not apply the SES domain migration', () => {
  const sql = fs.readFileSync(NOT_APPLIED, 'utf8');
  assert.match(sql, /NOT APPLIED/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS ses_identity_name/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS custom_sending_enabled/);
});
