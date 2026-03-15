/**
 * Harvey Memorial final letter cleanup — Regression Tests
 *
 * Validates that internal control text never appears in carrier-facing output.
 */
import { describe, it, expect } from 'vitest';

// ── Re-implement helpers inline so tests run without Deno edge-function env ──

const REQUIRED_LOW_SLOPE_OPENING = 'The engineering report attributes the water intrusion to snow/ice meltwater penetrating age-related and maintenance-deferred openings in the low-slope roof covering.';
const LOW_SLOPE_PRIMARY_SCENARIO = 'low_slope_snow_ice_ponding';

function dedupeRepeatedOpeningSentence(text: string, requiredOpening: string): string {
  if (!text || !requiredOpening) return text;
  const escaped = requiredOpening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'g');
  const matches = [...text.matchAll(regex)];
  if (matches.length <= 1) return text;
  let seen = false;
  return text.replace(regex, () => {
    if (seen) return '';
    seen = true;
    return requiredOpening;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

function cleanupEngineerLetterFormatting(text: string): string {
  if (!text) return text;
  let cleaned = text;
  const forbiddenLinePatterns: RegExp[] = [
    /^PRIORITY ORDER \(MANDATORY\):.*$/gim,
    /^SECTION 1 [—-] TIMING FAILURE:.*$/gim,
    /^SECTION 2 [—-] DRAINAGE\s*\/\s*SNOWMELT ANALYSIS FAILURE:.*$/gim,
    /^SECTION 3 [—-] ENGINEER CONTRADICTION:.*$/gim,
    /^STRUCTURAL VS WATERTIGHTNESS DISTINCTION:.*$/gim,
    /^STRUCTURAL VS MEMBRANE DISTINCTION:.*$/gim,
    /^LOW-SLOPE MEMBRANE METHODOLOGY FAILURES \(MANDATORY\):.*$/gim,
    /^LOW_SLOPE_MEMBRANE.*$/gim,
    /^HARD ASSERTION.*$/gim,
    /^primaryScenario=.*$/gim,
    /^rule_pack=.*$/gim,
    /^rulePackLoaded=.*$/gim,
    /^suppressed_rule_packs=.*$/gim,
    /^suppressedRulePacks=.*$/gim,
  ];
  for (const pattern of forbiddenLinePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.replace(/^- no membrane core cuts\s*$/gim, '');
  cleaned = cleaned.replace(/^- no seam adhesion\/peel testing\s*$/gim, '');
  cleaned = cleaned.replace(/^- no drainage-capacity analysis\s*$/gim, '');
  cleaned = cleaned.replace(/^- no snow-water equivalent\/runoff analysis\s*$/gim, '');
  cleaned = cleaned.replace(/^- no leak-path tracing\s*$/gim, '');
  cleaned = cleaned.replace(/^- no moisture mapping\s*$/gim, '');
  cleaned = cleaned.replace(/^- no proof of timing of openings\s*$/gim, '');
  cleaned = cleaned.replace(
    /(Dear\s+[^\n,]+,\s*)(The engineering report attributes the water intrusion to snow\/ice meltwater penetrating age-related and maintenance-deferred openings in the low-slope roof covering\.)/i,
    `$1\n\n$2`
  );
  cleaned = cleaned.replace(/\bN\.\s*J\.\s*A\.\s*C\.\s*/g, 'N.J.A.C. ');
  cleaned = cleaned.replace(/\bN\.\s*J\.\s*S\.\s*A\.\s*/g, 'N.J.S.A. ');
  cleaned = cleaned.replace(/(\d)\.\s+(\d)/g, '$1.$2');
  cleaned = cleaned.replace(/(\d)\s*-\s*inches\b/gi, '$1 inches');
  cleaned = cleaned.replace(/\b0\.\s+78\b/g, '0.78');
  cleaned = cleaned.replace(/\s+([,.;:])/g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = dedupeRepeatedOpeningSentence(cleaned, REQUIRED_LOW_SLOPE_OPENING);
  return cleaned.trim();
}

function enforceEngineerRebuttalLowSlopeOpening(result: string, primaryScenario: string | null): string {
  if (!result || primaryScenario !== LOW_SLOPE_PRIMARY_SCENARIO) return result;
  const required = REQUIRED_LOW_SLOPE_OPENING;
  const lines = result.split('\n');
  const headerLineRegex =
    /^(RE\s*:|Claim Number\s*:|Policy Number\s*:|Insured\s*:|Property Address\s*:|Date of Loss\s*:|Michael Carletta|Freedom Adjustment|March \d{1,2}, \d{4}|[A-Z][a-z]+ [A-Z][a-z]+$)/i;
  const salutationIdx = lines.findIndex((line) => /^\s*Dear\b/i.test(line));
  let bodyStartIdx = salutationIdx >= 0 ? salutationIdx + 1 : 0;
  while (bodyStartIdx < lines.length && (!lines[bodyStartIdx].trim() || headerLineRegex.test(lines[bodyStartIdx].trim()))) {
    bodyStartIdx++;
  }
  const bodySlice = lines.slice(bodyStartIdx, bodyStartIdx + 12).join('\n');
  if (bodySlice.includes(required)) return result;
  lines.splice(bodyStartIdx, 0, required);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function ensureLowSlopeOpeningAfterSalutation(text: string, primaryScenario: string | null): string {
  if (!text || primaryScenario !== LOW_SLOPE_PRIMARY_SCENARIO) return text;
  const required = REQUIRED_LOW_SLOPE_OPENING;
  if (!required) return text;
  const lines = text.split('\n');
  const salutationIdx = lines.findIndex((line) => /^\s*Dear\b/i.test(line));
  if (salutationIdx === -1) return enforceEngineerRebuttalLowSlopeOpening(text, primaryScenario);
  const afterSalutation = lines.slice(salutationIdx + 1).join('\n').trim();
  if (afterSalutation.startsWith(required)) return text;
  let rebuilt = text.replace(required, '').replace(/\n{3,}/g, '\n\n').trim();
  const rebuiltLines = rebuilt.split('\n');
  const rebuiltSalutationIdx = rebuiltLines.findIndex((line) => /^\s*Dear\b/i.test(line));
  if (rebuiltSalutationIdx === -1) return rebuilt;
  rebuiltLines.splice(rebuiltSalutationIdx + 1, 0, '', required);
  return rebuiltLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

    const cleaned = cleanupEngineerLetterFormatting(
      ensureLowSlopeOpeningAfterSalutation(raw, LOW_SLOPE_PRIMARY_SCENARIO)
    );

    expect(cleaned).toContain('Dear Mr. Swimmer,');
    expect(cleaned).toContain(REQUIRED_LOW_SLOPE_OPENING);

    const openingCount =
      (cleaned.match(new RegExp(REQUIRED_LOW_SLOPE_OPENING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

    expect(openingCount).toBe(1);
    expect(cleaned).not.toContain('PRIORITY ORDER (MANDATORY)');
    expect(cleaned).not.toContain('SECTION 1 — TIMING FAILURE:');
    expect(cleaned).not.toContain('STRUCTURAL VS WATERTIGHTNESS DISTINCTION:');
    expect(cleaned).toContain('N.J.A.C. 11:2-17.7');
    expect(cleaned).toContain('N.J.S.A. 17:29B-4(9)');
    expect(cleaned).toContain('0.78');
  });
});

describe('cleanupEngineerLetterFormatting', () => {
  it('removes LOW_SLOPE_MEMBRANE and rule_pack lines', () => {
    const input = `Some rebuttal text.\nLOW_SLOPE_MEMBRANE scenario active\nrule_pack=low_slope\nprimaryScenario=low_slope_snow_ice_ponding\nMore text.`;
    const cleaned = cleanupEngineerLetterFormatting(input);
    expect(cleaned).not.toContain('LOW_SLOPE_MEMBRANE');
    expect(cleaned).not.toContain('rule_pack=');
    expect(cleaned).not.toContain('primaryScenario=');
    expect(cleaned).toContain('Some rebuttal text.');
    expect(cleaned).toContain('More text.');
  });

  it('removes internal bullet remnants', () => {
    const input = `Analysis.\n- no membrane core cuts\n- no seam adhesion/peel testing\n- no leak-path tracing\nConclusion.`;
    const cleaned = cleanupEngineerLetterFormatting(input);
    expect(cleaned).not.toContain('- no membrane core cuts');
    expect(cleaned).not.toContain('- no seam adhesion/peel testing');
    expect(cleaned).not.toContain('- no leak-path tracing');
  });

  it('deduplicates opening sentence', () => {
    const input = `${REQUIRED_LOW_SLOPE_OPENING}\n\nSome text.\n\n${REQUIRED_LOW_SLOPE_OPENING}\n\nMore text.`;
    const cleaned = cleanupEngineerLetterFormatting(input);
    const count = (cleaned.match(new RegExp(REQUIRED_LOW_SLOPE_OPENING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    expect(count).toBe(1);
  });
});

describe('ensureLowSlopeOpeningAfterSalutation', () => {
  it('places opening after salutation when misplaced', () => {
    const input = `${REQUIRED_LOW_SLOPE_OPENING}\n\nDear Mr. Smith,\n\nSome other text.`;
    const result = ensureLowSlopeOpeningAfterSalutation(input, LOW_SLOPE_PRIMARY_SCENARIO);
    const lines = result.split('\n');
    const salIdx = lines.findIndex(l => /Dear/i.test(l));
    const afterSal = lines.slice(salIdx + 1).join('\n').trim();
    expect(afterSal.startsWith(REQUIRED_LOW_SLOPE_OPENING)).toBe(true);
  });
});
