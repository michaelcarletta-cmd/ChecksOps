import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { homeownerUploadTokenFromEvent } from '../functions/api/homeowner-otp.mjs';
import { handleHomeownerLedgerUpload, shapeHomeownerLedgerView } from '../functions/api/homeowner.mjs';
import { runSendSignatureRequest } from '../functions/api/esign.mjs';
import { shapeHomeownerLedgerSummary } from '../../src/lib/homeownerLedgerSummary.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('e-sign send does not null signature_signers.access_token', () => {
  const src = sourceOf('functions/api/esign.mjs');
  assert.doesNotMatch(src, /access_token = NULL/);
  assert.match(src, /SET access_token = \$2, token_hash = \$3/);
  assert.match(src, /SET delivery_status = 'sent'/);
});

test('homeowner tracking links use /ledger/:token and alias /h/ledger', () => {
  const api = sourceOf('functions/api/homeowner.mjs');
  const app = sourceOf('../src/App.tsx');
  assert.match(api, /\$\{origin\}\/ledger\/\$\{tokenRow\.token\}/);
  assert.match(api, /\$\{origin\}\/ledger\/\$\{tok\.token\}/);
  assert.doesNotMatch(api, /\/h\/ledger\/\$\{/);
  assert.match(app, /path="\/h\/ledger\/:token"/);
  assert.match(app, /pathname\.startsWith\("\/h\/ledger\/"\)/);
});

test('ledger upload uses SECURITY DEFINER insert, not raw RLS insert', () => {
  const api = sourceOf('functions/api/homeowner.mjs');
  const sql = sourceOf('workflows/sql/71_staging_public_workflow_grants.sql');
  assert.match(api, /aws_public_homeowner_ledger_upload_insert/);
  assert.doesNotMatch(api, /INSERT INTO public\.homeowner_ledger_check_uploads/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /GRANT EXECUTE[\s\S]*TO checksops/);
});

test('homeowner upload session accepts Bearer hex token', () => {
  const hex = 'a'.repeat(64);
  assert.equal(homeownerUploadTokenFromEvent({
    headers: { authorization: `Bearer ${hex}` },
  }, {}), hex);
  assert.equal(homeownerUploadTokenFromEvent({
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc' },
  }, {}), '');
  assert.equal(homeownerUploadTokenFromEvent({
    headers: { authorization: 'Bearer jwt', 'x-homeowner-upload-token': hex },
  }, {}), hex);
});

test('send-signature-request skipEmail keeps minted access_token', async () => {
  const updates = [];
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      updates.push(compact);
      if (compact.includes('FROM public.signature_requests')) {
        return { rows: [{ id: 'req-1', document_name: 'Release', claim_id: null, field_data: [] }] };
      }
      if (compact.includes('FROM public.signature_signers')) {
        return { rows: [{ id: 'sig-1', signer_name: 'Ada', signer_email: 'ada@example.com' }] };
      }
      if (compact.includes('FROM public.company_branding')) {
        return { rows: [{}] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await runSendSignatureRequest({
    client,
    mapping: { application_user_id: 'user-1' },
    body: { requestId: 'req-1', skipEmail: true },
    spoof: {},
    send: async () => ({ mode: 'sink', results: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'manual_bypass');
  assert.ok(result.signerLinks?.[0]?.sign_url?.includes('/sign?token='));
  assert.equal(updates.some((sql) => /access_token = NULL/.test(sql)), false);
  assert.equal(updates.some((sql) => /SET access_token = \$2, token_hash = \$3/.test(sql)), true);
});

test('ledger upload calls public insert helper with token and path', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' '), params });
      if (String(sql).includes('BEGIN') || String(sql).includes('SET TRANSACTION') || String(sql).includes('COMMIT')) {
        return { rows: [] };
      }
      if (String(sql).includes('aws_public_homeowner_ledger_by_token')) {
        return {
          rows: [{
            doc: {
              ok: true,
              token: { id: 'tok-1', tenant_id: 't1', claim_id: 'c1' },
            },
          }],
        };
      }
      if (String(sql).includes('aws_public_homeowner_ledger_upload_insert')) {
        return {
          rows: [{ doc: { ok: true, id: 'up-1', front_path: params[1], status: 'uploaded' } }],
        };
      }
      return { rows: [] };
    },
    connect: async () => {},
    end: async () => {},
  };
  const png = Buffer.alloc(120, 1).toString('base64');
  const result = await handleHomeownerLedgerUpload({
    body: JSON.stringify({ token: 'ledger-token-value', front_base64: png }),
  }, {
    client,
    putObject: async () => ({}),
    sendViaSesOrSink: async () => ({ mode: 'sink' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.upload.id, 'up-1');
  const insert = calls.find((row) => row.sql.includes('aws_public_homeowner_ledger_upload_insert'));
  assert.equal(insert.params[0], 'ledger-token-value');
  assert.match(insert.params[1], /^ledger\//);
});

test('AWS ledger view maps token/claim onto UI mode/homeowner/totals', () => {
  const shaped = shapeHomeownerLedgerView({
    ok: true,
    token: {
      id: 'tok-1',
      tenant_id: 't1',
      claim_id: 'c1',
      homeowner_name: 'Amanda Onori',
      homeowner_email: 'amanda@example.com',
    },
    claim: { id: 'c1', claim_number: '249987', property_address: '1 Main' },
    events: [
      { id: 'e1', event_type: 'check_received', amount: 270.87 },
      { id: 'e2', event_type: 'deposited', amount: 270.87 },
    ],
  });
  assert.equal(shaped.mode, 'claim');
  assert.equal(shaped.homeowner.name, 'Amanda Onori');
  assert.equal(shaped.homeowner.email, 'amanda@example.com');
  assert.equal(shaped.totals.received, 270.87);
  assert.equal(shaped.totals.deposited, 270.87);
  assert.equal(shaped.can_upload, true);
  assert.equal(shaped.pending_upload_count, 0);
  assert.ok(Array.isArray(shaped.events));
});

test('AWS ledger view without claim is pre_claim and never leaves homeowner undefined', () => {
  const shaped = shapeHomeownerLedgerView({
    ok: true,
    token: { id: 'tok-2', homeowner_name: 'Pat', homeowner_email: 'pat@example.com' },
  });
  assert.equal(shaped.mode, 'pre_claim');
  assert.equal(shaped.homeowner.name, 'Pat');
  assert.equal(shaped.homeowner.email, 'pat@example.com');
  assert.deepEqual(shaped.totals, { received: 0, deposited: 0, released: 0, remaining: 0 });
  assert.equal(shaped.homeowner.name.length > 0, true);
});

test('frontend ledger summary shaper accepts the live AWS payload', () => {
  const ui = shapeHomeownerLedgerSummary({
    ok: true,
    token: { homeowner_name: 'Amanda Onori', homeowner_email: 'amanda@example.com' },
    claim: { id: 'c61e6e61-f0bc-418b-ad92-fba64e2f227c', claim_number: '249987' },
    events: [],
  });
  assert.equal(ui.mode, 'claim');
  assert.equal(ui.homeowner.name, 'Amanda Onori');
  assert.equal(ui.totals.received, 0);
  assert.equal(ui.can_upload, true);
});

test('ledger page uses the AWS summary shaper', () => {
  const page = sourceOf('../src/pages/HomeownerLedger.tsx');
  assert.match(page, /shapeHomeownerLedgerSummary/);
  assert.doesNotMatch(page, /setData\(res as Summary\)/);
});
