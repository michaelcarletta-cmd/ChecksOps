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

const clampPct = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
};

const normalizeAmount = (raw) => {
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

const splitPayees = (payeeLine) => {
  if (!payeeLine) return [];
  const cleaned = String(payeeLine)
    .replace(/^\s*(pay\s+to\s+(?:the\s+order\s+of)?[:\s]*|of[:\s]+)/i, '')
    .trim();
  if (!cleaned) return [];
  // Split on AND/&/slash but keep commas inside entity names (e.g. "Bank, N.A.")
  const parts = cleaned
    .split(/\s*(?:\band\b|&|\/)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const payees = [];
  for (const p of parts) {
    if (!p) continue;
    // Do not treat obvious address strings as payees.
    if (looksLikeAddress(p)) continue;
    // Strip trailing address fragments after the first long digit run.
    let out = p;
    const digitIdx = out.search(/\d/);
    if (digitIdx > 0) out = out.slice(0, digitIdx).trim();
    out = out.replace(/\s+/g, ' ').trim();
    if (out.length < 2) continue;
    payees.push({ name: toStandardCaps(out), type: 'unknown' });
  }
  return payees;
};

const digitsOnly = (v) => String(v || '').replace(/[^0-9]/g, '');

const maskDigits = (v) => {
  const d = digitsOnly(v);
  if (!d) return null;
  if (d.length <= 4) return `***${d}`;
  return `***${d.slice(-4)}`;
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

  return {
    blocks,
    byId,
    lines,
  };
};

const safeLineConfidence = (line) => (line && line.conf != null ? line.conf : 50);

const pickCarrierName = (idx) => {
  const candidates = idx.lines.filter((l) => (l.box?.Top ?? 0) < 0.25 && /[A-Za-z]/.test(l.text));
  let best = null;
  for (const l of candidates.slice(0, 10)) {
    if (/insurance|mutual|assurance|casualty|property|indemnity|underwriter/i.test(l.text)) {
      best = l;
      break;
    }
  }
  if (!best && candidates.length) best = candidates[0];
  return best
    ? { value: toStandardCaps(best.text), conf: Math.min(90, safeLineConfidence(best)) }
    : { value: null, conf: 15 };
};

const pickPayee = (idx) => {
  const payIdx = idx.lines.findIndex((l) => /pay\s+to\s+(?:the\s+order\s+of)?/i.test(l.text));
  let payeeLine = null;
  let payeeConf = 20;
  if (payIdx >= 0) {
    const label = idx.lines[payIdx];
    const labelText = label.text;
    // Some checks put payee on same line after ':'.
    const inline = labelText.split(/pay\s+to\s+(?:the\s+order\s+of)?/i).slice(1).join(' ').replace(/^[:\s]+/, '').trim();
    if (inline && !looksLikeAddress(inline)) {
      payeeLine = inline;
      payeeConf = Math.min(95, safeLineConfidence(label));
    } else {
      // Otherwise take the next one or two lines directly below, close in Y.
      const next = idx.lines[payIdx + 1];
      const next2 = idx.lines[payIdx + 2];
      const y = label.box?.Top ?? null;
      const close = (l) => y == null || l?.box?.Top == null ? true : (l.box.Top - y) <= 0.10;
      const candidates = [];
      if (next && close(next) && !looksLikeAddress(next.text)) candidates.push(next);
      if (next2 && close(next2) && !looksLikeAddress(next2.text) && candidates.length) {
        // Include second line only when first exists (prevents grabbing random text).
        candidates.push(next2);
      }
      if (candidates.length) {
        payeeLine = candidates.map((c) => c.text).join(' ');
        payeeConf = Math.min(95, Math.round(candidates.reduce((s, c) => s + safeLineConfidence(c), 0) / candidates.length));
      }
    }
  }

  // Fallback: first non-address-ish line that looks like a payee entity (letters, not "VOID", not "MEMO").
  if (!payeeLine) {
    for (const l of idx.lines) {
      if (/pay\s+to\s+(?:the\s+order\s+of)?/i.test(l.text)) continue;
      if (/void|memo|date|dollars|amount|routing|account/i.test(l.text)) continue;
      if (looksLikeAddress(l.text)) continue;
      if (l.text.length >= 5 && /[A-Za-z]/.test(l.text)) {
        payeeLine = l.text;
        payeeConf = Math.min(80, safeLineConfidence(l));
        break;
      }
    }
  }

  const normalized = payeeLine ? toStandardCaps(payeeLine.replace(/\s+/g, ' ').trim()) : null;
  return {
    value: normalized,
    conf: normalized ? payeeConf : 20,
    payees: splitPayees(normalized),
  };
};

const pickIssueDate = (idx) => {
  const candidates = idx.lines.filter((l) => /\bdate\b/i.test(l.text) || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(l.text) || /\b\d{4}-\d{2}-\d{2}\b/.test(l.text));
  let best = null;
  let bestScore = -1e9;
  for (const l of candidates) {
    const t = l.text;
    const dateToken = t.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || t.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/)?.[0];
    const norm = normalizeDate(dateToken);
    if (!norm) continue;
    let score = 0;
    if (/\bdate\b/i.test(t)) score += 3;
    const top = l.box?.Top ?? 0.5;
    const left = l.box?.Left ?? 0.5;
    if (top < 0.30 && left > 0.50) score += 2; // common date location
    score += (safeLineConfidence(l) - 50) / 25;
    if (score > bestScore) {
      bestScore = score;
      best = { norm, line: l };
    }
  }
  if (!best) return { value: null, conf: 20 };
  return { value: best.norm, conf: Math.min(95, safeLineConfidence(best.line)) };
};

const pickAmountNumeric = (idx) => {
  const moneyRe = /\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\b/;
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
    if (/\$/.test(l.text)) score += 1;
    if (/routing|account|micr/i.test(l.text)) score -= 4;
    score += (safeLineConfidence(l) - 50) / 20;
    if (score > bestScore) {
      bestScore = score;
      best = { norm, line: l };
    }
  }
  if (!best) return { value: null, conf: 20 };
  return { value: best.norm, conf: Math.min(95, safeLineConfidence(best.line)) };
};

const wordsToNumber = (text) => {
  // Minimal deterministic converter for common check patterns:
  // "one thousand two hundred ten and 27/100"
  if (!text) return null;
  const raw = String(text).toLowerCase().replace(/[^a-z0-9\/\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const frac = raw.match(/\b(\d{1,2})\s*\/\s*100\b/);
  const cents = frac ? Number(frac[1]) : 0;
  const cleaned = raw.replace(/\b\d{1,2}\s*\/\s*100\b/g, '').replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  const SMALL = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const SCALE = { hundred: 100, thousand: 1000, million: 1000000 };
  let total = 0;
  let group = 0;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok in SMALL) {
      group += SMALL[tok];
      continue;
    }
    if (tok === 'hundred') {
      group = (group || 1) * 100;
      continue;
    }
    if (tok === 'thousand' || tok === 'million') {
      total += (group || 1) * SCALE[tok];
      group = 0;
      continue;
    }
    // Ignore "dollars" / "only" / etc.
    if (tok === 'dollars' || tok === 'dollar' || tok === 'only') continue;
    // If we hit something unknown, abort (avoid fabrication).
    return null;
  }
  const dollars = total + group;
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const final = dollars + (Number.isFinite(cents) ? cents / 100 : 0);
  return final.toFixed(2);
};

const pickAmountWritten = (idx) => {
  let best = null;
  let bestScore = -1e9;
  for (const l of idx.lines) {
    if (!/\bdollars?\b/i.test(l.text)) continue;
    // Prefer lines near middle-left (written amount line).
    const top = l.box?.Top ?? 0.5;
    const left = l.box?.Left ?? 0.5;
    let score = 0;
    if (top > 0.20 && top < 0.75 && left < 0.65) score += 2;
    score += (safeLineConfidence(l) - 50) / 25;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  if (!best) return { value: null, conf: 20 };
  const norm = wordsToNumber(best.text);
  return {
    value: norm,
    conf: norm ? Math.min(90, safeLineConfidence(best)) : 35,
    raw: best.text.slice(0, 200),
  };
};

const pickClaimNumber = (idx) => {
  const labelRe = /\b(claim|loss|file|policy|ref(?:erence)?)\b/i;
  let best = null;
  let bestScore = -1e9;
  for (const l of idx.lines) {
    if (!labelRe.test(l.text)) continue;
    // Extract token after label-ish punctuation.
    const m = l.text.match(/(?:claim|loss|file|policy|ref(?:erence)?)\s*(?:#|no\.?|number|:|\-)?\s*([A-Z0-9][A-Z0-9\-]{3,32})/i);
    const token = m ? m[1] : null;
    if (!token) continue;
    // Avoid accidentally grabbing routing/account sequences (pure long digits).
    if (/^\d{9,}$/.test(token)) continue;
    let score = 0;
    if (/claim/i.test(l.text)) score += 2;
    if (/loss|file|policy/i.test(l.text)) score += 1;
    // Prefer not in MICR bottom band.
    const top = l.box?.Top ?? 0.5;
    if (top < 0.85) score += 1;
    score += (safeLineConfidence(l) - 50) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = { token, line: l };
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
    score += (safeLineConfidence(l) - 50) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  if (!best) return { value: null, conf: 20 };
  return { value: toStandardCaps(best.text), conf: Math.min(80, safeLineConfidence(best)) };
};

const pickCheckNumber = (idx) => {
  const numericToken = (t) => {
    const m = String(t || '').match(/\b(\d{3,12})\b/);
    return m ? m[1] : null;
  };

  let best = null;
  let bestScore = -1e9;
  for (const l of idx.lines) {
    const token = l.text.match(/(?:check\s*(?:no|number|#)?[:\s-]*)(\d{3,12})/i)?.[1] || numericToken(l.text);
    if (!token) continue;
    // Avoid date tokens, routing number candidates, and obvious amount lines.
    if (normalizeDate(token)) continue;
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

const pickMicr = (idx) => {
  // MICR generally appears near the bottom; we use only deterministic digit heuristics.
  const bottomLines = idx.lines.filter((l) => (l.box?.Top ?? 0) > 0.78);
  let best = null;
  let bestDigits = '';
  for (const l of bottomLines) {
    const d = digitsOnly(l.text);
    if (d.length >= 15 && d.length > bestDigits.length) {
      bestDigits = d;
      best = l;
    }
  }
  if (!bestDigits) {
    // Still allow extracting a routing-only 9-digit run if present.
    for (const l of bottomLines) {
      const m = digitsOnly(l.text).match(/\b(\d{9})\b/);
      if (m) {
        const routing = m[1];
        return {
          routing_number: routing,
          account_number: null,
          micr_check_number: null,
          conf: Math.min(70, safeLineConfidence(l)),
        };
      }
    }
    return { routing_number: null, account_number: null, micr_check_number: null, conf: 10 };
  }

  // Heuristic parse: pick the first 9-digit run as routing; remainder as account+check.
  const routing = bestDigits.match(/(\d{9})/)?.[1] || null;
  let rest = routing ? bestDigits.replace(routing, '') : bestDigits;
  rest = rest.replace(/^0+/, rest.length > 10 ? '' : rest); // strip leading zeros only when long
  const account = rest.length >= 6 ? rest.slice(0, Math.min(17, rest.length)) : null;
  const micrCheck = rest.length >= 3 ? rest.slice(-Math.min(8, rest.length)) : null;
  return {
    routing_number: routing,
    account_number: account,
    micr_check_number: micrCheck,
    conf: Math.min(65, safeLineConfidence(best)),
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
    const threshold = CRITICAL_FIELDS.includes(k) ? CRITICAL_CONFIDENCE_THRESHOLD : 50;
    if (v < threshold) low.push(k);
  }

  const criticalMissing = CRITICAL_FIELDS.some((k) => fields[k] == null || String(fields[k]).trim() === '');
  const criticalLow = CRITICAL_FIELDS.some((k) => (fieldConfidence[k] ?? 0) < CRITICAL_CONFIDENCE_THRESHOLD);
  const overallLow = confidence < OVERALL_CONFIDENCE_THRESHOLD;
  const needsManualReview = criticalMissing || criticalLow || overallLow || low.includes('amount_disagreement');

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
    let c = null;
    for (const line of lines.slice(0, 8)) {
      if (/insurance|mutual|assurance|casualty|property|indemnity|underwriter/i.test(line)) { c = line; break; }
    }
    if (!c && lines[0] && /[A-Za-z]/.test(lines[0])) c = lines[0];
    return { value: toStandardCaps(c), conf: c ? 55 : 15 };
  })();

  const payee = isBlocks ? pickPayee(idx) : (() => {
    let payeeLine = null;
    const payIdx = lines.findIndex((l) => /pay\s+to\s+(?:the\s+order\s+of)?/i.test(l));
    if (payIdx >= 0 && lines[payIdx + 1]) payeeLine = lines[payIdx + 1];
    if (!payeeLine) {
      for (const line of lines) {
        if (/pay\s+to\s+(?:the\s+order\s+of)?/i.test(line)) continue;
        if (/dollars|void|memo|date|check/i.test(line)) continue;
        if (line.length >= 5 && /[A-Za-z]/.test(line)) { payeeLine = line; break; }
      }
    }
    return { value: toStandardCaps(payeeLine), conf: payeeLine ? 70 : 20, payees: splitPayees(payeeLine) };
  })();

  const checkNo = isBlocks ? pickCheckNumber(idx) : (() => {
    const m = text.match(/(?:check\s*(?:no|number|#)?[:\s-]*)([0-9]{3,12})/i) || text.match(/\b([0-9]{4,10})\b/);
    return { value: m ? m[1] : null, conf: m ? 65 : 20 };
  })();

  const date = isBlocks ? pickIssueDate(idx) : (() => {
    const m = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/) || text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    const norm = normalizeDate(m ? m[1] : null);
    return { value: norm, conf: norm ? 65 : 20 };
  })();

  const amt = isBlocks ? pickAmountNumeric(idx) : (() => {
    const m = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\b/);
    const norm = normalizeAmount(m ? m[1] : null);
    return { value: norm, conf: norm ? 70 : 20 };
  })();

  const written = isBlocks ? pickAmountWritten(idx) : { value: null, conf: 20, raw: null };
  const claim = isBlocks ? pickClaimNumber(idx) : (() => {
    const m = text.match(/(?:claim|clm)[#:\s-]*([A-Z0-9\-]{4,24})/i);
    return { value: m ? m[1] : null, conf: m ? 60 : 20 };
  })();

  const memo = isBlocks ? pickMemo(idx) : { value: null, conf: 20 };
  const bank = isBlocks ? pickBankName(idx, payee.value) : { value: null, conf: 20 };
  const micr = isBlocks ? pickMicr(idx) : (() => {
    const routingMatch = text.replace(/\s+/g, ' ').match(/\b([0-9]{9})\b/);
    return { routing_number: routingMatch ? routingMatch[1] : null, account_number: null, micr_check_number: null, conf: routingMatch ? 50 : 10 };
  })();

  // Amount disagreement rule: if both numeric+written exist and differ materially, flag review.
  let disagreement = false;
  if (amt.value && written.value && amt.value !== written.value) {
    disagreement = true;
  }

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
    routing_number__conf: micr.conf,
    account_number__conf: micr.conf != null ? Math.max(10, micr.conf - 10) : null,
    micr_check_number__conf: micr.conf != null ? Math.max(10, micr.conf - 10) : null,
    amount_disagreement__conf: disagreement ? 40 : 90,
    amount_disagreement: disagreement ? true : null,
  };

  const bundle = computeConfidenceBundle(fields);
  const low = new Set(bundle.low_confidence_fields || []);
  if (disagreement) low.add('amount'); // treat as amount confidence issue for UI

  return {
    carrier_name: toStandardCaps(fields.carrier_name),
    check_number: fields.check_number || null,
    amount: fields.amount || null,
    written_amount: fields.written_amount || null,
    issue_date: fields.issue_date || null,
    claim_number: fields.claim_number || null,
    detected_claim_number: fields.detected_claim_number || null,
    payee_line: toStandardCaps(fields.payee_line),
    routing_number: fields.routing_number || null,
    account_number: fields.account_number || null,
    micr_check_number: fields.micr_check_number || null,
    memo: toStandardCaps(fields.memo),
    bank_name: toStandardCaps(fields.bank_name),
    payees: Array.isArray(fields.payees) ? fields.payees : [],
    confidence: bundle.confidence,
    field_confidence: bundle.field_confidence,
    low_confidence_fields: Array.from(low),
    needs_manual_review: bundle.needs_manual_review || disagreement,
    // Helpers for safe logs/tests (do not add raw digits to logs)
    masked: {
      routing_number: maskDigits(fields.routing_number),
      account_number: maskDigits(fields.account_number),
      micr_check_number: maskDigits(fields.micr_check_number),
    },
  };
};
