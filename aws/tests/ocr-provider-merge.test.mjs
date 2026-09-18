import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCheckExtraction, extractCheck, ocrInProgress } from '../functions/api/check-ocr-provider.mjs';
import { normalizeAzureMicr } from '../functions/api/ocr-normalize-azure.mjs';
import { __test__ as ocrHooks } from '../functions/api/ocr.mjs';
import { redactOcrLog } from '../functions/api/azure-check-ocr.mjs';

const ROUTING_OK = '111000025';
const ROUTING_HEURISTIC = '110000000';
const ACCOUNT = '000111222333';
const ACCOUNT_HEURISTIC = '999888777666';
const CHECK = '778899';
const PAYEE_TX = 'Staging Uat Homeowner';
const PAYEE_AZ = 'Azure Only Payee LLC';

const field = (value, confidence = 0.2) => ({
  valueString: value,
  content: value,
  confidence,
});

const azureMicrFrom = (overrides = {}, printed = CHECK) => normalizeAzureMicr({
  fields: {
    MICR: {
      valueObject: {
        RoutingNumber: field(overrides.routing ?? ROUTING_OK, overrides.routingConf ?? 0),
        AccountNumber: field(overrides.account ?? ACCOUNT, overrides.accountConf ?? 0.008),
        CheckNumber: field(overrides.check ?? CHECK, overrides.checkConf ?? 0.168),
      },
      content: overrides.content,
    },
    PayerName: field(overrides.carrier ?? 'Azure Carrier Mutual'),
    NumberAmount: { valueNumber: overrides.amount ?? 99.12, confidence: 0.3 },
    WordAmount: { valueNumber: overrides.written ?? 99.12, confidence: 0.3 },
    PayTo: field(overrides.payee ?? PAYEE_AZ),
    CheckDate: field(overrides.date ?? '2026-02-02'),
    BankName: field(overrides.bank ?? 'Azure Bank NA'),
    Memo: field(overrides.memo ?? 'Azure memo'),
  },
}, { printedCheckNumber: printed });

const textractBase = (overrides = {}) => ({
  carrier_name: 'Textract Carrier Mutual',
  issue_date: '2026-01-15',
  amount: '1234.56',
  written_amount: '1234.56',
  payee_line: PAYEE_TX,
  payees: [{ name: PAYEE_TX, type: 'unknown' }],
  claim_number: 'CLM-STAGING-7788',
  detected_claim_number: 'CLM-STAGING-7788',
  bank_name: 'First Synthetic Bank',
  memo: 'Water Loss',
  check_number: CHECK,
  routing_number: ROUTING_HEURISTIC,
  account_number: ACCOUNT_HEURISTIC,
  micr_check_number: '000111',
  confidence: 88,
  field_confidence: { amount: 90 },
  low_confidence_fields: [],
  needs_manual_review: false,
  diagnostic: {},
  masked: {},
  ...overrides,
});

test('10) Azure native descriptive fields win when present', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase(),
    azureMicr: azureMicrFrom(),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.carrier_name, 'Azure Carrier Mutual');
  assert.equal(canonical.issue_date, '2026-02-02');
  assert.equal(canonical.amount, '99.12');
  assert.equal(canonical.written_amount, '1234.56');
  assert.equal(canonical.payee_line, PAYEE_AZ);
  assert.ok(canonical.payees.some((p) => p.name.includes('Azure Only Payee')));
  assert.equal(canonical.claim_number, 'CLM-STAGING-7788');
  assert.equal(canonical.check_number, CHECK);
  assert.equal(canonical.bank_name, 'Azure Bank NA');
  assert.equal(canonical.memo, 'Azure memo');
  assert.equal(canonical.descriptive_engine, 'aws_textract_analyze');
  assert.equal(canonical.micr_engine, 'azure_prebuilt_check_us');
  assert.ok(canonical.filled_from_azure.includes('carrier_name'));
  assert.ok(canonical.filled_from_azure.includes('amount'));
  assert.ok(canonical.filled_from_azure.includes('payee_line'));
  assert.ok(canonical.filled_from_azure.includes('issue_date'));
  assert.ok(canonical.filled_from_azure.includes('bank_name'));
  assert.equal(canonical.textract_descriptive.carrier_name, 'Textract Carrier Mutual');
  assert.equal(canonical.textract_descriptive.amount, '1234.56');
  assert.equal(canonical.textract_descriptive.payee_line, PAYEE_TX);
  assert.equal(canonical.textract_descriptive.check_number, CHECK);
  assert.equal(canonical.textract_descriptive.claim_number, 'CLM-STAGING-7788');
  assert.equal(canonical.needs_manual_review, true);
  assert.equal(canonical.diagnostic.descriptive_comparison.amount.differs, true);
  assert.equal(canonical.diagnostic.descriptive_comparison.carrier_name.differs, true);
});

test('11) Azure fills missing descriptive field only where explicitly allowed', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase({
      amount: null,
      payees: [],
      payee_line: null,
      memo: null,
      claim_number: 'CLM-KEEP',
      detected_claim_number: 'CLM-KEEP',
    }),
    azureMicr: azureMicrFrom(),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.amount, '99.12');
  assert.ok(canonical.filled_from_azure.includes('amount'));
  assert.ok(canonical.payees.some((p) => p.name.includes('Azure Only Payee')));
  assert.ok(canonical.filled_from_azure.includes('payees'));
  assert.equal(canonical.memo, 'Azure memo');
  assert.equal(canonical.claim_number, 'CLM-KEEP');
  assert.ok(!canonical.filled_from_azure.includes('claim_number'));
});

test('10b) printed check_number and claim_number remain Textract', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase({ check_number: CHECK, claim_number: 'CLM-KEEP', detected_claim_number: 'CLM-KEEP' }),
    azureMicr: azureMicrFrom({ check: '112233' }),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.check_number, CHECK);
  assert.equal(canonical.claim_number, 'CLM-KEEP');
  assert.equal(canonical.detected_claim_number, 'CLM-KEEP');
  assert.equal(canonical.micr_check_number, '112233');
  assert.equal(canonical.micr_check_state, 'REVIEW_REQUIRED');
  assert.ok(!canonical.filled_from_azure.includes('check_number'));
  assert.ok(!canonical.filled_from_azure.includes('claim_number'));
  assert.equal(canonical.descriptive_sources.check_number, 'aws_textract_analyze');
  assert.equal(canonical.descriptive_sources.claim_number, 'aws_textract_analyze');
});

test('10c) amount/date/payee disagreement sets manual review', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase(),
    azureMicr: azureMicrFrom(),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.needs_manual_review, true);
  assert.equal(canonical.diagnostic.descriptive_comparison.amount.differs, true);
  assert.equal(canonical.diagnostic.descriptive_comparison.issue_date.differs, true);
  assert.equal(canonical.diagnostic.descriptive_comparison.payee_line.differs, true);
  assert.equal(canonical.amount, '99.12');
  assert.equal(canonical.issue_date, '2026-02-02');
  assert.equal(canonical.payee_line, PAYEE_AZ);
});

test('10d) matching Azure/Textract descriptive does not force review', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase({
      carrier_name: 'Azure Carrier Mutual',
      issue_date: '2026-02-02',
      amount: '99.12',
      payee_line: PAYEE_AZ,
      payees: [{ name: PAYEE_AZ, type: 'unknown' }],
      bank_name: 'Azure Bank NA',
      memo: 'Azure memo',
      needs_manual_review: false,
    }),
    azureMicr: azureMicrFrom(),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.needs_manual_review, false);
  assert.equal(canonical.diagnostic.descriptive_comparison.amount.differs, false);
  assert.equal(canonical.diagnostic.descriptive_comparison.payee_line.differs, false);
});

test('11b) Azure never invents a claim number', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase({ claim_number: null, detected_claim_number: null }),
    azureMicr: azureMicrFrom(),
    descriptiveEngine: 'aws_textract_detect',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.claim_number, null);
  assert.equal(canonical.detected_claim_number, null);
  assert.ok(!canonical.filled_from_azure.includes('claim_number'));
});

test('12) Azure verified MICR cannot be overwritten by Textract heuristic MICR', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase(),
    azureMicr: azureMicrFrom(),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.routing_number, ROUTING_OK);
  assert.equal(canonical.account_number, ACCOUNT);
  assert.equal(canonical.micr_check_number, CHECK);
  assert.equal(canonical.micr_routing_state, 'VERIFIED');
  assert.equal(canonical.micr_account_state, 'VERIFIED');
  assert.equal(canonical.micr_check_state, 'VERIFIED');
  assert.equal(canonical.diagnostic.textract_micr_heuristic.routing_number, ROUTING_HEURISTIC);
  assert.equal(canonical.diagnostic.textract_micr_heuristic.account_number, ACCOUNT_HEURISTIC);
  assert.notEqual(canonical.routing_number, ROUTING_HEURISTIC);
  assert.notEqual(canonical.account_number, ACCOUNT_HEURISTIC);
});

test('12b) Azure REVIEW/MISSING does not silently promote Textract heuristic to VERIFIED', () => {
  const azure = normalizeAzureMicr({
    fields: {
      MICR: {
        valueObject: {
          RoutingNumber: field('111000026'),
        },
        content: `${ROUTING_HEURISTIC} ${ACCOUNT_HEURISTIC}`,
      },
    },
  });
  const canonical = mergeCheckExtraction({
    textractParsed: textractBase(),
    azureMicr: azure,
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.micr_routing_state, 'REVIEW_REQUIRED');
  assert.equal(canonical.micr_account_state, 'MISSING');
  assert.equal(canonical.routing_number, null);
  assert.equal(canonical.account_number, null);
  assert.equal(canonical.needs_manual_review, true);
  assert.equal(canonical.diagnostic.textract_micr_heuristic.routing_present, true);
});

test('24) duplicate/in-progress behavior', () => {
  const now = Date.parse('2026-09-18T13:00:00Z');
  assert.equal(ocrInProgress({
    ocr_status: 'processing',
    updated_at: '2026-09-18T12:59:30Z',
  }, now), true);
  assert.equal(ocrInProgress({
    ocr_status: 'processing',
    updated_at: '2026-09-18T12:58:00Z',
  }, now), false);
  assert.equal(ocrInProgress({
    ocr_status: 'complete',
    updated_at: '2026-09-18T12:59:50Z',
  }, now), false);
  assert.equal(ocrHooks.ocrInProgress({
    ocr_status: 'processing',
    updated_at: '2026-09-18T12:59:50Z',
  }, now), true);
});

test('25) tenant isolation remains in intake layer', async () => {
  const fakeClient = {
    query: async () => ({ rows: [] }),
  };
  const loaded = await ocrHooks.loadCheckImageBytes(fakeClient, '00000000-0000-0000-0000-000000000000');
  assert.equal(loaded.error, 'check_not_found');
  assert.equal(loaded.row, undefined);
});

test('extractCheck merges mocked Azure MICR with Textract descriptive', async () => {
  const logs = [];
  const textractSend = async () => ({
    Blocks: [
      {
        BlockType: 'LINE',
        Text: 'TEXTRACT CARRIER MUTUAL',
        Confidence: 96,
        Geometry: { BoundingBox: { Left: 0.1, Top: 0.05, Width: 0.4, Height: 0.03 } },
      },
      {
        BlockType: 'LINE',
        Text: 'PAY TO THE ORDER OF',
        Confidence: 95,
        Geometry: { BoundingBox: { Left: 0.08, Top: 0.28, Width: 0.3, Height: 0.03 } },
      },
      {
        BlockType: 'LINE',
        Text: PAYEE_TX,
        Confidence: 93,
        Geometry: { BoundingBox: { Left: 0.10, Top: 0.32, Width: 0.4, Height: 0.03 } },
      },
      {
        BlockType: 'LINE',
        Text: '$1,234.56',
        Confidence: 94,
        Geometry: { BoundingBox: { Left: 0.78, Top: 0.42, Width: 0.15, Height: 0.03 } },
      },
      {
        BlockType: 'LINE',
        Text: `CHECK NO: ${CHECK}`,
        Confidence: 93,
        Geometry: { BoundingBox: { Left: 0.72, Top: 0.12, Width: 0.2, Height: 0.03 } },
      },
    ],
  });
  const ENDPOINT = 'https://di-test.example.test';
  const RESULT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const op = `${ENDPOINT}/documentintelligence/documentModels/prebuilt-check.us/analyzeResults/${RESULT}`;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      return {
        status: 202,
        headers: { get: (n) => (String(n).toLowerCase() === 'operation-location' ? op : null) },
        text: async () => '',
      };
    }
    if (init.method === 'DELETE') {
      return { status: 204, headers: { get: () => null }, text: async () => '' };
    }
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        status: 'succeeded',
        analyzeResult: {
          documents: [{
            fields: {
              MICR: {
                valueObject: {
                  RoutingNumber: field(ROUTING_OK, 0),
                  AccountNumber: field(ACCOUNT, 0.008),
                  CheckNumber: field(CHECK, 0.208),
                },
              },
              NumberAmount: { valueNumber: 9.99, confidence: 0.4 },
              PayTo: field(PAYEE_AZ),
            },
          }],
        },
      }),
    };
  };
  const out = await extractCheck({
    imageBytes: Buffer.from('png'),
    secretLoader: async () => ({ endpoint: ENDPOINT, api_key: 'test-azure-key-not-real' }),
    textractSend,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: (row) => logs.push(row),
  });
  assert.equal(out.canonical.descriptive_engine, 'aws_textract_analyze');
  assert.equal(out.canonical.micr_engine, 'azure_prebuilt_check_us');
  assert.equal(out.canonical.micr_routing_state, 'VERIFIED');
  assert.equal(out.canonical.routing_number, ROUTING_OK);
  assert.equal(out.canonical.account_number, ACCOUNT);
  assert.equal(out.canonical.amount, '9.99');
  assert.notEqual(out.canonical.amount, '1234.56');
  assert.equal(out.canonical.check_number, CHECK);
  assert.equal(out.canonical.payee_line.includes('Azure Only Payee'), true);
  assert.equal(out.canonical.needs_manual_review, true);
  assert.equal(out.azure_delete_confirmed, true);
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes('test-azure-key-not-real'));
  assert.equal(redactOcrLog({ routing_number: ROUTING_OK }).routing_number, '[redacted]');
});

test('Azure not configured leaves MICR engine none and does not call transport', async () => {
  let fetches = 0;
  const out = await extractCheck({
    imageBytes: Buffer.from('png'),
    secretLoader: async () => null,
    textractSend: async () => ({ Blocks: [] }),
    fetchImpl: async () => { fetches += 1; return { status: 500, headers: { get: () => null }, text: async () => '' }; },
  });
  assert.equal(fetches, 0);
  assert.equal(out.canonical.micr_engine, 'none');
  assert.equal(out.canonical.micr_routing_state, 'MISSING');
  assert.equal(out.azure_error, 'azure_not_configured');
});
