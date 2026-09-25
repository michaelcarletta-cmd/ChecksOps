/**
 * Deterministic check-field extraction from OCR.
 *
 * Inputs:
 * - Textract Blocks (AnalyzeDocument/DetectDocumentText) when available, so we can
 *   use geometry + per-word confidence.
 * - Plain OCR lines (string[]) for fallback paths (stored OCR reparse).
 *
 * No LLM usage. No external side effects.
 */
const STANDARD_CAPS_ACRONYMS = new Set([
  'LLC', 'INC', 'LP', 'LLP', 'PA', 'PC', 'CO', 'CORP', 'NA', 'USA',
  'II', 'III', 'IV', 'DBA', 'LTD', 'JR', 'SR', 'US', 'PLLC',
  'USAA', 'NJM', 'AAA', 'CSAA', 'AIG', 'GEICO',
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

const CRITICAL_FIELDS = ['amount', 'check_number', 'payee_line'];
const CRITICAL_CONFIDENCE_THRESHOLD = 60;
const OVERALL_CONFIDENCE_THRESHOLD = 50;
const MICR_SAFE_CONFIDENCE = 70;

const clampPct = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
};

export const normalizeAmount = (raw) => {
  if (!raw) return null;
  const token = String(raw).trim().replace(/[$,\s]/g, '');
  if (!token) return null;
  const num = Number(token);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num.toFixed(2);
};

const normalizeDate = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s) return s;
    return null;
  }
  // MM/DD/YYYY or MM-DD-YYYY (also allow 2-digit year)
  const m = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (!m) return null;
  let [mm, dd, yy] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!Number.isFinite(mm) || !Number.isFinite(dd) || !Number.isFinite(yy)) return null;
  if (yy < 100) yy = yy >= 70 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible dates (e.g. 02/30)
  if (d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
};

const looksLikeAddress = (text) => {
  const s = String(text || '').trim();
  if (!s) return false;
  // Very addressy if it contains zip-like or multiple digits.
  if (/\b\d{5}(?:-\d{4})?\b/.test(s)) return true;
  if (/\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|p\.?o\.?\s*box|suite|ste|unit|apt)\b/i.test(s)) {
    if (/\d/.test(s)) return true;
  }
  // City, ST 12345 pattern.
  if (/\b[A-Z][a-z]+,\s*[A-Z]{2}\s*\d{5}\b/.test(s)) return true;
  return false;
};

const PAYEE_SPLIT_RE = /\s*(?:\band\b|&|＆|﹠|／|\/|;|；)\s*/i;
const PAY_TO_LABEL_RE = /^(?:pay(?:ee)?\s+to\s+(?:the\s+order\s+of)?|pay\s+to|the\s+order(?:\s+of)?)\b[:\s,]*/i;
const TRAILING_PAY_TO_RE = /(?:[,:\s]+(?:pay(?:ee)?\s+to\s+(?:the\s+order\s+of)?|the\s+order(?:\s+of)?))+$/i;
const ORDER_FRAGMENT_RE = /^(?:the\s+)?order(?:\s+of)?$/i;

const hasPayeeSeparator = (text) => PAYEE_SPLIT_RE.test(String(text || ''));

const KNOWN_BANK_ALIASES = [
  { re: /\bbank of america\b|\bbofa\b|\bbankofamerica\b/i, name: 'Bank of America' },
  { re: /\bjp\s*morgan\b|\bchase bank\b|\bchase\b/i, name: 'Chase' },
  { re: /\bwells fargo\b/i, name: 'Wells Fargo' },
  { re: /\bcitibank\b|\bciti bank\b/i, name: 'Citibank' },
  { re: /\bpnc bank\b/i, name: 'PNC Bank' },
  { re: /\btd bank\b/i, name: 'TD Bank' },
  { re: /\bu\.?s\.?\s*bank\b|\busbancorp\b/i, name: 'U.S. Bank' },
  { re: /\bcapital one\b/i, name: 'Capital One' },
  { re: /\btruist\b/i, name: 'Truist' },
  { re: /\bregions bank\b/i, name: 'Regions Bank' },
  { re: /\bfifth third\b/i, name: 'Fifth Third' },
  { re: /\bkeybank\b|\bkey bank\b/i, name: 'KeyBank' },
  { re: /\bcitizens bank\b/i, name: 'Citizens Bank' },
  { re: /\bm&t bank\b|\bm and t bank\b/i, name: 'M&T Bank' },
];

const KNOWN_CARRIER_ALIASES = [
  { re: /\busaa\b|united services automobile association|garrison property(?:\s+and\s+casualty)?/i, name: 'USAA' },
  { re: /\b(?:the\s+)?hartford (?:fire|casualty|insurance|accident|underwriter)|\bthe hartford\b/i, name: 'The Hartford' },
  { re: /\ballstate\b/i, name: 'Allstate' },
  { re: /\bnationwide\b/i, name: 'Nationwide' },
  { re: /\btravelers\b/i, name: 'Travelers' },
  { re: /\bstate farm\b/i, name: 'State Farm' },
  { re: /\bliberty mutual\b/i, name: 'Liberty Mutual' },
  { re: /\bfarmers(?:\s+insurance)?\b/i, name: 'Farmers' },
  { re: /\bprogressive\b/i, name: 'Progressive' },
  { re: /\bnew jersey manufacturers\b|\bnjm\b/i, name: 'NJM' },
  { re: /\bdonegal\b/i, name: 'Donegal' },
  { re: /\bchubb\b/i, name: 'Chubb' },
  { re: /\baig\b/i, name: 'AIG' },
  { re: /\bgeico\b/i, name: 'GEICO' },
  { re: /\berie insurance\b/i, name: 'Erie Insurance' },
  { re: /\bamica\b/i, name: 'Amica' },
  { re: /\bpreferred mutual\b/i, name: 'Preferred Mutual' },
];

export const looksLikeSecurityDisclaimer = (text) => {
  const s = String(text || '');
  if (!s.trim()) return false;
  return /colored background|artificial watermark|hold at (?:an?\s+)?angle|face of (?:the\s+)?document|security features|microprint|void if altered|original document|this document contains|thermochromic|padlock icon/i.test(s);
};

export const matchKnownCarrier = (text) => {
  const s = String(text || '').trim();
  if (!s || looksLikeSecurityDisclaimer(s) || looksLikeAddress(s)) return null;
  for (const alias of KNOWN_CARRIER_ALIASES) {
    if (alias.re.test(s)) return alias.name;
  }
  return null;
};

export const matchKnownBank = (text) => {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const alias of KNOWN_BANK_ALIASES) {
    if (alias.re.test(s)) return alias.name;
  }
  return null;
};

export const looksLikeBankName = (text) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (matchKnownCarrier(s)) return false;
  if (matchKnownBank(s)) return true;
  if (/\bbank\b/i.test(s) && !/insurance|mutual|casualty|assurance|indemnity|underwriter/i.test(s)) {
    return true;
  }
  return false;
};

export const sanitizeCarrierName = (text) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (looksLikeSecurityDisclaimer(s) || looksLikeAddress(s)) return null;
  if (looksLikeBankName(s)) return null;
  if (/\b(?:pay\s+to|order of|check\s*(?:no|number|#)|claim|memo|dollars?)\b/i.test(s) && !/insurance|mutual|casualty|assurance/i.test(s)) {
    return null;
  }
  const alias = matchKnownCarrier(s);
  if (alias) return alias;
  if (/insurance|mutual|assurance|casualty|indemnity|underwriter/i.test(s)) {
    return toStandardCaps(s);
  }
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 8 && !/\$/.test(s) && /[A-Za-z]{3,}/.test(s)) {
    return toStandardCaps(s);
  }
  return null;
};

export const looksLikeAmountLine = (text) => {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^\$?\s*\d[\d,]*(?:\.\d{2})?\s*$/.test(s) || /^\$\s*\d/.test(s);
};

export const cleanPayeeLine = (text) => {
  if (text == null) return null;
  let s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(new RegExp(PAY_TO_LABEL_RE.source, 'ig'), '');
  s = s.replace(new RegExp(TRAILING_PAY_TO_RE.source, 'ig'), '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || ORDER_FRAGMENT_RE.test(s) || /^pay\s+to$/i.test(s)) return null;
  if (looksLikeAmountLine(s)) return null;
  return s;
};

export const splitPayees = (payeeLine) => {
  if (!payeeLine) return [];
  const cleaned = cleanPayeeLine(payeeLine) || '';
  if (!cleaned) return [];
  // Split on AND/&/slash/semicolon but keep commas inside entity names (e.g. "Bank, N.A.")
  const parts = cleaned
    .split(PAYEE_SPLIT_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  const payees = [];
  for (const p of parts) {
    if (!p) continue;
    // Do not treat obvious address strings as payees.
    if (looksLikeAddress(p)) continue;
    // Strip trailing address fragments after the first long digit run,
    // but keep entity suffixes like "N.A." / "ISAOA-ATIMA".
    let out = p;
    const digitIdx = out.search(/\d{3,}/);
    if (digitIdx > 0) out = out.slice(0, digitIdx).trim();
    out = out.replace(/[,\s]+$/g, '').replace(/\s+/g, ' ').trim();
    out = cleanPayeeLine(out) || '';
    if (out.length < 2 || ORDER_FRAGMENT_RE.test(out) || looksLikeSecurityDisclaimer(out)) continue;
    payees.push({ name: toStandardCaps(out), type: 'unknown' });
  }
  return payees;
};

export const digitsOnly = (v) => String(v || '').replace(/[^0-9]/g, '');

const maskDigits = (v) => {
  const d = digitsOnly(v);
  if (!d) return null;
  if (d.length <= 4) return `***${d}`;
  return `***${d.slice(-4)}`;
};

export const abaRoutingChecksumOk = (raw) => {
  const d = digitsOnly(raw);
  if (d.length !== 9) return false;
  const n = [...d].map((c) => Number(c));
  if (n.some((x) => !Number.isFinite(x))) return false;
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
};

const classifyDateLabel = (text) => {
  const s = String(text || '');
  if (/\b(?:date\s+of\s+loss|loss\s*date|lossdate)\b/i.test(s)) return 'loss';
  if (/\bpolicy\s*date\b/i.test(s)) return 'policy';
  if (/\beffective\s*date\b/i.test(s)) return 'effective';
  if (/\bexpir(?:ation|y|es)?\s*date\b/i.test(s)) return 'expiration';
  if (/\b(?:issue\s*date|date\s*line|dateline)\b/i.test(s)) return 'issue';
  if (/\bdate\b/i.test(s)) return 'date';
  return 'other';
};

const DATE_EXCLUDE = new Set(['loss', 'policy', 'effective', 'expiration']);

const ABA_FRACTION_RE = /\b\d{1,2}\s*-\s*\d{3,5}\s*\/\s*\d{3,5}\b/g;
const US_STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const cleanBankName = (text) => {
  if (!text) return null;
  let s = String(text);
  s = s.replace(ABA_FRACTION_RE, ' ');
  s = s.replace(/\b\d{5}(?:-\d{4})?\b/g, ' ');
  s = s.replace(/\b([A-Z][a-z]+),\s*([A-Z]{2})\b/g, (full, city, st) => (
    US_STATE_ABBR.has(st) ? ' ' : full
  ));
  s = s.replace(/\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive)\b\.?/gi, ' ');
  s = s.replace(/\d+/g, ' ');
  s = s.replace(/[/\\|#*]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[,\s]+$/g, '').trim();
  if (s.length < 3) return null;
  return toStandardCaps(s);
};

const buildTextractIndex = (blocks = []) => {
  const byId = new Map();
  for (const b of blocks || []) {
    if (b && b.Id) byId.set(b.Id, b);
  }
  const lines = (blocks || [])
    .filter((b) => b && b.BlockType === 'LINE' && b.Text)
    .map((b) => ({
      text: String(b.Text || '').trim(),
      conf: clampPct(b.Confidence ?? null),
      box: b.Geometry?.BoundingBox || null,
    }))
    .filter((l) => l.text);
  // Sort top-to-bottom then left-to-right for stable adjacency heuristics.
  lines.sort((a, b) => (a.box?.Top ?? 0) - (b.box?.Top ?? 0) || (a.box?.Left ?? 0) - (b.box?.Left ?? 0));

  const words = (blocks || [])
    .filter((b) => b && b.BlockType === 'WORD' && b.Text)
    .map((b) => ({
      text: String(b.Text || '').trim(),
      conf: clampPct(b.Confidence ?? null),
      box: b.Geometry?.BoundingBox || null,
    }))
    .filter((w) => w.text);

  return {
    blocks,
    byId,
    lines,
    words,
  };
};

const safeLineConfidence = (line) => (line && line.conf != null ? line.conf : 50);

const pickCarrierName = (idx) => {
  let rejectedDisclaimer = false;
  let rejectedBank = false;
  for (const l of idx.lines) {
    if (looksLikeSecurityDisclaimer(l.text)) rejectedDisclaimer = true;
    if (looksLikeBankName(l.text)) rejectedBank = true;
  }
  for (const l of idx.lines) {
    const alias = matchKnownCarrier(l.text);
    if (alias) {
      return { value: alias, conf: Math.min(95, safeLineConfidence(l)), rejectedDisclaimer, rejectedBank };
    }
  }
  const candidates = idx.lines.filter((l) => {
    if ((l.box?.Top ?? 0) > 0.25) return false;
    if (!/[A-Za-z]/.test(l.text)) return false;
    if (looksLikeSecurityDisclaimer(l.text) || looksLikeAddress(l.text)) return false;
    if (looksLikeBankName(l.text)) return false;
    if (looksLikeAmountLine(l.text) || /\$/.test(l.text)) return false;
    if (/^(?:pay(?:ee)?\s+to|the\s+order)/i.test(l.text)) return false;
    if (/check\s*(?:no|number|#)/i.test(l.text)) return false;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(l.text.trim())) return false;
    return true;
  });
  let best = null;
  for (const l of candidates.slice(0, 12)) {
    if (/insurance|mutual|assurance|casualty|property|indemnity|underwriter/i.test(l.text)) {
      best = l;
      break;
    }
  }
  if (!best) {
    for (const l of candidates.slice(0, 8)) {
      if (sanitizeCarrierName(l.text)) {
        best = l;
        break;
      }
    }
  }
  const sanitized = best ? sanitizeCarrierName(best.text) : null;
  return {
    value: sanitized,
    conf: sanitized ? Math.min(90, safeLineConfidence(best)) : 15,
    rejectedDisclaimer,
    rejectedBank,
  };
};

const pickPayee = (idx) => {
  const payIdx = idx.lines.findIndex((l) => /pay\s+to\s+(?:the\s+order\s+of)?/i.test(l.text));
  let payeeLine = null;
  let payeeConf = 20;
  let multipleLines = false;
  if (payIdx >= 0) {
    const label = idx.lines[payIdx];
    const labelText = label.text;
    // Some checks put payee on same line after ':'.
    const inline = labelText.split(/pay\s+to\s+(?:the\s+order\s+of)?/i).slice(1).join(' ').replace(/^[:\s]+/, '').trim();
    if (inline && !looksLikeAddress(inline)) {
      payeeLine = inline;
      payeeConf = Math.min(95, safeLineConfidence(label));
    }
    // Collect following close lines (multiline payees / leftover "& NAME").
    const y = label.box?.Top ?? null;
    const close = (l) => (y == null || l?.box?.Top == null ? true : (l.box.Top - y) <= 0.14);
    const extras = [];
    for (const l of idx.lines.slice(payIdx + 1, payIdx + 4)) {
      if (!l || !close(l)) continue;
      if (looksLikeAddress(l.text) || looksLikeSecurityDisclaimer(l.text)) continue;
      if (looksLikeAmountLine(l.text)) continue;
      if (ORDER_FRAGMENT_RE.test(String(l.text).trim()) || PAY_TO_LABEL_RE.test(String(l.text).trim())) continue;
      if (/void|memo|date|dollars|amount|routing|account|authorized|signature/i.test(l.text) && !hasPayeeSeparator(l.text)) continue;
      extras.push(l);
    }
    if (extras.length) {
      multipleLines = extras.length > 1 || Boolean(payeeLine);
      const extraText = extras.map((c) => c.text).join(' ');
      payeeLine = payeeLine ? `${payeeLine} ${extraText}` : extraText;
      const confs = [payeeConf, ...extras.map((c) => safeLineConfidence(c))];
      payeeConf = Math.min(95, Math.round(confs.reduce((s, c) => s + c, 0) / confs.length));
    }
  }

  // Fallback: first non-address-ish line that looks like a payee entity (letters, not "VOID", not "MEMO").
  if (!payeeLine) {
    // Be conservative: without an explicit pay-to label, only guess a payee line
    // when the document shows other check-like signals (avoid fabricating payees
    // from arbitrary uploads).
    const hasAmount = idx.lines.some((l) => /\$?\s*\d[\d,]*\.\d{2}\b/.test(l.text));
    const hasDollars = idx.lines.some((l) => /\bdollars?\b/i.test(l.text));
    const hasDate = idx.lines.some((l) => /\bdate\b/i.test(l.text) || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(l.text));
    const hasCheckLabel = idx.lines.some((l) => /check\s*(?:no|number|#)/i.test(l.text));
    const hasMicrBand = idx.lines.some((l) => (l.box?.Top ?? 0) > 0.78 && digitsOnly(l.text).length >= 9);
    const signalCount = [hasAmount, hasDollars, hasDate, hasCheckLabel, hasMicrBand].filter(Boolean).length;
    if (signalCount < 2) {
      // Not check-like enough to infer payee.
      return {
        value: null,
        conf: 20,
        payees: [],
        separatorDetected: false,
        multipleLines: false,
        ambiguous: false,
      };
    }
    for (const l of idx.lines) {
      if (/pay\s+to\s+(?:the\s+order\s+of)?/i.test(l.text)) continue;
      if (/void|memo|date|dollars|amount|routing|account/i.test(l.text)) continue;
      if (/not\s+a\s+check|random\s+text/i.test(l.text)) continue;
      if (looksLikeAddress(l.text)) continue;
      if (l.text.length >= 5 && /[A-Za-z]/.test(l.text)) {
        payeeLine = l.text;
        payeeConf = Math.min(80, safeLineConfidence(l));
        break;
      }
    }
  }

  const normalized = payeeLine ? (toStandardCaps(cleanPayeeLine(payeeLine) || '') || null) : null;
  const separatorDetected = hasPayeeSeparator(normalized);
  const payees = splitPayees(normalized);
  const ambiguous = Boolean(normalized) && separatorDetected && payees.length < 2;
  return {
    value: normalized,
    conf: normalized ? payeeConf : 20,
    payees,
    separatorDetected,
    multipleLines,
    ambiguous,
  };
};

const pickIssueDate = (idx) => {
  const classified = [];
  const candidates = idx.lines.filter((l) => /\bdate\b/i.test(l.text) || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(l.text) || /\b\d{4}-\d{2}-\d{2}\b/.test(l.text));
  let best = null;
  let bestScore = -1e9;
  for (const l of candidates) {
    const t = l.text;
    const dateToken = t.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || t.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/)?.[0];
    const norm = normalizeDate(dateToken);
    if (!norm) continue;
    const label = classifyDateLabel(t);
    classified.push(label);
    let score = 0;
    if (DATE_EXCLUDE.has(label)) score -= 20;
    if (label === 'issue') score += 8;
    if (label === 'date' && !DATE_EXCLUDE.has(label)) score += 2;
    const top = l.box?.Top ?? 0.5;
    const left = l.box?.Left ?? 0.5;
    if (top < 0.30 && left > 0.50) score += 6; // dateline box
    if (top < 0.22 && left > 0.60) score += 2;
    score += (safeLineConfidence(l) - 50) / 25;
    if (score > bestScore) {
      bestScore = score;
      best = { norm, line: l, label };
    }
  }
  const lossDates = [];
  for (const l of candidates) {
    if (classifyDateLabel(l.text) !== 'loss') continue;
    const dateToken = l.text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || l.text.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/)?.[0];
    const norm = normalizeDate(dateToken);
    if (norm) lossDates.push(norm);
  }
  if (!best) {
    return {
      value: null,
      conf: 20,
      conflict: false,
      classifications: classified,
    };
  }
  const conflict = lossDates.some((d) => d && d !== best.norm);
  return {
    value: best.norm,
    conf: Math.min(95, safeLineConfidence(best.line)),
    conflict,
    classifications: classified,
  };
};

const pickAmountNumeric = (idx) => {
  const moneyRe = /(?:usd)?\s*\$?\s*\*{0,12}([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\b/i;
  let best = null;
  let bestScore = -1e9;
  for (const l of idx.lines) {
    const m = l.text.match(moneyRe);
    if (!m) continue;
    const norm = normalizeAmount(m[1]);
    if (!norm) continue;
    const top = l.box?.Top ?? 0.5;
    const left = l.box?.Left ?? 0.5;
    let score = 0;
    if (left > 0.55 && top > 0.10 && top < 0.70) score += 3; // numeric amount box tends to be right-ish
    if (/\$/.test(l.text)) score += 2;
    if (/\b(?:usd|amount)\b/i.test(l.text)) score += 1;
    if (looksLikeSecurityDisclaimer(l.text)) continue;
    if ((l.box?.Top ?? 0) > 0.80) score -= 5; // MICR band
    if (/routing|account|micr|check\s*(?:no|number|#)/i.test(l.text)) score -= 4;
    score += (safeLineConfidence(l) - 50) / 20;
    if (score > bestScore) {
      bestScore = score;
      best = { norm, line: l };
    }
  }
  if (!best) return { value: null, conf: 20 };
  return { value: best.norm, conf: Math.min(95, safeLineConfidence(best.line)) };
};

const WORD_NUMBER_IGNORE = new Set([
  'exactly', 'only', 'dollars', 'dollar', 'and', 'the', 'sum', 'of',
  'cents', 'cent', 'us', 'usd', 'lawful', 'money',
]);

const wordsToNumber = (text) => {
  // Deterministic converter for common insurance-check patterns:
  // "exactly nine thousand eight hundred sixty and 29/100 dollars"
  if (!text) return null;
  const raw = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\/\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const frac = raw.match(/\b(\d{1,2})\s*\/\s*100\b/);
  const cents = frac ? Number(frac[1]) : 0;
  const cleaned = raw
    .replace(/\b\d{1,2}\s*\/\s*100\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const SMALL = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const SCALE = { hundred: 100, thousand: 1000, million: 1000000 };
  let total = 0;
  let group = 0;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  let sawNumberWord = false;
  for (const tok of tokens) {
    if (WORD_NUMBER_IGNORE.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue; // ignore leftover numeric noise
    if (tok in SMALL) {
      group += SMALL[tok];
      sawNumberWord = true;
      continue;
    }
    if (tok === 'hundred') {
      group = (group || 1) * 100;
      sawNumberWord = true;
      continue;
    }
    if (tok === 'thousand' || tok === 'million') {
      total += (group || 1) * SCALE[tok];
      group = 0;
      sawNumberWord = true;
      continue;
    }
    // If we hit something unknown, abort (avoid fabrication).
    return null;
  }
  const dollars = total + group;
  if (!sawNumberWord || !Number.isFinite(dollars) || dollars <= 0) return null;
  const final = dollars + (Number.isFinite(cents) ? cents / 100 : 0);
  return final.toFixed(2);
};

const pickAmountWritten = (idx) => {
  let best = null;
  let bestScore = -1e9;
  let dollarsLineDetected = false;
  for (const l of idx.lines) {
    if (!/\bdollars?\b/i.test(l.text) && !/\band\s+\d{1,2}\s*\/\s*100\b/i.test(l.text)) continue;
    if (/\bdollars?\b/i.test(l.text)) dollarsLineDetected = true;
    // Prefer lines near middle-left (written amount line).
    const top = l.box?.Top ?? 0.5;
    const left = l.box?.Left ?? 0.5;
    let score = 0;
    if (top > 0.20 && top < 0.75 && left < 0.65) score += 2;
    if (/\bexactly\b|\bonly\b/i.test(l.text)) score += 1;
    score += (safeLineConfidence(l) - 50) / 25;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  if (!best) return { value: null, conf: 20, raw: null, dollarsLineDetected };
  const norm = wordsToNumber(best.text);
  return {
    value: norm,
    conf: norm ? Math.min(90, safeLineConfidence(best)) : 35,
    raw: best.text.slice(0, 200),
    dollarsLineDetected,
  };
};

const CLAIM_JUNK_TOKENS = new Set([
  'DATE', 'RPT', 'REPORT', 'HOLDER', 'NUMBER', 'NO', 'LOSS', 'FILE',
  'POLICY', 'CLAIM', 'CLM', 'REF', 'THE', 'AND', 'OF',
]);

const CLAIM_PATTERNS = [
  { re: /\b(usaa|njm|geico|aaa|csaa|aig)\s*#\s*([A-Z0-9][A-Z0-9\-]{3,32})\b/i, group: 2, score: 5, allowLongDigits: true },
  { re: /\b(?:claim|clm)\s*(?:#|no\.?|number|:|-)?\s*([A-Z0-9][A-Z0-9\-]{3,32})\b/i, group: 1, score: 4, allowLongDigits: true },
  { re: /\b(?:file|ref(?:erence)?)\s*(?:#|no\.?|number|:|-)?\s*([A-Z0-9][A-Z0-9\-]{3,32})\b/i, group: 1, score: 3, allowLongDigits: true },
];

const looksLikeClaimToken = (token, { allowLongDigits } = {}) => {
  const text = String(token || '').trim();
  if (text.length < 4 || text.length > 32) return false;
  if (CLAIM_JUNK_TOKENS.has(text.toUpperCase())) return false;
  if (!/\d/.test(text)) return false;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i.test(text)) return false;
  if (/^\d{9,}$/.test(text) && !allowLongDigits) return false;
  return true;
};

const claimTokenFromText = (text) => {
  let best = null;
  for (const pattern of CLAIM_PATTERNS) {
    const match = String(text || '').match(pattern.re);
    const token = match ? match[pattern.group] : null;
    if (!looksLikeClaimToken(token, { allowLongDigits: pattern.allowLongDigits })) continue;
    if (!best || pattern.score > best.score) best = { token, score: pattern.score };
  }
  return best;
};

const pickClaimNumber = (idx) => {
  let best = null;
  let bestScore = -1e9;
  const lines = idx.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const top = l.box?.Top ?? 0.5;
    if (top >= 0.85) continue;
    const next = lines[i + 1];
    const nextTop = next?.box?.Top ?? 1;
    const joined = next && nextTop < 0.85 && (nextTop - top) < 0.08
      ? `${l.text} ${next.text}`
      : l.text;
    const found = claimTokenFromText(l.text) || claimTokenFromText(joined);
    if (!found) continue;
    let score = found.score;
    if (top < 0.85) score += 1;
    score += (safeLineConfidence(l) - 50) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = { token: found.token, line: l };
    }
  }
  if (!best) return { value: null, conf: 20 };
  return { value: best.token, conf: Math.min(90, safeLineConfidence(best.line)) };
};

const pickMemo = (idx) => {
  for (const l of idx.lines) {
    if (/\bmemo\b/i.test(l.text)) {
      const after = l.text.split(/\bmemo\b/i).slice(1).join(' ').replace(/^[:\s]+/, '').trim();
      const value = after ? after : null;
      return { value: value ? toStandardCaps(value) : null, conf: value ? Math.min(85, safeLineConfidence(l)) : 30 };
    }
  }
  // Fallback: "For:" label
  for (const l of idx.lines) {
    if (/\bfor\b\s*[:\-]/i.test(l.text)) {
      const after = l.text.split(/\bfor\b/i).slice(1).join(' ').replace(/^[:\s\-]+/, '').trim();
      const value = after ? after : null;
      return { value: value ? toStandardCaps(value) : null, conf: value ? Math.min(80, safeLineConfidence(l)) : 30 };
    }
  }
  return { value: null, conf: 20 };
};

const pickBankName = (idx, payeeLine) => {
  // Drawee bank often appears in lower half; avoid grabbing payee bank.
  const payLower = String(payeeLine || '').toLowerCase();
  let best = null;
  let bestScore = -1e9;
  for (const l of idx.lines) {
    if (!/\bbank\b/i.test(l.text)) continue;
    if (payLower && payLower.includes(l.text.toLowerCase())) continue;
    if (/pay\s+to\s+(?:the\s+order\s+of)?/i.test(l.text)) continue;
    const top = l.box?.Top ?? 0.5;
    let score = 0;
    if (top > 0.55) score += 2;
    if (/\b\d{1,2}\s*-\s*\d{3,5}\s*\/\s*\d{3,5}\b/.test(l.text)) score += 1; // transit often sits on drawee line
    score += (safeLineConfidence(l) - 50) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  if (!best) return { value: null, conf: 20 };
  const cleaned = cleanBankName(best.text);
  return { value: cleaned, conf: cleaned ? Math.min(80, safeLineConfidence(best)) : 20 };
};

const pickCheckNumber = (idx) => {
  const numericToken = (t) => {
    const m = String(t || '').match(/\b(\d{3,12})\b/);
    return m ? m[1] : null;
  };

  let best = null;
  let bestScore = -1e9;
  for (const l of idx.lines) {
    // Avoid harvesting digits from date lines.
    if (/\bdate\b/i.test(l.text) || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(l.text) || /\b\d{4}-\d{2}-\d{2}\b/.test(l.text)) {
      if (!/check\s*(?:no|number|#)/i.test(l.text)) continue;
    }
    const token = l.text.match(/(?:check\s*(?:no|number|#)?[:\s-]*)(\d{3,12})/i)?.[1] || numericToken(l.text);
    if (!token) continue;
    // Avoid date tokens, routing number candidates, and obvious amount lines.
    if (normalizeDate(token)) continue;
    // Avoid year-only tokens unless explicitly labeled as check number.
    if (!/check\s*(?:no|number|#)/i.test(l.text) && token.length === 4) {
      const year = Number(token);
      if (Number.isFinite(year) && year >= 1900 && year <= 2099) continue;
    }
    if (token.length === 9 && /\b\d{9}\b/.test(token) && (l.box?.Top ?? 0) > 0.75) continue; // likely routing in MICR band
    if (/\$/.test(l.text) || /amount/i.test(l.text)) continue;
    const top = l.box?.Top ?? 0.5;
    const left = l.box?.Left ?? 0.5;
    let score = 0;
    if (/check\s*(?:no|number|#)/i.test(l.text)) score += 4;
    if (top < 0.35 && left > 0.55) score += 3; // top-right
    if (top < 0.25) score += 1;
    if (top > 0.80) score -= 3; // MICR band
    score += (safeLineConfidence(l) - 50) / 25;
    // Prefer medium-length tokens; too long can be claim/file.
    score += token.length >= 4 && token.length <= 8 ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = { token, line: l };
    }
  }
  if (!best) return { value: null, conf: 20 };
  return { value: best.token, conf: Math.min(90, safeLineConfidence(best.line)) };
};

const extractDigitRuns = (text) => {
  const s = String(text || '');
  const runs = [];
  const re = /\d+/g;
  let m;
  while ((m = re.exec(s))) {
    runs.push({
      digits: m[0],
      index: m.index,
      isolated9: m[0].length === 9,
      boundedBySymbol: (
        (m.index > 0 && /[:*o⑆]/i.test(s[m.index - 1] || ''))
        || /[:*o⑆]/i.test(s[m.index + m[0].length] || '')
      ),
    });
  }
  return runs;
};

const pickMicr = (idx, printedCheckNumber = null) => {
  const printed = printedCheckNumber ? digitsOnly(printedCheckNumber) : '';
  const bottomLines = idx.lines.filter((l) => (l.box?.Top ?? 0) > 0.75);
  const bottomWords = (idx.words || []).filter((w) => (w.box?.Top ?? 0) > 0.75);
  const sources = bottomLines.length ? bottomLines : [];
  const runBag = [];
  for (const l of sources) {
    for (const run of extractDigitRuns(l.text)) {
      runBag.push({
        ...run,
        left: l.box?.Left ?? 0.5,
        conf: safeLineConfidence(l),
      });
    }
  }
  // WORD-level runs help when a LINE concatenates MICR fields.
  for (const w of bottomWords) {
    const d = digitsOnly(w.text);
    if (d.length >= 4) {
      runBag.push({
        digits: d,
        index: 0,
        isolated9: d.length === 9,
        boundedBySymbol: false,
        left: w.box?.Left ?? 0.5,
        conf: w.conf ?? 50,
      });
    }
  }

  const uniqueRuns = [];
  const seen = new Set();
  for (const r of runBag) {
    const key = `${r.digits}@${Math.round((r.left || 0) * 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueRuns.push(r);
  }

  const routingCandidates = [];
  for (const run of uniqueRuns) {
    const windows = [];
    if (run.digits.length === 9) {
      windows.push({ digits: run.digits, isolated: true, parentLen: 9, left: run.left, conf: run.conf, boundedBySymbol: run.boundedBySymbol });
    } else if (run.digits.length > 9) {
      for (let i = 0; i <= run.digits.length - 9; i += 1) {
        windows.push({
          digits: run.digits.slice(i, i + 9),
          isolated: false,
          parentLen: run.digits.length,
          left: run.left,
          conf: run.conf,
          boundedBySymbol: run.boundedBySymbol && i === 0,
          parentDigits: run.digits,
        });
      }
    }
    for (const w of windows) {
      if (!abaRoutingChecksumOk(w.digits)) continue;
      let score = 40;
      if (w.isolated) score += 20;
      if (w.boundedBySymbol) score += 10;
      const left = w.left ?? 0.5;
      if (left >= 0.18 && left <= 0.72) score += 10;
      if (printed && (w.digits.includes(printed) || (w.parentDigits && w.parentDigits.includes(printed)))) score -= 30;
      if (printed && w.digits === printed) score -= 40;
      if (!w.isolated && w.parentLen >= 10 && printed && w.parentDigits && w.parentDigits.includes(printed)) score -= 20;
      routingCandidates.push({ ...w, score });
    }
  }

  routingCandidates.sort((a, b) => b.score - a.score);
  const best = routingCandidates[0] || null;
  const second = routingCandidates[1] || null;
  const clearWinner = Boolean(best) && (!second || (best.score - second.score) >= 15);
  const routingAmbiguous = Boolean(best) && !clearWinner;
  const routing = clearWinner ? best.digits : null;
  const checksumPassed = Boolean(best);
  let routingConf = 10;
  if (routing) {
    routingConf = (best.isolated && checksumPassed)
      ? Math.min(85, Math.max(MICR_SAFE_CONFIDENCE, best.conf || 70))
      : 55;
  } else if (best && !clearWinner) {
    routingConf = 45;
  }

  const leftover = uniqueRuns.filter((r) => {
    if (routing && r.digits === routing) return false;
    if (routing && r.digits.includes(routing) && r.digits.length > 9) {
      // keep parent only if it has leftover besides routing
      return r.digits.replace(routing, '').length >= 4;
    }
    return true;
  });

  let micrCheck = null;
  let printedMatched = false;
  if (printed) {
    for (const r of leftover) {
      if (r.digits === printed || r.digits.includes(printed)) {
        micrCheck = printed;
        printedMatched = true;
        break;
      }
    }
  }

  const accountRuns = leftover
    .map((r) => {
      let d = r.digits;
      if (routing && d.includes(routing)) d = d.replace(routing, '');
      if (printed && d.includes(printed)) d = d.replace(printed, '');
      d = d.replace(/^0+/, d.length > 10 ? '' : d);
      return { ...r, digits: d };
    })
    .filter((r) => r.digits.length >= 6 && r.digits.length <= 17);

  // Dedup account runs by digits.
  const accountSeen = new Set();
  const uniqueAccounts = [];
  for (const r of accountRuns) {
    if (accountSeen.has(r.digits)) continue;
    accountSeen.add(r.digits);
    uniqueAccounts.push(r);
  }

  let account = null;
  let accountAmbiguous = false;
  if (uniqueAccounts.length === 1) {
    account = uniqueAccounts[0].digits;
  } else if (uniqueAccounts.length > 1) {
    accountAmbiguous = true;
  }

  const micrAmbiguous = routingAmbiguous || accountAmbiguous || (Boolean(best) && !routing);
  const checkConflict = Boolean(printed && micrCheck && digitsOnly(micrCheck) !== printed);

  return {
    routing_number: routing,
    account_number: account,
    micr_check_number: micrCheck,
    conf: routing ? routingConf : (bottomLines.length ? 40 : 10),
    routing_conf: routing ? routingConf : null,
    account_conf: account ? (accountAmbiguous ? 45 : Math.min(75, routingConf || 60)) : null,
    micr_check_conf: micrCheck ? (printedMatched ? 80 : 50) : null,
    ambiguous: micrAmbiguous,
    check_conflict: checkConflict,
    diagnostic: {
      micr_band_line_count: bottomLines.length,
      numeric_run_count: uniqueRuns.length,
      numeric_run_lengths: uniqueRuns.map((r) => r.digits.length).sort((a, b) => a - b),
      routing_candidate_count: routingCandidates.length,
      aba_checksum_passed: checksumPassed,
      printed_check_matched_micr_candidate: printedMatched,
    },
  };
};

const computeConfidenceBundle = (fields) => {
  const fieldConfidence = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.endsWith('__conf')) continue;
    if (fields[`${k}__conf`] != null) fieldConfidence[k] = clampPct(fields[`${k}__conf`]);
  }
  // Overall confidence: mean of known per-field confidences, with emphasis on criticals.
  const weights = (k) => (CRITICAL_FIELDS.includes(k) ? 2 : 1);
  const entries = Object.entries(fieldConfidence).filter(([, v]) => v != null);
  if (!entries.length) return { confidence: 20, field_confidence: {}, low_confidence_fields: ['amount', 'check_number', 'payee_line'], needs_manual_review: true };
  const weightedSum = entries.reduce((s, [k, v]) => s + v * weights(k), 0);
  const weightedDen = entries.reduce((s, [k]) => s + weights(k), 0);
  const confidence = Math.round(weightedSum / Math.max(1, weightedDen));

  const low = [];
  for (const [k, v] of entries) {
    if (v == null) continue;
    let threshold = 50;
    if (CRITICAL_FIELDS.includes(k)) threshold = CRITICAL_CONFIDENCE_THRESHOLD;
    if (k === 'routing_number' || k === 'account_number' || k === 'micr_check_number') {
      threshold = MICR_SAFE_CONFIDENCE;
    }
    if (v < threshold) low.push(k);
  }

  const criticalMissing = CRITICAL_FIELDS.some((k) => fields[k] == null || String(fields[k]).trim() === '');
  const criticalLow = CRITICAL_FIELDS.some((k) => (fieldConfidence[k] ?? 0) < CRITICAL_CONFIDENCE_THRESHOLD);
  const overallLow = confidence < OVERALL_CONFIDENCE_THRESHOLD;
  const micrLow = ['routing_number', 'account_number', 'micr_check_number'].some((k) => {
    const present = fields[k] != null && String(fields[k]).trim() !== '';
    return present && (fieldConfidence[k] ?? 0) < MICR_SAFE_CONFIDENCE;
  });
  const needsManualReview = criticalMissing || criticalLow || overallLow || low.includes('amount_disagreement') || micrLow;

  // Drop helper-only sentinel if present.
  const lowOut = low.filter((k) => k !== 'amount_disagreement');

  return {
    confidence,
    field_confidence: fieldConfidence,
    low_confidence_fields: lowOut,
    needs_manual_review: needsManualReview,
  };
};

/**
 * Parse check fields from either:
 * - Textract blocks array (preferred)
 * - string[] OCR lines (fallback)
 */
export const parseCheckFields = (input = []) => {
  const isBlocks = Array.isArray(input) && input.length && typeof input[0] === 'object' && input[0] && ('BlockType' in input[0] || 'Text' in input[0]);
  const idx = isBlocks ? buildTextractIndex(input) : null;
  const lines = isBlocks
    ? idx.lines.map((l) => l.text)
    : (Array.isArray(input) ? input : []).map((l) => String(l || '')).filter(Boolean);

  // Text-only fallback for claim number regex, etc.
  const text = lines.join('\n');

  const carrier = isBlocks ? pickCarrierName(idx) : (() => {
    let rejectedDisclaimer = false;
    let rejectedBank = false;
    let value = null;
    for (const line of lines) {
      if (looksLikeSecurityDisclaimer(line)) rejectedDisclaimer = true;
      if (looksLikeBankName(line)) rejectedBank = true;
    }
    for (const line of lines) {
      const alias = matchKnownCarrier(line);
      if (alias) return { value: alias, conf: 70, rejectedDisclaimer, rejectedBank };
    }
    for (const line of lines.slice(0, 8)) {
      if (looksLikeSecurityDisclaimer(line) || looksLikeAddress(line) || looksLikeBankName(line)) continue;
      if (looksLikeAmountLine(line) || /^(?:pay(?:ee)?\s+to|the\s+order)/i.test(line)) continue;
      if (/check\s*(?:no|number|#)/i.test(line)) continue;
      if (/insurance|mutual|assurance|casualty|property|indemnity|underwriter/i.test(line)) {
        value = sanitizeCarrierName(line);
        break;
      }
    }
    if (!value) {
      for (const line of lines.slice(0, 8)) {
        if (looksLikeSecurityDisclaimer(line) || looksLikeAddress(line) || looksLikeBankName(line)) continue;
        if (looksLikeAmountLine(line) || /^(?:pay(?:ee)?\s+to|the\s+order)/i.test(line)) continue;
        if (/check\s*(?:no|number|#)/i.test(line)) continue;
        value = sanitizeCarrierName(line);
        if (value) break;
      }
    }
    return { value, conf: value ? 55 : 15, rejectedDisclaimer, rejectedBank };
  })();

  const payee = isBlocks ? pickPayee(idx) : (() => {
    let payeeLine = null;
    const payIdx = lines.findIndex((l) => /pay\s+to\s+(?:the\s+order\s+of)?/i.test(l));
    if (payIdx >= 0) {
      const inline = String(lines[payIdx]).split(/pay\s+to\s+(?:the\s+order\s+of)?/i).slice(1).join(' ').replace(/^[:\s]+/, '').trim();
      if (inline && !looksLikeAddress(inline) && cleanPayeeLine(inline)) payeeLine = inline;
      else if (lines[payIdx + 1] && cleanPayeeLine(lines[payIdx + 1])) payeeLine = lines[payIdx + 1];
    }
    if (!payeeLine) {
      for (const line of lines) {
        if (/pay\s+to\s+(?:the\s+order\s+of)?/i.test(line)) continue;
        if (/dollars|void|memo|date|check/i.test(line)) continue;
        if (looksLikeSecurityDisclaimer(line) || ORDER_FRAGMENT_RE.test(line.trim())) continue;
        if (looksLikeAmountLine(line)) continue;
        if (line.length >= 5 && /[A-Za-z]/.test(line) && cleanPayeeLine(line)) { payeeLine = line; break; }
      }
    }
    const normalized = payeeLine ? toStandardCaps(cleanPayeeLine(payeeLine) || '') || null : null;
    return {
      value: normalized,
      conf: payeeLine ? 70 : 20,
      payees: splitPayees(payeeLine),
      separatorDetected: hasPayeeSeparator(payeeLine),
      multipleLines: false,
      ambiguous: Boolean(payeeLine) && hasPayeeSeparator(payeeLine) && splitPayees(payeeLine).length < 2,
    };
  })();

  const checkNo = isBlocks ? pickCheckNumber(idx) : (() => {
    const m = text.match(/(?:check\s*(?:no|number|#)?[:\s-]*)([0-9]{3,12})/i) || text.match(/\b([0-9]{4,10})\b/);
    return { value: m ? m[1] : null, conf: m ? 65 : 20 };
  })();

  const date = isBlocks ? pickIssueDate(idx) : (() => {
    const classified = [];
    let chosen = null;
    for (const line of lines) {
      const label = classifyDateLabel(line);
      const m = line.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/) || line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      const norm = normalizeDate(m ? m[1] : null);
      if (!norm) continue;
      classified.push(label);
      if (DATE_EXCLUDE.has(label)) continue;
      if (!chosen) chosen = { norm, label };
      if (label === 'issue' || label === 'date') chosen = { norm, label };
    }
    return {
      value: chosen?.norm || null,
      conf: chosen ? 65 : 20,
      conflict: classified.includes('loss') && Boolean(chosen?.norm),
      classifications: classified,
    };
  })();

  const amt = isBlocks ? pickAmountNumeric(idx) : (() => {
    const m = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\b/);
    const norm = normalizeAmount(m ? m[1] : null);
    return { value: norm, conf: norm ? 70 : 20 };
  })();

  const written = isBlocks ? pickAmountWritten(idx) : (() => {
    const dollars = lines.find((l) => /\bdollars?\b/i.test(l));
    const norm = dollars ? wordsToNumber(dollars) : null;
    return { value: norm, conf: norm ? 65 : 20, raw: dollars || null, dollarsLineDetected: Boolean(dollars) };
  })();
  const claim = isBlocks ? pickClaimNumber(idx) : (() => {
    const found = claimTokenFromText(text);
    return { value: found?.token || null, conf: found ? 60 : 20 };
  })();

  const memo = isBlocks ? pickMemo(idx) : { value: null, conf: 20 };
  const bank = isBlocks ? pickBankName(idx, payee.value) : { value: null, conf: 20 };
  const micr = isBlocks ? pickMicr(idx, checkNo.value) : (() => {
    const runs = extractDigitRuns(text.replace(/\s+/g, ' '));
    const valid = runs.filter((r) => r.digits.length === 9 && abaRoutingChecksumOk(r.digits));
    const routing = valid.length === 1 ? valid[0].digits : null;
    return {
      routing_number: routing,
      account_number: null,
      micr_check_number: null,
      conf: routing ? 50 : 10,
      routing_conf: routing ? 50 : null,
      account_conf: null,
      micr_check_conf: null,
      ambiguous: valid.length > 1,
      check_conflict: false,
      diagnostic: {
        micr_band_line_count: 0,
        numeric_run_count: runs.length,
        numeric_run_lengths: runs.map((r) => r.digits.length),
        routing_candidate_count: valid.length,
        aba_checksum_passed: valid.length > 0,
        printed_check_matched_micr_candidate: false,
      },
    };
  })();

  // Amount disagreement rule: if both numeric+written exist and differ materially, flag review.
  let disagreement = false;
  if (amt.value && written.value && amt.value !== written.value) {
    disagreement = true;
  }
  const writtenMissingWithDollars = Boolean(amt.value && !written.value && written.dollarsLineDetected);

  const fields = {
    carrier_name: carrier.value,
    check_number: checkNo.value,
    issue_date: date.value,
    amount: amt.value,
    written_amount: written.value,
    detected_claim_number: claim.value,
    claim_number: claim.value,
    payee_line: payee.value,
    payees: payee.payees,
    memo: memo.value,
    bank_name: bank.value,
    routing_number: micr.routing_number,
    account_number: micr.account_number,
    micr_check_number: micr.micr_check_number,

    carrier_name__conf: carrier.conf,
    check_number__conf: checkNo.conf,
    issue_date__conf: date.conf,
    amount__conf: disagreement ? Math.min(amt.conf, 55) : amt.conf,
    written_amount__conf: written.conf,
    detected_claim_number__conf: claim.conf,
    payee_line__conf: payee.conf,
    memo__conf: memo.conf,
    bank_name__conf: bank.conf,
    routing_number__conf: micr.routing_conf ?? micr.conf,
    account_number__conf: micr.account_conf ?? (micr.account_number ? Math.max(10, (micr.conf || 50) - 10) : null),
    micr_check_number__conf: micr.micr_check_conf ?? (micr.micr_check_number ? Math.max(10, (micr.conf || 50) - 10) : null),
    amount_disagreement__conf: disagreement ? 40 : 90,
    amount_disagreement: disagreement ? true : null,
  };

  const bundle = computeConfidenceBundle(fields);
  const low = new Set(bundle.low_confidence_fields || []);
  if (disagreement) low.add('amount');
  if (writtenMissingWithDollars) low.add('written_amount');
  if (payee.ambiguous) low.add('payee_line');
  if (date.conflict) low.add('issue_date');
  if (micr.ambiguous) low.add('routing_number');
  if (micr.check_conflict) low.add('micr_check_number');

  const extraReview = disagreement
    || writtenMissingWithDollars
    || Boolean(payee.ambiguous)
    || Boolean(date.conflict)
    || Boolean(micr.ambiguous)
    || Boolean(micr.check_conflict);

  return {
    carrier_name: sanitizeCarrierName(fields.carrier_name),
    check_number: fields.check_number || null,
    amount: fields.amount || null,
    written_amount: fields.written_amount || null,
    issue_date: fields.issue_date || null,
    claim_number: fields.claim_number || null,
    detected_claim_number: fields.detected_claim_number || null,
    payee_line: fields.payee_line ? toStandardCaps(cleanPayeeLine(fields.payee_line) || '') || null : null,
    routing_number: fields.routing_number || null,
    account_number: fields.account_number || null,
    micr_check_number: fields.micr_check_number || null,
    memo: toStandardCaps(fields.memo),
    bank_name: toStandardCaps(fields.bank_name),
    payees: Array.isArray(fields.payees) ? fields.payees : [],
    confidence: bundle.confidence,
    field_confidence: bundle.field_confidence,
    low_confidence_fields: Array.from(low),
    needs_manual_review: bundle.needs_manual_review || extraReview,
    diagnostic: {
      micr_band_line_count: micr.diagnostic?.micr_band_line_count ?? 0,
      numeric_run_count: micr.diagnostic?.numeric_run_count ?? 0,
      numeric_run_lengths: micr.diagnostic?.numeric_run_lengths ?? [],
      routing_candidate_count: micr.diagnostic?.routing_candidate_count ?? 0,
      aba_checksum_passed: Boolean(micr.diagnostic?.aba_checksum_passed),
      printed_check_matched_micr_candidate: Boolean(micr.diagnostic?.printed_check_matched_micr_candidate),
      payee_separator_detected: Boolean(payee.separatorDetected),
      multiple_payee_lines_detected: Boolean(payee.multipleLines),
      date_label_classifications: Array.isArray(date.classifications) ? date.classifications : [],
      carrier_rejected_disclaimer: Boolean(carrier.rejectedDisclaimer),
      carrier_rejected_bank: Boolean(carrier.rejectedBank),
    },
    // Helpers for safe logs/tests (do not add raw digits to logs)
    masked: {
      routing_number: maskDigits(fields.routing_number),
      account_number: maskDigits(fields.account_number),
      micr_check_number: maskDigits(fields.micr_check_number),
    },
  };
};

export const __test__ = {
  abaRoutingChecksumOk,
  wordsToNumber,
  classifyDateLabel,
  cleanBankName,
  splitPayees,
  cleanPayeeLine,
  sanitizeCarrierName,
  looksLikeSecurityDisclaimer,
  looksLikeAmountLine,
  looksLikeBankName,
  matchKnownCarrier,
  matchKnownBank,
  normalizeAmount,
  claimTokenFromText,
};
