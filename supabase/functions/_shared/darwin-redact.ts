/**
 * Redaction for public-facing content: remove PII and claim identifiers.
 * Use before saving case studies or marketing assets.
 */

const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Emails
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[email redacted]' },
  // Phone (US-style and generic)
  { pattern: /\b(\+?1?[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g, replacement: '[phone redacted]' },
  // Claim numbers (common formats: CLM-12345, #12345678, Claim No. 12345)
  { pattern: /\b(?:claim\s*(?:#|no\.?|number:?)\s*)?[A-Z0-9-]{6,20}\b/gi, replacement: '[claim number redacted]' },
  // Policy numbers
  { pattern: /\b(?:policy\s*(?:#|no\.?|number:?)\s*)?[A-Z0-9-]{8,25}\b/gi, replacement: '[policy number redacted]' },
  // Addresses (simple: number + street + optional suite/apt)
  { pattern: /\b\d+\s+[\w\s]+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|blvd|boulevard)\b[^.]*\.?/gi, replacement: '[address redacted]' },
  // SSN last four
  { pattern: /\b(?:ssn|social\s*security)[\s:-]*\*?\d{4}\b/gi, replacement: '[SSN redacted]' },
  // Names (heuristic: Title Case 2–4 words; avoid mid-sentence)
  // We do this last and conservatively to avoid over-redacting
];

// More aggressive: replace known field labels + following value
const LABEL_VALUE_PAIRS = [
  { label: /(?:adjuster|carrier\s*rep)\s*name\s*[:=]\s*/gi, replacement: 'Adjuster: [redacted] ' },
  { label: /(?:policyholder|insured)\s*name\s*[:=]\s*/gi, replacement: 'Insured: [redacted] ' },
  { label: /(?:claimant|client)\s*name\s*[:=]\s*/gi, replacement: 'Claimant: [redacted] ' },
  { label: /(?:carrier\s*claim\s*id|claim\s*id)\s*[:=]\s*/gi, replacement: 'Claim ID: [redacted] ' },
];

export function redactForPublic(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  for (const { label, replacement } of LABEL_VALUE_PAIRS) {
    out = out.replace(label, replacement);
  }
  return out;
}

export function redactionReport(original: string, redacted: string): { redacted: boolean; notes: string } {
  const hadEmail = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(original);
  const hadPhone = /\b(\+?1?[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/.test(original);
  const hadClaimNum = /\b(?:claim\s*(?:#|no\.?|number:?)\s*)?[A-Z0-9-]{6,20}\b/i.test(original);
  const changed = original !== redacted;
  const notes: string[] = [];
  if (hadEmail) notes.push('emails');
  if (hadPhone) notes.push('phones');
  if (hadClaimNum) notes.push('claim/policy identifiers');
  if (changed && notes.length === 0) notes.push('other identifiers');
  return {
    redacted: changed,
    notes: notes.length ? `Redacted: ${notes.join(', ')}` : 'No PII detected',
  };
}
