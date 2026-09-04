/**
 * Pure OCR text heuristics extracted for unit testing (no AWS SDK).
 */
const STANDARD_CAPS_ACRONYMS = new Set([
  'LLC', 'INC', 'LP', 'LLP', 'PA', 'PC', 'CO', 'CORP', 'NA', 'USA',
  'II', 'III', 'IV', 'DBA', 'LTD', 'JR', 'SR', 'US', 'PLLC',
]);

const toStandardCaps = (input) => {
  if (input == null) return input;
  const s = String(input);
  if (!s.trim()) return input;
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (word) => {
    const upper = word.toUpperCase();
    if (STANDARD_CAPS_ACRONYMS.has(upper)) return upper;
    if (word.length === 1) return upper;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
};

export const parseCheckFields = (lines = []) => {
  const text = lines.join('\n');
  const amountMatch = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\b/);
  const routingMatch = text.replace(/\s+/g, ' ').match(/\b([0-9]{9})\b/);
  const checkNumberMatch = text.match(/(?:check\s*(?:no|number|#)?[:\s-]*)([0-9]{3,12})/i)
    || text.match(/\b([0-9]{4,10})\b/);
  const dateMatch = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
  const claimMatch = text.match(/(?:claim|clm)[#:\s-]*([A-Z0-9\-]{4,24})/i);

  let payeeLine = null;
  const payIdx = lines.findIndex((l) => /pay\s+to\s+the\s+order/i.test(l));
  if (payIdx >= 0 && lines[payIdx + 1]) payeeLine = lines[payIdx + 1];
  if (!payeeLine) {
    for (const line of lines) {
      if (/pay\s+to\s+the\s+order/i.test(line)) continue;
      if (/dollars|void|memo|date|check/i.test(line)) continue;
      if (line.length >= 5 && /[A-Za-z]/.test(line)) {
        payeeLine = line;
        break;
      }
    }
  }

  let carrier = null;
  for (const line of lines.slice(0, 8)) {
    if (/insurance|mutual|assurance|casualty|property|indemnity|underwriter/i.test(line)) {
      carrier = line;
      break;
    }
  }
  if (!carrier && lines[0] && /[A-Za-z]/.test(lines[0])) carrier = lines[0];

  const amount = amountMatch ? amountMatch[1].replace(/,/g, '') : null;
  const payees = payeeLine
    ? payeeLine.split(/\s+(?:AND|&|\/)\s+/i).map((name) => ({
      name: toStandardCaps(name.trim()),
      type: 'unknown',
    })).filter((p) => p.name)
    : [];

  const fieldConfidence = {
    amount: amount ? 70 : 20,
    check_number: checkNumberMatch ? 65 : 20,
    payee_line: payeeLine ? 70 : 20,
    carrier_name: carrier ? 55 : 15,
    routing_number: routingMatch ? 50 : 10,
  };
  const low = Object.entries(fieldConfidence)
    .filter(([, v]) => v < 60)
    .map(([k]) => k);
  const confidence = Math.round(
    Object.values(fieldConfidence).reduce((a, b) => a + b, 0) / Object.keys(fieldConfidence).length,
  );

  return {
    carrier_name: toStandardCaps(carrier),
    check_number: checkNumberMatch ? checkNumberMatch[1] : null,
    amount,
    issue_date: dateMatch ? dateMatch[1] : null,
    claim_number: claimMatch ? claimMatch[1] : null,
    payee_line: toStandardCaps(payeeLine),
    routing_number: routingMatch ? routingMatch[1] : null,
    account_number: null,
    payees,
    confidence,
    field_confidence: fieldConfidence,
    low_confidence_fields: low,
    needs_manual_review: confidence < 50 || low.includes('amount') || low.includes('payee_line'),
  };
};
