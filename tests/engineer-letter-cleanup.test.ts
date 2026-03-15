/**
 * Harvey Memorial final letter cleanup — Regression Tests
 *
 * Validates that internal control text never appears in carrier-facing output.
 */
import { describe, it, expect } from 'vitest';

// ── Re-implement helpers inline so tests run without Deno edge-function env ──

const REQUIRED_LOW_SLOPE_OPENING = 'The engineering report attributes the water intrusion to snow/ice meltwater penetrating age-related and maintenance-deferred openings in the low-slope roof covering.';
const LOW_SLOPE_PRIMARY_SCENARIO = 'low_slope_snow_ice_ponding';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripInternalEngineerControlText(text: string): string {
  if (!text) return text;

  let cleaned = text;

  const patterns: RegExp[] = [
    /^PRIORITY ORDER \(MANDATORY\):.*$/gim,
    /^Do NOT prioritize wind mechanics\..*$/gim,
    /^SECTION 1 [—-] TIMING FAILURE:.*$/gim,
    /^SECTION 2 [—-] DRAINAGE\s*\/\s*SNOWMELT ANALYSIS FAILURE:.*$/gim,
    /^SECTION 3 [—-] ENGINEER CONTRADICTION:.*$/gim,
    /^STRUCTURAL VS WATERTIGHTNESS DISTINCTION:.*$/gim,
    /^STRUCTURAL VS MEMBRANE DISTINCTION:.*$/gim,
    /^LOW-SLOPE MEMBRANE METHODOLOGY FAILURES \(MANDATORY\):.*$/gim,
    /^LOW_SLOPE_MEMBRANE.*$/gim,
    /^HARD ASSERTION.*$/gim,
    /^primaryScenario=.*$/gim,
    /^rulePackLoaded=.*$/gim,
    /^rule_pack=.*$/gim,
    /^suppressedRulePacks=.*$/gim,
    /^suppressed_rule_packs=.*$/gim,
  ];

  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  cleaned = cleaned.replace(/^- no membrane core cuts\s*$/gim, '');
  cleaned = cleaned.replace(/^- no seam adhesion\/peel testing\s*$/gim, '');
  cleaned = cleaned.replace(/^- no drainage-capacity analysis\s*$/gim, '');
  cleaned = cleaned.replace(/^- no snow-water equivalent\/runoff analysis\s*$/gim, '');
  cleaned = cleaned.replace(/^- no leak-path tracing\s*$/gim, '');
  cleaned = cleaned.replace(/^- no moisture mapping\s*$/gim, '');
  cleaned = cleaned.replace(/^- no proof of timing of openings\s*$/gim, '');

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function dedupeRequiredLowSlopeOpening(text: string): string {
  if (!text || !REQUIRED_LOW_SLOPE_OPENING) return text;
  const escaped = escapeRegExp(REQUIRED_LOW_SLOPE_OPENING);
  const regex = new RegExp(escaped, 'g');
  const matches = text.match(regex);
  if (!matches || matches.length <= 1) return text;
  let seen = false;
  return text.replace(regex, () => {
    if (seen) return '';
    seen = true;
    return REQUIRED_LOW_SLOPE_OPENING;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeEngineerLetterFormatting(text: string): string {
  if (!text) return text;
  let cleaned = text;
  cleaned = cleaned.replace(/\bN\.\s*J\.\s*A\.\s*C\.\s*/g, 'N.J.A.C. ');
  cleaned = cleaned.replace(/\bN\.\s*J\.\s*S\.\s*A\.\s*/g, 'N.J.S.A. ');
  cleaned = cleaned.replace(/(\d)\.\s+(\d)/g, '$1.$2');
  cleaned = cleaned.replace(/\b0\.\s+78\b/g, '0.78');
  cleaned = cleaned.replace(/\b1\.\s+75\b/g, '1.75');
  cleaned = cleaned.replace(/\s+([,.;:])/g, '$1');
  cleaned = cleaned.replace(/\bBEFORE\b/g, 'before');
  cleaned = cleaned.replace(/\bCAUSED\/ACTIVATED\b/g, 'caused or activated');
  cleaned = cleaned.replace(/\bNO objective basis\b/g, 'no objective basis');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = dedupeRequiredLowSlopeOpening(cleaned);
  return cleaned.trim();
}

function findEngineerLetterBodyStart(lines: string[]): number {
  const headerRegex =
    /^(RE\s*:|Claim Number\s*:|Policy Number\s*:|Insured\s*:|Property Address\s*:|Date of Loss\s*:|Michael Carletta|Freedom Adjustment|[A-Z][a-z]+ \d{1,2}, \d{4}|[A-Z][a-z]+ [A-Z][a-z]+,?\s*(Public Adjuster)?|Church Mutual Insurance Company|3000 Schuster Lane|Merrill, Wisconsin)/i;
  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    if (!trimmed || headerRegex.test(trimmed)) { idx += 1; continue; }
    break;
  }
  return idx;
}

function enforceEngineerRebuttalLowSlopeOpening(result: string, primaryScenario: string | null): string {
  if (!result || primaryScenario !== LOW_SLOPE_PRIMARY_SCENARIO) return result;
  const required = REQUIRED_LOW_SLOPE_OPENING;
  if (!required) return result;
  const lines = result.split('\n');
  const salutationIdx = lines.findIndex((line) => /^\s*Dear\b/i.test(line));
  if (salutationIdx >= 0) {
    const afterSalutation = lines.slice(salutationIdx + 1).join('\n');
    if (afterSalutation.includes(required)) return result;
    const stripped = result.replace(required, '').replace(/\n{3,}/g, '\n\n').trim();
    const rebuilt = stripped.split('\n');
    const rebuiltSalutationIdx = rebuilt.findIndex((line) => /^\s*Dear\b/i.test(line));
    if (rebuiltSalutationIdx >= 0) {
      rebuilt.splice(rebuiltSalutationIdx + 1, 0, '', required, '');
      return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  const stripped = result.replace(required, '').replace(/\n{3,}/g, '\n\n').trim();
  const rebuilt = stripped.split('\n');
  const bodyStartIdx = findEngineerLetterBodyStart(rebuilt);
  rebuilt.splice(bodyStartIdx, 0, required, '');
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function placeLowSlopeOpeningCorrectly(text: string, primaryScenario: string | null): string {
  if (!text || primaryScenario !== LOW_SLOPE_PRIMARY_SCENARIO) return text;
  let updated = dedupeRequiredLowSlopeOpening(text);
  const lines = updated.split('\n');
  const salutationIdx = lines.findIndex((line) => /^\s*Dear\b/i.test(line));
  if (salutationIdx >= 0) {
    const afterSalutation = lines.slice(salutationIdx + 1).join('\n');
    if (afterSalutation.includes(REQUIRED_LOW_SLOPE_OPENING)) {
      return updated.replace(/\n{3,}/g, '\n\n').trim();
    }
    updated = updated.replace(REQUIRED_LOW_SLOPE_OPENING, '').replace(/\n{3,}/g, '\n\n').trim();
    const rebuilt = updated.split('\n');
    const rebuiltSalutationIdx = rebuilt.findIndex((line) => /^\s*Dear\b/i.test(line));
    if (rebuiltSalutationIdx >= 0) {
      rebuilt.splice(rebuiltSalutationIdx + 1, 0, '', REQUIRED_LOW_SLOPE_OPENING, '');
      return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  updated = updated.replace(REQUIRED_LOW_SLOPE_OPENING, '').replace(/\n{3,}/g, '\n\n').trim();
  const rebuilt = updated.split('\n');
  const bodyStartIdx = findEngineerLetterBodyStart(rebuilt);
  rebuilt.splice(bodyStartIdx, 0, REQUIRED_LOW_SLOPE_OPENING, '');
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hasEngineerInternalControlLeak(text: string): boolean {
  if (!text) return false;
  return [
    'PRIORITY ORDER (MANDATORY)',
    'SECTION 1 — TIMING FAILURE:',
    'SECTION 2 — DRAINAGE / SNOWMELT ANALYSIS FAILURE:',
    'SECTION 3 — ENGINEER CONTRADICTION:',
    'STRUCTURAL VS WATERTIGHTNESS DISTINCTION:',
    'LOW_SLOPE_MEMBRANE',
    'rule_pack=',
    'primaryScenario=',
    'suppressed_rule_packs=',
  ].some((token) => text.includes(token));
}

// Combined cleanup pipeline
function cleanFinalEngineerOutput(text: string, primaryScenario: string | null): string {
  let result = placeLowSlopeOpeningCorrectly(text, primaryScenario);
  result = stripInternalEngineerControlText(result);
  result = dedupeRequiredLowSlopeOpening(result);
  result = normalizeEngineerLetterFormatting(result);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Harvey Memorial final letter cleanup', () => {
  it('removes internal control text and keeps a clean salutation/body structure', () => {
    const raw = `Michael Carletta, Public Adjuster
Freedom Adjustment

RE: Rebuttal to Engineering Report
Claim Number: 000-01-311816
Policy Number: 0308651-02-964235
Insured: Harvey Memorial United Methodist Church
Property Address: 1120 Arnold Ave, Point Pleasant Boro, NJ, 08742
Date of Loss: 2026-01-25
The engineering report attributes the water intrusion to snow/ice meltwater penetrating age-related and maintenance-deferred openings in the low-slope roof covering. Dear Mr. Swimmer,

The engineering report attributes the water intrusion to snow/ice meltwater penetrating age-related and maintenance-deferred openings in the low-slope roof covering.

PRIORITY ORDER (MANDATORY):
1) timing of openings
2) missing membrane testing
3) drainage/snowmelt mechanics
4) contradiction in engineer reasoning
Do NOT prioritize wind mechanics.

SECTION 1 — TIMING FAILURE:
The report asserts openings developed over months or years but provides no objective testing that proves timing.

STRUCTURAL VS WATERTIGHTNESS DISTINCTION:
Structural snow-load analysis is not membrane watertightness analysis. Even if framing can carry snow load, that does not prove membrane watertightness or entry-path causation.

N. J. A. C. 11:2-17.7 and N. J. S. A. 17:29B-4(9) apply.
0. 78-inches of rain was noted.`;

    const cleaned = cleanFinalEngineerOutput(raw, LOW_SLOPE_PRIMARY_SCENARIO);

    expect(cleaned).toContain('Dear Mr. Swimmer,');
    expect(cleaned).toContain(REQUIRED_LOW_SLOPE_OPENING);

    const openingCount =
      (cleaned.match(new RegExp(escapeRegExp(REQUIRED_LOW_SLOPE_OPENING), 'g')) || []).length;

    expect(openingCount).toBe(1);
    expect(cleaned).not.toContain('PRIORITY ORDER (MANDATORY)');
    expect(cleaned).not.toContain('SECTION 1 — TIMING FAILURE:');
    expect(cleaned).not.toContain('STRUCTURAL VS WATERTIGHTNESS DISTINCTION:');
    expect(cleaned).not.toContain('Do NOT prioritize wind mechanics');
    expect(cleaned).toContain('N.J.A.C. 11:2-17.7');
    expect(cleaned).toContain('N.J.S.A. 17:29B-4(9)');
    expect(cleaned).toContain('0.78');
  });
});

describe('stripInternalEngineerControlText', () => {
  it('removes LOW_SLOPE_MEMBRANE and rule_pack lines', () => {
    const input = `Some rebuttal text.\nLOW_SLOPE_MEMBRANE scenario active\nrule_pack=low_slope\nprimaryScenario=low_slope_snow_ice_ponding\nMore text.`;
    const cleaned = stripInternalEngineerControlText(input);
    expect(cleaned).not.toContain('LOW_SLOPE_MEMBRANE');
    expect(cleaned).not.toContain('rule_pack=');
    expect(cleaned).not.toContain('primaryScenario=');
    expect(cleaned).toContain('Some rebuttal text.');
    expect(cleaned).toContain('More text.');
  });

  it('removes internal bullet remnants', () => {
    const input = `Analysis.\n- no membrane core cuts\n- no seam adhesion/peel testing\n- no leak-path tracing\nConclusion.`;
    const cleaned = stripInternalEngineerControlText(input);
    expect(cleaned).not.toContain('- no membrane core cuts');
    expect(cleaned).not.toContain('- no seam adhesion/peel testing');
    expect(cleaned).not.toContain('- no leak-path tracing');
  });
});

describe('dedupeRequiredLowSlopeOpening', () => {
  it('deduplicates opening sentence', () => {
    const input = `${REQUIRED_LOW_SLOPE_OPENING}\n\nSome text.\n\n${REQUIRED_LOW_SLOPE_OPENING}\n\nMore text.`;
    const cleaned = dedupeRequiredLowSlopeOpening(input);
    const count = (cleaned.match(new RegExp(escapeRegExp(REQUIRED_LOW_SLOPE_OPENING), 'g')) || []).length;
    expect(count).toBe(1);
  });
});

describe('placeLowSlopeOpeningCorrectly', () => {
  it('places opening after salutation when misplaced before it', () => {
    const input = `${REQUIRED_LOW_SLOPE_OPENING}\n\nDear Mr. Smith,\n\nSome other text.`;
    const result = placeLowSlopeOpeningCorrectly(input, LOW_SLOPE_PRIMARY_SCENARIO);
    const lines = result.split('\n');
    const salIdx = lines.findIndex(l => /Dear/i.test(l));
    const afterSal = lines.slice(salIdx + 1).join('\n').trim();
    expect(afterSal.startsWith(REQUIRED_LOW_SLOPE_OPENING)).toBe(true);
  });
});

describe('normalizeEngineerLetterFormatting', () => {
  it('normalizes statute spacing and decimals', () => {
    const input = `N. J. A. C. 11:2-17.7 and N. J. S. A. 17:29B-4(9) apply.\n0. 78-inches of rain.`;
    const cleaned = normalizeEngineerLetterFormatting(input);
    expect(cleaned).toContain('N.J.A.C. 11:2-17.7');
    expect(cleaned).toContain('N.J.S.A. 17:29B-4(9)');
    expect(cleaned).toContain('0.78');
  });

  it('tones down leaked all-caps emphasis', () => {
    const input = `The damage occurred BEFORE the inspection. There is NO objective basis for denial.`;
    const cleaned = normalizeEngineerLetterFormatting(input);
    expect(cleaned).toContain('before');
    expect(cleaned).toContain('no objective basis');
    expect(cleaned).not.toContain('BEFORE');
    expect(cleaned).not.toContain('NO objective basis');
  });
});

describe('hasEngineerInternalControlLeak', () => {
  it('detects leaked control tokens', () => {
    expect(hasEngineerInternalControlLeak('Some text PRIORITY ORDER (MANDATORY) here')).toBe(true);
    expect(hasEngineerInternalControlLeak('rule_pack=low_slope')).toBe(true);
    expect(hasEngineerInternalControlLeak('Clean professional text only.')).toBe(false);
  });
});
