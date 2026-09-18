/**
 * Normalize Azure prebuilt-check.us fields to ChecksOps MICR states.
 * Azure descriptive values are supplemental only; they do not become canonical here.
 */
import { abaRoutingChecksumOk, digitsOnly, splitPayees } from './ocr-parse.mjs';

const STATES = { VERIFIED: 'VERIFIED', REVIEW_REQUIRED: 'REVIEW_REQUIRED', MISSING: 'MISSING' };
const ACCOUNT_MIN = 6;
const ACCOUNT_MAX = 17;

const fieldValue = (field) => {
  if (field == null) return { raw: null, confidence: null };
  if (typeof field !== 'object') return { raw: field, confidence: null };
  const raw = field.valueString ?? field.valueNumber ?? field.content ?? null;
  const confidence = Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : null;
  return { raw, confidence };
};

const micrChild = (fields, name) => {
  const micr = fields?.MICR;
  const obj = micr?.valueObject || micr?.value || null;
  if (obj && obj[name]) return fieldValue(obj[name]);
  if (micr && micr[name]) return fieldValue(micr[name]);
  return { raw: null, confidence: null };
};

export const normalizeAzureMicr = (document = {}, { printedCheckNumber = null } = {}) => {
  const fields = document.fields || {};
  const routingField = micrChild(fields, 'RoutingNumber');
  const accountField = micrChild(fields, 'AccountNumber');
  const checkField = micrChild(fields, 'CheckNumber');

  const routingDigits = digitsOnly(routingField.raw);
  let micr_routing_state = STATES.MISSING;
  let routing_number = null;
  if (routingField.raw != null && String(routingField.raw).trim() !== '') {
    if (routingDigits.length === 9 && abaRoutingChecksumOk(routingDigits)) {
      routing_number = routingDigits;
      micr_routing_state = STATES.VERIFIED;
    } else {
      micr_routing_state = STATES.REVIEW_REQUIRED;
    }
  }

  const accountDigits = digitsOnly(accountField.raw);
  let micr_account_state = STATES.MISSING;
  let account_number = null;
  if (accountField.raw != null && String(accountField.raw).trim() !== '') {
    if (accountDigits.length >= ACCOUNT_MIN && accountDigits.length <= ACCOUNT_MAX) {
      account_number = accountDigits;
      micr_account_state = STATES.VERIFIED;
    } else {
      micr_account_state = STATES.REVIEW_REQUIRED;
    }
  }

  const printed = printedCheckNumber ? digitsOnly(printedCheckNumber) : '';
  const micrCheckDigits = digitsOnly(checkField.raw);
  let micr_check_state = STATES.MISSING;
  let micr_check_number = null;
  if (checkField.raw != null && String(checkField.raw).trim() !== '') {
    micr_check_number = micrCheckDigits || null;
    if (printed && micrCheckDigits && printed === micrCheckDigits) {
      micr_check_state = STATES.VERIFIED;
    } else if (printed && micrCheckDigits && printed !== micrCheckDigits) {
      micr_check_state = STATES.REVIEW_REQUIRED;
    } else if (micrCheckDigits) {
      micr_check_state = STATES.VERIFIED;
    } else {
      micr_check_state = STATES.REVIEW_REQUIRED;
    }
  }

  const numberAmount = fieldValue(fields.NumberAmount);
  const wordAmount = fieldValue(fields.WordAmount);
  const payTo = fieldValue(fields.PayTo);
  const payeeLine = payTo.raw != null ? String(payTo.raw).trim() || null : null;

  return {
    routing_number,
    account_number,
    micr_check_number,
    micr_routing_state,
    micr_account_state,
    micr_check_state,
    field_confidence: {
      routing_number: routingField.confidence,
      account_number: accountField.confidence,
      micr_check_number: checkField.confidence,
    },
    supplemental: {
      carrier_name: fieldValue(fields.PayerName).raw != null ? String(fieldValue(fields.PayerName).raw).trim() || null : null,
      issue_date: fieldValue(fields.CheckDate).raw != null ? String(fieldValue(fields.CheckDate).raw).trim() || null : null,
      amount: numberAmount.raw != null && Number.isFinite(Number(numberAmount.raw))
        ? Number(numberAmount.raw).toFixed(2)
        : null,
      written_amount: wordAmount.raw != null && Number.isFinite(Number(wordAmount.raw))
        ? Number(wordAmount.raw).toFixed(2)
        : (wordAmount.raw != null ? String(wordAmount.raw).trim() || null : null),
      payee_line: payeeLine,
      payees: payeeLine ? splitPayees(payeeLine) : [],
      bank_name: fieldValue(fields.BankName).raw != null ? String(fieldValue(fields.BankName).raw).trim() || null : null,
      memo: fieldValue(fields.Memo).raw != null ? String(fieldValue(fields.Memo).raw).trim() || null : null,
      check_number: micrCheckDigits || null,
    },
  };
};

export const emptyAzureMicr = () => ({
  routing_number: null,
  account_number: null,
  micr_check_number: null,
  micr_routing_state: STATES.MISSING,
  micr_account_state: STATES.MISSING,
  micr_check_state: STATES.MISSING,
  field_confidence: {
    routing_number: null,
    account_number: null,
    micr_check_number: null,
  },
  supplemental: {
    carrier_name: null,
    issue_date: null,
    amount: null,
    written_amount: null,
    payee_line: null,
    payees: [],
    bank_name: null,
    memo: null,
    check_number: null,
  },
});
