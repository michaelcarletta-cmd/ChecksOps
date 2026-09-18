/**
 * Normalize Azure prebuilt-check.us fields to ChecksOps MICR + descriptive supplemental.
 * Descriptive values stay supplemental here; merge decides canonical precedence.
 */
import { abaRoutingChecksumOk, digitsOnly, splitPayees } from './ocr-parse.mjs';

const STATES = { VERIFIED: 'VERIFIED', REVIEW_REQUIRED: 'REVIEW_REQUIRED', MISSING: 'MISSING' };
const ACCOUNT_MIN = 6;
const ACCOUNT_MAX = 17;

const trimText = (value) => {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
};

const currencyAmount = (field) => {
  const cur = field?.valueCurrency;
  if (!cur || typeof cur !== 'object') return null;
  if (cur.amount != null) return cur.amount;
  if (cur.amountValue != null) return cur.amountValue;
  return null;
};

export const fieldValue = (field, { preferContent = false } = {}) => {
  if (field == null) return { raw: null, confidence: null };
  if (typeof field !== 'object') return { raw: field, confidence: null };
  const content = trimText(field.content);
  const raw = preferContent && content != null
    ? content
    : (
      field.valueString
      ?? field.valueDate
      ?? field.valueNumber
      ?? currencyAmount(field)
      ?? content
      ?? null
    );
  const confidence = Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : null;
  return { raw, confidence };
};

const formatAmount = (raw) => {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
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
  // Valid Azure MICR CheckNumber is authoritative. Printed-check disagreement is
  // diagnostic only and must not force REVIEW_REQUIRED by itself.
  if (checkField.raw != null && String(checkField.raw).trim() !== '') {
    micr_check_number = micrCheckDigits || null;
    micr_check_state = micrCheckDigits ? STATES.VERIFIED : STATES.REVIEW_REQUIRED;
  }
  const printed_vs_micr_check = {
    both_present: Boolean(printed && micrCheckDigits),
    differs: Boolean(printed && micrCheckDigits && printed !== micrCheckDigits),
  };

  const payerName = fieldValue(fields.PayerName);
  const checkDate = fieldValue(fields.CheckDate);
  const numberAmount = fieldValue(fields.NumberAmount);
  const wordAmount = fieldValue(fields.WordAmount, { preferContent: true });
  const payTo = fieldValue(fields.PayTo);
  const bankName = fieldValue(fields.BankName);
  const memo = fieldValue(fields.Memo);
  const payeeLine = trimText(payTo.raw);
  const wordText = trimText(wordAmount.raw);

  return {
    routing_number,
    account_number,
    micr_check_number,
    micr_routing_state,
    micr_account_state,
    micr_check_state,
    printed_vs_micr_check,
    field_confidence: {
      routing_number: routingField.confidence,
      account_number: accountField.confidence,
      micr_check_number: checkField.confidence,
      carrier_name: payerName.confidence,
      issue_date: checkDate.confidence,
      amount: numberAmount.confidence,
      written_amount: wordAmount.confidence,
      payee_line: payTo.confidence,
      bank_name: bankName.confidence,
      memo: memo.confidence,
    },
    supplemental: {
      carrier_name: trimText(payerName.raw),
      issue_date: trimText(checkDate.raw),
      amount: formatAmount(numberAmount.raw),
      written_amount: wordText,
      payee_line: payeeLine,
      payees: payeeLine ? splitPayees(payeeLine) : [],
      bank_name: trimText(bankName.raw),
      memo: trimText(memo.raw),
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
  printed_vs_micr_check: { both_present: false, differs: false },
  field_confidence: {
    routing_number: null,
    account_number: null,
    micr_check_number: null,
    carrier_name: null,
    issue_date: null,
    amount: null,
    written_amount: null,
    payee_line: null,
    bank_name: null,
    memo: null,
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
