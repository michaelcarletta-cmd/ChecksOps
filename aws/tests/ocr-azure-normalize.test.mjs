import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyAzureMicr, normalizeAzureMicr } from '../functions/api/ocr-normalize-azure.mjs';

const ROUTING_OK = '111000025';
const ROUTING_BAD = '111000026';
const ACCOUNT = '000111222333';
const CHECK = '778899';

const field = (value, confidence = 0.99) => ({
  valueString: value,
  content: value,
  confidence,
});

const azureDoc = ({
  routing = null,
  account = null,
  check = null,
  routingConf = 0.99,
  accountConf = 0.99,
  checkConf = 0.99,
  extraMicr = {},
  extraFields = {},
} = {}) => ({
  fields: {
    MICR: {
      type: 'object',
      content: extraMicr.content || null,
      valueObject: {
        ...(routing != null ? { RoutingNumber: field(routing, routingConf) } : {}),
        ...(account != null ? { AccountNumber: field(account, accountConf) } : {}),
        ...(check != null ? { CheckNumber: field(check, checkConf) } : {}),
      },
    },
    ...extraFields,
  },
});

test('1) Azure routing structured + valid ABA => VERIFIED', () => {
  const out = normalizeAzureMicr(azureDoc({ routing: ROUTING_OK }));
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(out.routing_number, ROUTING_OK);
});

test('2) invalid ABA => REVIEW_REQUIRED', () => {
  const out = normalizeAzureMicr(azureDoc({ routing: ROUTING_BAD }));
  assert.equal(out.micr_routing_state, 'REVIEW_REQUIRED');
  assert.equal(out.routing_number, null);
});

test('3) structured account => VERIFIED', () => {
  const out = normalizeAzureMicr(azureDoc({ account: ACCOUNT }));
  assert.equal(out.micr_account_state, 'VERIFIED');
  assert.equal(out.account_number, ACCOUNT);
});

test('4) account absent => MISSING', () => {
  const out = normalizeAzureMicr(azureDoc({ routing: ROUTING_OK }));
  assert.equal(out.micr_account_state, 'MISSING');
  assert.equal(out.account_number, null);
});

test('5) never infer account from raw MICR content', () => {
  const out = normalizeAzureMicr(azureDoc({
    routing: ROUTING_OK,
    extraMicr: { content: `⑆${ROUTING_OK}⑆ ${ACCOUNT} ${CHECK}` },
  }));
  assert.equal(out.micr_account_state, 'MISSING');
  assert.equal(out.account_number, null);
  assert.equal(out.routing_number, ROUTING_OK);
});

test('6) MICR check matches printed => VERIFIED', () => {
  const out = normalizeAzureMicr(azureDoc({ check: CHECK }), { printedCheckNumber: CHECK });
  assert.equal(out.micr_check_state, 'VERIFIED');
  assert.equal(out.micr_check_number, CHECK);
});

test('7) MICR check mismatch => REVIEW_REQUIRED', () => {
  const out = normalizeAzureMicr(azureDoc({ check: CHECK }), { printedCheckNumber: '112233' });
  assert.equal(out.micr_check_state, 'REVIEW_REQUIRED');
  assert.equal(out.micr_check_number, CHECK);
});

test('8) Azure confidence 0 but structurally valid => still VERIFIED', () => {
  const out = normalizeAzureMicr(azureDoc({
    routing: ROUTING_OK,
    account: ACCOUNT,
    check: CHECK,
    routingConf: 0,
    accountConf: 0,
    checkConf: 0,
  }), { printedCheckNumber: CHECK });
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(out.micr_account_state, 'VERIFIED');
  assert.equal(out.micr_check_state, 'VERIFIED');
  assert.equal(out.field_confidence.routing_number, 0);
});

test('9) Azure confidence 0.008 but valid => still VERIFIED', () => {
  const out = normalizeAzureMicr(azureDoc({
    routing: ROUTING_OK,
    account: ACCOUNT,
    routingConf: 0.008,
    accountConf: 0.008,
  }));
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(out.micr_account_state, 'VERIFIED');
  assert.equal(out.field_confidence.routing_number, 0.008);
});

test('MICR check missing => MISSING', () => {
  const out = normalizeAzureMicr(azureDoc({ routing: ROUTING_OK }), { printedCheckNumber: CHECK });
  assert.equal(out.micr_check_state, 'MISSING');
  assert.equal(out.micr_check_number, null);
});

test('emptyAzureMicr is all MISSING/null', () => {
  const out = emptyAzureMicr();
  assert.equal(out.micr_routing_state, 'MISSING');
  assert.equal(out.micr_account_state, 'MISSING');
  assert.equal(out.micr_check_state, 'MISSING');
  assert.equal(out.routing_number, null);
  assert.equal(out.account_number, null);
});

test('Azure descriptive fields stay supplemental only', () => {
  const out = normalizeAzureMicr({
    fields: {
      MICR: { valueObject: { RoutingNumber: field(ROUTING_OK) } },
      PayerName: field('AZURE CARRIER INC'),
      NumberAmount: { valueNumber: 99.12, confidence: 0.2 },
      PayTo: field('Azure Payee Only'),
    },
  });
  assert.equal(out.supplemental.carrier_name, 'AZURE CARRIER INC');
  assert.equal(out.supplemental.amount, '99.12');
  assert.ok(out.supplemental.payees.some((p) => p.name.includes('Azure Payee')));
  assert.equal(out.routing_number, ROUTING_OK);
});
