import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';
import {
  collectOcrPayeeCandidates,
  normalizeIssueDate,
  normalizePayeeKey,
  persistOcrDescriptiveHandoff,
} from '../functions/api/ocr-descriptive-persist.mjs';
import {
  claimNumbersEqual,
  normalizeClaimNumber,
  normalizeDescriptiveText,
} from '../functions/api/ocr-descriptive-text.mjs';
import { handleCheckOcrIntake, redactOcrIntakeResponse } from '../functions/api/ocr.mjs';
import { resetAzureDiSecretCache } from '../functions/api/azure-di-secret.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROUTING_OK = '111000025';
const ACCOUNT = '000111222333';

const createClient = ({ existingPayees = [] } = {}) => {
  const store = {
    issue_date: null,
    is_multi_payee: null,
    amount: null,
    routing_number: null,
    account_number: null,
    carrier_name: null,
    payee_line: null,
    detected_claim_number: null,
    claim_id: null,
    deposited_at: null,
    stage: 'intake',
    confirmedProviderDeposit: false,
    missingCheck: false,
    payees: existingPayees.map((row) => ({ ...row })),
  };
  const statements = [];
  const client = {
    store,
    statements,
    query: async (sql, params = []) => {
      const text = String(sql);
      statements.push({ sql: text, params: [...params] });
      assert.equal(/UPDATE public\.check_intake_items[\s\S]*detected_claim_number\s*=/.test(text), false);
      if (/SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT /.test(text)) {
        return { rows: [] };
      }
      if (/set_config\('request\.financial_certification'/.test(text)) {
        return { rows: [] };
      }
      if (/FROM public\.check_intake_items/.test(text) && /deposited_at/.test(text) && /payee_line/.test(text)) {
        if (store.missingCheck) return { rows: [] };
        return { rows: [{ deposited_at: store.deposited_at, payee_line: store.payee_line }] };
      }
      if (/FROM public\.aws_financial_operations/.test(text)) {
        return { rows: store.confirmedProviderDeposit ? [{ found: 1 }] : [] };
      }
      if (/ocr_persist_extracted_amount/.test(text)) {
        const incoming = params[1] == null ? null : Number(params[1]);
        if (!Number.isFinite(incoming) || incoming <= 0) {
          return { rows: [{ result: { ok: true, persisted: false, code: 'absent' } }] };
        }
        if (store.deposited_at || ['deposited', 'voided', 'returned'].includes(String(store.stage || ''))) {
          return { rows: [{ result: { ok: true, persisted: false, code: 'locked' } }] };
        }
        if (store.amount != null) {
          if (Number(store.amount) === incoming) {
            return { rows: [{ result: { ok: true, persisted: false, code: 'unchanged' } }] };
          }
          return { rows: [{ result: { ok: true, persisted: false, code: 'conflict_preserved' } }] };
        }
        store.amount = incoming;
        return { rows: [{ result: { ok: true, persisted: true, code: 'written' } }] };
      }
      if (/ocr_persist_detected_claim_number/.test(text)) {
        const incoming = String(params[2] || '').trim();
        const existing = store.detected_claim_number;
        if (!incoming) {
          return { rows: [{ result: { ok: true, persisted: false, linked: false, code: 'absent' } }] };
        }
        if (!existing) {
          store.detected_claim_number = incoming;
          if (store.uniqueClaimId && !store.claim_id) store.claim_id = store.uniqueClaimId;
          return { rows: [{ result: { ok: true, persisted: true, linked: Boolean(store.claim_id), code: 'written' } }] };
        }
        if (claimNumbersEqual(existing, incoming)) {
          return { rows: [{ result: { ok: true, persisted: false, linked: false, code: 'unchanged' } }] };
        }
        return { rows: [{ result: { ok: true, persisted: false, linked: false, code: 'conflict_preserved' } }] };
      }
      if (/UPDATE public\.check_intake_items/.test(text) && /issue_date = \$2/.test(text)) {
        assert.equal(text.includes('amount'), false);
        store.issue_date = params[1];
        return { rows: [{ id: CHECK_ID, issue_date: store.issue_date }] };
      }
      if (/UPDATE public\.check_intake_items/.test(text) && /carrier_name/.test(text) && /payee_line/.test(text)) {
        const clearCarrier = params[3] === true;
        if (clearCarrier) store.carrier_name = null;
        else if (params[1] != null) store.carrier_name = params[1];
        if (params[2] != null) store.payee_line = params[2];
        return { rows: [{ id: CHECK_ID, carrier_name: store.carrier_name, payee_line: store.payee_line }] };
      }
      if (/UPDATE public\.check_intake_items/.test(text) && /is_multi_payee = true/.test(text)) {
        store.is_multi_payee = true;
        return { rows: [{ id: CHECK_ID, is_multi_payee: true }] };
      }
      if (/FROM public\.check_payees/.test(text)) {
        return { rows: store.payees.map((row) => ({ id: row.id, payee_name: row.payee_name })) };
      }
      if (/INSERT INTO public\.check_payees/.test(text)) {
        assert.equal(text.includes('routing_number'), false);
        assert.equal(text.includes('account_number'), false);
        assert.equal(text.includes('amount'), false);
        assert.match(text, /payee_type,[\s\S]*'unknown'/);
        assert.doesNotMatch(text, /endorsement_status/);
        const row = {
          id: `payee-${store.payees.length + 1}`,
          check_id: params[0],
          tenant_id: params[1],
          payee_name: params[2],
          payee_type: 'unknown',
          endorsement_status: 'pending',
          contact_email: null,
          contact_phone: null,
        };
        store.payees.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
  return client;
};

test('normalizeIssueDate accepts calendar dates and rejects blanks', () => {
  assert.equal(normalizeIssueDate('2026-03-15'), '2026-03-15');
  assert.equal(normalizeIssueDate('2026-03-15T12:00:00Z'), '2026-03-15');
  assert.equal(normalizeIssueDate('3/15/2026'), '2026-03-15');
  assert.equal(normalizeIssueDate(''), null);
  assert.equal(normalizeIssueDate(null), null);
  assert.equal(normalizeIssueDate('not-a-date'), null);
});

test('1) valid extracted issue_date persists', async () => {
  const client = createClient();
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { issue_date: '2026-03-15', payees: [] },
  });
  assert.equal(out.issue_date_persisted, true);
  assert.equal(client.store.issue_date, '2026-03-15');
  assert.equal(client.store.amount, null);
});

test('2) absent date does not overwrite existing date', async () => {
  const client = createClient();
  client.store.issue_date = '2025-01-01';
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { issue_date: null, payees: [] },
  });
  assert.equal(out.issue_date_persisted, false);
  assert.equal(client.store.issue_date, '2025-01-01');
  assert.equal(client.statements.some((row) => /issue_date = \$2/.test(row.sql)), false);
});

test('3) extracted amount fills via dedicated RPC; generic SET amount stays prohibited', async () => {
  const client = createClient();
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      issue_date: '2026-03-15',
      amount: '1500.00',
      routing_number: ROUTING_OK,
      account_number: ACCOUNT,
      payees: [{ name: 'One Payee' }],
    },
  });
  const blob = JSON.stringify(client.statements.map((row) => row.sql));
  assert.match(blob, /ocr_persist_extracted_amount/);
  assert.doesNotMatch(blob, /SET[\s\S]{0,80}amount\s*=/);
  assert.equal(out.amount_persisted, true);
  assert.equal(client.store.amount, 1500);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
});

test('4-6) three structured OCR payees become pending unknown candidates', async () => {
  const client = createClient();
  const logs = [];
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      payees: [
        { name: 'Gleitman Family Trust', type: 'insured' },
        { name: 'Second Payee LLC', type: 'mortgage' },
        { name: 'Third Payee Bank', type: 'other' },
      ],
    },
    log: (row) => logs.push(row),
  });
  assert.equal(out.payees_inserted, 3);
  assert.equal(client.store.payees.length, 3);
  assert.deepEqual(client.store.payees.map((row) => row.payee_type), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(client.store.payees.map((row) => row.endorsement_status), ['pending', 'pending', 'pending']);
  assert.equal(client.store.is_multi_payee, true);
  assert.equal(logs[0].code.includes('ins_3'), true);
  assert.equal(JSON.stringify(logs).includes('Gleitman'), false);
});

test('7) Payee Reconciliation reads check_payees rows', () => {
  const consoleSrc = fs.readFileSync(path.join(ROOT, 'src/components/check-review/CheckReviewConsole.tsx'), 'utf8');
  assert.match(consoleSrc, /function PayeeReconciliation/);
  assert.match(consoleSrc, /select\("\*, check_payees\(\*\)"\)/);
  assert.match(consoleSrc, /<PayeeReconciliation checkId=\{checkId\} payees=\{check\.check_payees \?\? \[\]\} \/>/);
  const ccc = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.match(ccc, /check_payees\(/);
});

test('8) rerunning the same OCR creates zero duplicates', async () => {
  const client = createClient();
  const parsed = {
    payees: [
      { name: 'Alpha Payee' },
      { name: 'Beta Payee' },
      { name: 'Gamma Payee' },
    ],
  };
  await persistOcrDescriptiveHandoff({ client, checkId: CHECK_ID, tenantId: TENANT_ID, parsed });
  const second = await persistOcrDescriptiveHandoff({ client, checkId: CHECK_ID, tenantId: TENANT_ID, parsed });
  assert.equal(client.store.payees.length, 3);
  assert.equal(second.payees_inserted, 0);
  assert.equal(second.payees_skipped, 3);
});

test('9-10) matching manual payee is preserved and not overwritten', async () => {
  const client = createClient({
    existingPayees: [{
      id: 'manual-1',
      payee_name: 'Alpha Payee',
      payee_type: 'insured',
      endorsement_status: 'viewed',
      contact_email: 'keep@example.test',
    }],
  });
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      payees: [
        { name: 'alpha   payee' },
        { name: 'Beta Payee' },
      ],
    },
  });
  assert.equal(client.store.payees.length, 2);
  const manual = client.store.payees.find((row) => row.id === 'manual-1');
  assert.equal(manual.payee_type, 'insured');
  assert.equal(manual.endorsement_status, 'viewed');
  assert.equal(manual.contact_email, 'keep@example.test');
  assert.equal(client.store.payees[1].payee_name, 'Beta Payee');
  assert.equal(client.store.payees[1].payee_type, 'unknown');
});

test('11) no fuzzy auto-merge of different names', async () => {
  const client = createClient({
    existingPayees: [{ id: 'manual-1', payee_name: 'John Smith', payee_type: 'insured', endorsement_status: 'pending' }],
  });
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { payees: [{ name: 'John Smithe' }] },
  });
  assert.equal(client.store.payees.length, 2);
});

test('12) zero valid payees creates zero rows', async () => {
  const client = createClient();
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { payees: [{ name: ' ' }, { name: '' }, null] },
  });
  assert.equal(out.payees_inserted, 0);
  assert.equal(client.store.payees.length, 0);
  assert.equal(client.store.is_multi_payee, null);
});

test('13-16) routing/account/MICR/CheckAlt/Moov stay out of the handoff', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'aws/functions/api/ocr-descriptive-persist.mjs'), 'utf8');
  const ocr = fs.readFileSync(path.join(ROOT, 'aws/functions/api/ocr.mjs'), 'utf8');
  assert.doesNotMatch(helper, /routing_number|account_number|micr_check_number|checkalt-submit|checkalt-dispatch|moov-transfer|moov-webhook/);
  assert.match(ocr, /persistOcrDescriptiveHandoff/);
  assert.match(ocr, /Intentionally do not set amount here/);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('routing_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('account_number'), true);
});

test('17) HTTP redaction is unchanged and still hides payee names', () => {
  const out = redactOcrIntakeResponse({
    parsed: {
      issue_date: '2026-03-15',
      payee_line: 'Gleitman Family Trust',
      payees: [{ name: 'Gleitman Family Trust' }, { name: 'Second Payee' }, { name: 'Third Payee' }],
      amount: '1500.00',
      routing_number: ROUTING_OK,
      account_number: ACCOUNT,
    },
  });
  assert.equal(out.descriptive.issue_date.present, true);
  assert.equal(out.descriptive.payees.count, 3);
  assert.equal('value' in out.descriptive.issue_date, false);
  assert.equal('payees' in out, false);
  const blob = JSON.stringify(out);
  assert.equal(blob.includes('Gleitman'), false);
  assert.equal(blob.includes('1500.00'), false);
  assert.equal(blob.includes(ROUTING_OK), false);
});

test('18) persist logs are count/status only', async () => {
  const logs = [];
  await persistOcrDescriptiveHandoff({
    client: createClient(),
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      issue_date: '2026-03-15',
      payees: [{ name: 'Secret Payee Name' }, { name: 'Another Name' }],
    },
    log: (row) => logs.push(row),
  });
  const blob = JSON.stringify(logs);
  assert.equal(blob.includes('Secret Payee Name'), false);
  assert.equal(blob.includes('Another Name'), false);
  assert.match(logs[0].code, /date_1_ins_2_skip_0_multi_1_claim_none_amt_none/);
});

test('19) amount remains prohibited and unpersisted after intake', async () => {
  const persist = [];
  const client = {
    query: async (sql, params = []) => {
      persist.push({ sql: String(sql), params });
      if (/FROM public\.check_intake_items WHERE id/.test(sql) && /front_image_path/.test(sql)) {
        return {
          rows: [{
            id: CHECK_ID,
            tenant_id: TENANT_ID,
            front_image_path: `checks/${CHECK_ID}/front.png`,
            ocr_status: 'pending',
            carrier_name: null,
            check_number: null,
            payee_line: null,
            amount: null,
          }],
        };
      }
      if (/FROM public\.check_payees/.test(sql)) return { rows: [] };
      if (/ocr_persist_extracted_amount/.test(sql)) {
        return { rows: [{ result: { ok: true, persisted: true, code: 'written' } }] };
      }
      if (/FROM public\.check_intake_items/.test(sql) && /deposited_at/.test(sql)) {
        return { rows: [{ deposited_at: null, payee_line: null }] };
      }
      return { rows: [] };
    },
  };
  const withIdentity = async (_event, fn) => fn({
    client,
    mapping: { application_user_id: '11111111-1111-1111-1111-111111111111' },
    body: { checkId: CHECK_ID },
    spoof: [],
  });
  process.env.FILES_BUCKET = 'test-files-bucket';
  resetAzureDiSecretCache();
  try {
    await handleCheckOcrIntake({ body: JSON.stringify({ checkId: CHECK_ID }) }, {
      withIdentity,
      ocr: {
        env: { CHECKSOPS_ENV: 'staging' },
        getSecretString: async () => JSON.stringify({
          api_key: 'test-azure-key-not-real',
          endpoint: 'https://di-test.example.test',
        }),
        fetchImpl: async (_url, init) => {
          if (init.method === 'POST') {
            return {
              status: 202,
              headers: { get: (n) => (String(n).toLowerCase() === 'operation-location' ? 'https://di-test.example.test/r' : null) },
              text: async () => '',
            };
          }
          if (init.method === 'DELETE') return { status: 204, headers: { get: () => null }, text: async () => '' };
          return {
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({
              status: 'succeeded',
              analyzeResult: {
                documents: [{
                  fields: {
                    CheckDate: { valueDate: '2026-03-15', content: '2026-03-15', confidence: 0.9 },
                    PayTo: { valueString: 'Alpha AND Beta AND Gamma', content: 'Alpha AND Beta AND Gamma' },
                    NumberAmount: { valueNumber: 88.5, confidence: 0.9 },
                  },
                }],
              },
            }),
          };
        },
        textractSend: async () => ({
          Blocks: [
            {
              BlockType: 'LINE',
              Text: 'DATE 03/15/2026',
              Confidence: 94,
              Geometry: { BoundingBox: { Left: 0.62, Top: 0.10, Width: 0.25, Height: 0.03 } },
            },
            {
              BlockType: 'LINE',
              Text: 'PAY TO THE ORDER OF',
              Confidence: 95,
              Geometry: { BoundingBox: { Left: 0.08, Top: 0.28, Width: 0.3, Height: 0.03 } },
            },
            {
              BlockType: 'LINE',
              Text: 'Alpha AND Beta AND Gamma',
              Confidence: 93,
              Geometry: { BoundingBox: { Left: 0.10, Top: 0.32, Width: 0.5, Height: 0.03 } },
            },
          ],
        }),
        s3Send: async () => ({ Body: Buffer.from('png') }),
        sleep: async () => {},
        now: () => 0,
        log: () => {},
      },
    });
  } finally {
    resetAzureDiSecretCache();
  }
  const sql = persist.map((row) => row.sql).join('\n');
  assert.match(sql, /issue_date = \$2::date/);
  assert.match(sql, /INSERT INTO public\.check_payees/);
  assert.match(sql, /is_multi_payee = true/);
  assert.doesNotMatch(sql, /SET[\s\S]{0,80}amount\s*=/);
  assert.equal(persist.some((row) => String(row.sql).includes('routing_number =')), false);
  const carrierUpdate = persist.find((row) => /COALESCE\(\$2, carrier_name\)/.test(row.sql));
  assert.ok(carrierUpdate);
  assert.equal(carrierUpdate.sql.includes('amount'), false);
});

test('candidate collection collapses whitespace and drops empties', () => {
  const rows = collectOcrPayeeCandidates({
    payees: [
      { name: '  Alpha   Payee  ' },
      { name: 'alpha payee' },
      { name: 'Beta' },
      { name: '' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(normalizePayeeKey(rows[0].name), 'alpha payee');
});

test('1) extracted claim number persists when field empty', async () => {
  const client = createClient();
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { claim_number: '  00412-AB/9  ', payees: [] },
  });
  assert.equal(out.claim_persisted, true);
  assert.equal(client.store.detected_claim_number, '00412-AB/9');
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
});

test('2-5) claim number preserves zeros, letters, punctuation, and case', () => {
  assert.equal(normalizeClaimNumber('  00412-AB/9  '), '00412-AB/9');
  assert.equal(normalizeClaimNumber('38-99V2-97X'), '38-99V2-97X');
  assert.equal(normalizeClaimNumber('abc-001'), 'abc-001');
  assert.notEqual(normalizeClaimNumber('ABC-001'), 'Abc-001');
  assert.equal(normalizeDescriptiveText('00412-AB/9'), '00412-AB/9');
});

test('6) absent OCR claim number does nothing', async () => {
  const client = createClient();
  client.store.detected_claim_number = 'KEEP-9';
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { claim_number: null, payees: [] },
  });
  assert.equal(out.claim_code, 'none');
  assert.equal(client.store.detected_claim_number, 'KEEP-9');
  assert.equal(client.statements.some((row) => /ocr_persist_detected_claim_number/.test(row.sql)), false);
});

test('7) same OCR claim number is idempotent', async () => {
  const client = createClient();
  client.store.detected_claim_number = '00412-AB/9';
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { claim_number: '00412-ab/9', payees: [] },
  });
  assert.equal(out.claim_persisted, false);
  assert.equal(out.claim_code, 'unchanged');
  assert.equal(client.store.detected_claim_number, '00412-AB/9');
});

test('8) different OCR claim number does not overwrite existing value', async () => {
  const client = createClient();
  client.store.detected_claim_number = '38-99V2-97X';
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { claim_number: '00412-AB/9', payees: [] },
  });
  assert.equal(out.claim_code, 'conflict_preserved');
  assert.equal(client.store.detected_claim_number, '38-99V2-97X');
});

test('ALL-CAPS person and company names become human-readable', async () => {
  const client = createClient();
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      carrier_name: 'FREEDOM ADJUSTMENT INC',
      payee_line: 'MICHAEL GLEITMAN AND JANE DOE',
      payees: [{ name: 'MICHAEL GLEITMAN' }, { name: 'FREEDOM ADJUSTMENT INC' }],
    },
  });
  assert.equal(client.store.carrier_name, 'Freedom Adjustment Inc');
  assert.equal(client.store.payee_line, 'Michael Gleitman And Jane Doe');
  assert.deepEqual(client.store.payees.map((row) => row.payee_name), [
    'Michael Gleitman',
    'Freedom Adjustment Inc',
  ]);
});

test('mixed-case names stay unchanged and hyphen/apostrophe/acronyms are preserved', () => {
  assert.equal(normalizeDescriptiveText('Michael Gleitman'), 'Michael Gleitman');
  assert.equal(normalizeDescriptiveText("O'CONNOR"), "O'Connor");
  assert.equal(normalizeDescriptiveText('SMITH-JONES'), 'Smith-Jones');
  assert.equal(normalizeDescriptiveText('A.B.C. COMPANY'), 'A.B.C. Company');
  assert.equal(normalizeDescriptiveText('JOHN SMITH LLC'), 'John Smith LLC');
  assert.equal(normalizeDescriptiveText('USAA CASUALTY'), 'USAA Casualty');
  assert.equal(normalizeDescriptiveText('NJM / PA PLLC LLP LP PC'), 'NJM / PA PLLC LLP LP PC');
});

test('ALL-CAPS OCR payee dedups against mixed-case manual payee without rename', async () => {
  const client = createClient({
    existingPayees: [{
      id: 'manual-1',
      payee_name: 'Michael Gleitman',
      payee_type: 'insured',
      endorsement_status: 'viewed',
      contact_email: 'keep@example.test',
    }],
  });
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { payees: [{ name: 'MICHAEL GLEITMAN' }] },
  });
  assert.equal(client.store.payees.length, 1);
  assert.equal(client.store.payees[0].payee_name, 'Michael Gleitman');
  assert.equal(client.store.payees[0].endorsement_status, 'viewed');
  assert.equal(client.store.payees[0].contact_email, 'keep@example.test');
});

test('claim/check/MICR values are not case-normalized; amount fills only through the amount RPC', async () => {
  const client = createClient();
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      claim_number: 'AB-001/X',
      check_number: '001234',
      amount: '1500.00',
      routing_number: ROUTING_OK,
      account_number: ACCOUNT,
      micr_check_number: '001234',
      payees: [],
    },
  });
  const blob = JSON.stringify(client.statements.map((row) => row.sql));
  assert.equal(client.store.detected_claim_number, 'AB-001/X');
  assert.equal(blob.includes('001234'), false);
  assert.equal(blob.includes(ROUTING_OK), false);
  assert.equal(blob.includes(ACCOUNT), false);
  assert.equal(/UPDATE public\.check_intake_items[\s\S]*detected_claim_number\s*=/.test(blob), false);
  assert.match(blob, /ocr_persist_extracted_amount/);
  assert.doesNotMatch(blob, /SET[\s\S]{0,80}amount\s*=/);
  assert.equal(client.store.amount, 1500);
});

test('generic /data/write still prohibits detected_claim_number', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/41_ocr_detected_claim_number.sql'), 'utf8');
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  assert.doesNotMatch(sql, /^GRANT UPDATE/m);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.ocr_persist_detected_claim_number[\s\S]*FROM authenticated/);
});

test('3) extracted amount fills via RPC only when the row is empty', async () => {
  const client = createClient();
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      issue_date: '2026-03-15',
      amount: '1500.00',
      routing_number: ROUTING_OK,
      account_number: ACCOUNT,
      payees: [{ name: 'One Payee' }],
    },
  });
  const blob = JSON.stringify(client.statements.map((row) => row.sql));
  assert.match(blob, /ocr_persist_extracted_amount/);
  assert.doesNotMatch(blob, /SET[\s\S]{0,80}amount\s*=/);
  assert.equal(out.amount_persisted, true);
  assert.equal(out.amount_code, 'written');
  assert.equal(client.store.amount, 1500);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
});

test('existing authoritative amount is not overwritten by OCR', async () => {
  const client = createClient();
  client.store.amount = 88.5;
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { amount: '1500.00', payees: [] },
  });
  assert.equal(out.amount_persisted, false);
  assert.equal(out.amount_code, 'conflict_preserved');
  assert.equal(client.store.amount, 88.5);
});

test('same extracted amount is unchanged rather than rewritten', async () => {
  const client = createClient();
  client.store.amount = 1500;
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { amount: '1500.00', payees: [] },
  });
  assert.equal(out.amount_persisted, false);
  assert.equal(out.amount_code, 'unchanged');
  assert.equal(client.store.amount, 1500);
});

test('deposited check cannot receive OCR amount mutation', async () => {
  const client = createClient();
  client.store.deposited_at = '2026-09-01T00:00:00Z';
  client.store.stage = 'deposited';
  client.store.payee_line = 'Existing Payee';
  const out = await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      amount: '1500.00',
      payee_line: 'ATTACKER PAYEE',
      payees: [],
    },
  });
  assert.equal(out.amount_persisted, false);
  assert.equal(out.amount_code, 'locked');
  assert.equal(client.store.amount, null);
  assert.equal(client.store.payee_line, 'Existing Payee');
});

test('S14 keeps deposited payee_line immutable during OCR persist', async () => {
  const client = createClient();
  client.store.deposited_at = '2026-09-01T00:00:00Z';
  client.store.payee_line = 'Locked Payee LLC';
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      carrier_name: 'USAA CASUALTY INSURANCE COMPANY',
      payee_line: 'MICHAEL GLEITMAN AND JANE DOE',
      payees: [{ name: 'MICHAEL GLEITMAN' }],
    },
  });
  assert.equal(client.store.payee_line, 'Locked Payee LLC');
  assert.equal(client.store.carrier_name, 'USAA');
  const payeeUpdate = client.statements.find((row) => /payee_line = COALESCE/.test(row.sql));
  assert.ok(payeeUpdate);
  assert.equal(payeeUpdate.params[2], null);
});

test('confirmed provider deposit also locks OCR payee_line writes', async () => {
  const client = createClient();
  client.store.payee_line = 'Original Payee';
  client.store.confirmedProviderDeposit = true;
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { payee_line: 'Replacement Payee', payees: [] },
  });
  assert.equal(client.store.payee_line, 'Original Payee');
});

test('watermark carrier is cleared and trailing The Order is stripped from payees', async () => {
  const WATERMARK = 'FACE OF DOCUMENT HAS A COLORED BACKGROUND THE BACK CONTAINS AN ARTIFICIAL WATERMARK HOLD AT ANGLE TO VIEW';
  const client = createClient();
  client.store.carrier_name = WATERMARK;
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      carrier_name: WATERMARK,
      payee_line: 'FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN THE ORDER',
      payees: [
        { name: 'Freedom Adjustment' },
        { name: 'Irwin L Gleitman' },
        { name: 'Sondra Gleitman The Order' },
        { name: 'THE ORDER' },
      ],
      diagnostic: { carrier_rejected_disclaimer: true },
    },
  });
  assert.equal(client.store.carrier_name, null);
  assert.doesNotMatch(String(client.store.payee_line || ''), /The Order/i);
  assert.deepEqual(client.store.payees.map((row) => row.payee_name), [
    'Freedom Adjustment',
    'Irwin L Gleitman',
    'Sondra Gleitman',
  ]);
});

test('Bank of America stored as carrier is cleared on rerun', async () => {
  const client = createClient();
  client.store.carrier_name = 'Bank Of America';
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: {
      carrier_name: 'Bank of America',
      payees: [],
      diagnostic: { carrier_rejected_bank: true },
    },
  });
  assert.equal(client.store.carrier_name, null);
});

test('known USAA alias persists instead of watermark text', async () => {
  const client = createClient();
  await persistOcrDescriptiveHandoff({
    client,
    checkId: CHECK_ID,
    tenantId: TENANT_ID,
    parsed: { carrier_name: 'USAA CASUALTY INSURANCE COMPANY', payees: [] },
  });
  assert.equal(client.store.carrier_name, 'USAA');
});

test('generic /data/write still prohibits amount; SQL 42 is the only amount path', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/42_ocr_extracted_amount.sql'), 'utf8');
  const persist = fs.readFileSync(path.join(ROOT, 'aws/functions/api/ocr-descriptive-persist.mjs'), 'utf8');
  const ocr = fs.readFileSync(path.join(ROOT, 'aws/functions/api/ocr.mjs'), 'utf8');
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.match(sql, /ocr_persist_extracted_amount/);
  assert.match(sql, /p_check_id uuid/);
  assert.match(sql, /p_amount numeric/);
  assert.match(sql, /amount IS NULL/);
  assert.match(sql, /deposited_at IS NULL/);
  assert.match(sql, /conflict_preserved/);
  assert.match(sql, /'locked'/);
  assert.match(sql, /'absent'/);
  assert.match(sql, /'unchanged'/);
  assert.match(sql, /'written'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.ocr_persist_extracted_amount[\s\S]*FROM authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.ocr_persist_extracted_amount\(uuid, numeric\) TO checksops/);
  assert.doesNotMatch(sql, /^GRANT UPDATE/m);
  assert.match(persist, /ocr_persist_extracted_amount/);
  assert.doesNotMatch(persist, /SET[\s\S]{0,80}amount\s*=/);
  assert.match(ocr, /Intentionally do not set amount here/);
  assert.doesNotMatch(ocr, /ocr_persist_extracted_amount/);
});
