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

// ═══════════════════════════════════════════════════════════════════════════
// Engineer rebuttal required-testing post-processing
// ═══════════════════════════════════════════════════════════════════════════

interface EngineerRebuttalEnforcementContext {
  engineerStatedCause: string;
  engineerTheorySentences: string[];
  primaryScenario: string | null;
  secondaryScenarios?: string[];
  criticalTestingNotPerformed: string[];
  reportText: string;
}

function isTestMentionedInReportTest(reportText: string, testName: string): boolean {
  const text = String(reportText || "");
  const textLower = text.toLowerCase();
  if (!textLower) return false;

  const normalizedTest = String(testName || "").toLowerCase().trim();
  if (!normalizedTest) return false;

  const negativeContextPatterns = [
    new RegExp(`no\\s+${escapeRegExp(normalizedTest)}`, "i"),
    new RegExp(`not\\s+performed[^\\n.]{0,40}${escapeRegExp(normalizedTest)}`, "i"),
    new RegExp(`${escapeRegExp(normalizedTest)}[^\\n.]{0,40}not\\s+performed`, "i"),
    new RegExp(`failed\\s+to\\s+perform[^\\n.]{0,40}${escapeRegExp(normalizedTest)}`, "i"),
    new RegExp(`without[^\\n.]{0,40}${escapeRegExp(normalizedTest)}`, "i"),
    new RegExp(`did\\s+not\\s+perform[^\\n.]{0,40}${escapeRegExp(normalizedTest)}`, "i"),
    new RegExp(`omitted[^\\n.]{0,40}${escapeRegExp(normalizedTest)}`, "i"),
    new RegExp(`missing[^\\n.]{0,40}${escapeRegExp(normalizedTest)}`, "i"),
  ];

  if (textLower.includes(normalizedTest)) {
    const exactNegative = negativeContextPatterns.some((pattern) => pattern.test(text));
    if (!exactNegative) return true;
  }

  const ignoredTokens = new Set([
    "analysis", "testing", "review", "inspection", "proof",
    "assessment", "evaluation", "performed", "perform",
  ]);

  const tokens = normalizedTest
    .split(/[\s/()\-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !ignoredTokens.has(token));

  if (tokens.length === 0) return false;

  const tokenHits = tokens.filter((token) => textLower.includes(token));
  if (tokenHits.length === 0) return false;

  const tokenNegative = tokenHits.some((token) => {
    const tokenEscaped = escapeRegExp(token);
    return [
      new RegExp(`no[^\\n.]{0,30}${tokenEscaped}`, "i"),
      new RegExp(`not\\s+performed[^\\n.]{0,30}${tokenEscaped}`, "i"),
      new RegExp(`failed\\s+to\\s+perform[^\\n.]{0,30}${tokenEscaped}`, "i"),
      new RegExp(`did\\s+not\\s+perform[^\\n.]{0,30}${tokenEscaped}`, "i"),
      new RegExp(`without[^\\n.]{0,30}${tokenEscaped}`, "i"),
      new RegExp(`missing[^\\n.]{0,30}${tokenEscaped}`, "i"),
      new RegExp(`omitted[^\\n.]{0,30}${tokenEscaped}`, "i"),
    ].some((pattern) => pattern.test(text));
  });

  return !tokenNegative;
}

function buildRequiredTestingNotPerformedSectionTest(reportText: string, requiredTests: string[]): string {
  const lines = requiredTests.map((testName) => {
    const appearsInReport = isTestMentionedInReportTest(reportText, testName);
    return `- ${testName}: ${
      appearsInReport
        ? "Mentioned in report text, but not confirmed as actually performed"
        : "Not documented in report"
    }`;
  });

  return `Required Testing Not Performed\n\nThe following forensic testing is required to scientifically prove the engineer's causation theory. Mere discussion of a testing concept is not proof that the test was actually performed or that it produced objective findings.\n\n${lines.join("\n")}`;
}

function buildEngineerTheoryExtractionSectionTest(context: EngineerRebuttalEnforcementContext): string {
  const quotedCause = String(
    context.engineerStatedCause
    || context.engineerTheorySentences?.[0]
    || 'No explicit engineer causation sentence was extracted from the report.'
  ).trim();

  return `Engineer Theory Extraction\nEngineer-stated cause (direct quote from report):\n"${quotedCause}"`;
}

function buildTimingFailureSectionTest(primaryScenario: string | null, engineerCause: string): string {
  const universalStatement = 'The report attempts to assign a pre-existing timeline to the observed condition without employing any forensic method capable of establishing when the relevant opening, breach, displacement, or failure actually occurred.';
  let scenarioSpecific = '';
  switch (primaryScenario) {
    case 'low_slope_snow_ice_ponding':
      scenarioSpecific = 'Specifically, the report provides no membrane core cuts, seam adhesion testing, moisture mapping, or leak-path tracing that could establish when the membrane openings developed.';
      break;
    default:
      scenarioSpecific = 'No forensic timeline analysis was performed to establish when the observed conditions developed relative to the loss event.';
  }
  return `Timing Failure\n\n${universalStatement}\n\n${scenarioSpecific}\n\nEngineer stated cause: "${engineerCause || 'No explicit causation statement extracted.'}"`;
}

function buildEngineerContradictionSectionTest(primaryScenario: string | null, engineerTheorySentences: string[]): string {
  const quotedSentences = engineerTheorySentences.length > 0
    ? engineerTheorySentences.map((s) => `"${s}"`).join('\n')
    : '"No specific engineer theory sentences extracted."';
  let scenarioContradiction = '';
  if (primaryScenario === 'low_slope_snow_ice_ponding') {
    scenarioContradiction = 'If the report acknowledges snow accumulation, drainage impedance, standing water, freeze-thaw stress, or elevated watertightness demand, it cannot logically conclude deterioration alone caused the loss without objective testing proving the event did not create, activate, or expand the openings.';
  } else {
    scenarioContradiction = 'If the report acknowledges event conditions yet denies the event role, it contradicts itself unless objective testing proves the event had no causal contribution.';
  }
  return `Internal Contradictions\n\nThe following engineer theory statements are evaluated for internal consistency:\n${quotedSentences}\n\n${scenarioContradiction}`;
}

function buildEngineerMustAnswerQuestionsTest(primaryScenario: string | null): string[] {
  switch (primaryScenario) {
    case 'low_slope_snow_ice_ponding':
      return [
        'What testing established the timing of the alleged membrane openings?',
        'What membrane core cuts were taken and what did they show?',
        'What seam adhesion or peel testing was performed?',
        'What drainage-capacity analysis was performed?',
        'What snow-water equivalent or runoff-path analysis was performed?',
        'What leak-path tracing was performed from roof entry to interior manifestation?',
        'What objective testing proves deterioration alone caused the loss rather than the snow/ice event activating or expanding the openings?',
        'How did the engineer distinguish structural load adequacy from membrane watertightness performance?',
      ];
    default:
      return [
        'What objective testing was performed to establish the timing of the alleged condition?',
        'What forensic methodology was used to separate pre-existing vulnerability from event-driven damage?',
        'What alternative causes were considered and how were they ruled out?',
        'What measurements, samples, or quantifiable data support the stated conclusion?',
        'What industry-standard testing protocols applicable to this loss type were followed?',
      ];
  }
}

function enforceEngineerRebuttalMandatorySectionsTest(
  result: string,
  context: EngineerRebuttalEnforcementContext
): string {
  if (!result) return result;

  let updated = result.trim();
  const additions: string[] = [];

  const hasEngineerTheoryExtraction = /(^|\n)engineer theory extraction\b/i.test(updated);
  const hasTimingFailure = /(^|\n)timing failure\b/i.test(updated);
  const hasRequiredTesting = /(^|\n)required testing not performed\b/i.test(updated);
  const hasCausationProofFailure = /(^|\n)causation proof failure\b/i.test(updated);
  const hasInternalContradictions = /(^|\n)internal contradictions\b/i.test(updated);
  const hasQuestionsEngineerMustAnswer = /(^|\n)questions the engineer must answer\b/i.test(updated);

  if (!hasEngineerTheoryExtraction) {
    additions.push(buildEngineerTheoryExtractionSectionTest(context));
  }
  if (!hasTimingFailure) {
    additions.push(buildTimingFailureSectionTest(context.primaryScenario, context.engineerStatedCause));
  }
  if (!hasRequiredTesting) {
    additions.push(buildRequiredTestingNotPerformedSectionTest(context.reportText, context.criticalTestingNotPerformed));
  }
  if (!hasCausationProofFailure) {
    additions.push('Causation Proof Failure\n\nCondition evidence is not causation proof.');
  }
  if (!hasInternalContradictions) {
    additions.push(buildEngineerContradictionSectionTest(context.primaryScenario, context.engineerTheorySentences));
  }
  if (!hasQuestionsEngineerMustAnswer) {
    const questions = buildEngineerMustAnswerQuestionsTest(context.primaryScenario);
    additions.push(`Questions the Engineer Must Answer\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }

  if (additions.length > 0) {
    updated += `\n\n${additions.join('\n\n')}`;
  }

  return updated.trim();
}

describe("Engineer rebuttal required-testing post-processing", () => {
  const context: EngineerRebuttalEnforcementContext = {
    engineerStatedCause:
      "The water infiltration was the result of snow/ice meltwater that penetrated age-related and maintenance-deferred openings.",
    engineerTheorySentences: [
      "The water infiltration was the result of snow/ice meltwater that penetrated age-related and maintenance-deferred openings."
    ],
    primaryScenario: "low_slope_snow_ice_ponding",
    criticalTestingNotPerformed: [
      "membrane core cuts",
      "seam adhesion/peel testing",
      "drainage-capacity analysis",
      "snow-water equivalent/runoff analysis",
      "leak-path tracing",
      "moisture mapping",
      "proof of timing of openings",
    ],
    reportText: `
      The engineer visually observed weathered cap sheets and cracked sealants.
      No membrane core cuts were performed.
      No seam adhesion or peel testing was performed.
      No drainage-capacity analysis was performed.
      No snow-water equivalent analysis was performed.
      No leak-path tracing was performed.
      No moisture mapping was performed.
      The report states these openings developed over many months to years.
    `,
  };

  it("does not mark omitted tests as appearing in the report just because they are mentioned negatively", () => {
    const section = buildRequiredTestingNotPerformedSectionTest(context.reportText, context.criticalTestingNotPerformed);

    expect(section).toContain("membrane core cuts: Not documented in report");
    expect(section).toContain("seam adhesion/peel testing: Not documented in report");
    expect(section).toContain("drainage-capacity analysis: Not documented in report");
    expect(section).not.toContain("Appears in report");
  });

  it("does not append duplicate Required Testing section when already present", () => {
    const existing = `
Engineer Theory Extraction

Some content.

Required Testing Not Performed

Already written section here.

Causation Proof Failure

Already written section here.
`;

    const result = enforceEngineerRebuttalMandatorySectionsTest(existing, context);

    const matches = result.match(/Required Testing Not Performed/g) || [];
    expect(matches.length).toBe(1);
  });

  it("does not append duplicate Causation Proof Failure when already present", () => {
    const existing = `
Engineer Theory Extraction

Some content.

Required Testing Not Performed

Already written section here.

Causation Proof Failure

Already written section here.
`;

    const result = enforceEngineerRebuttalMandatorySectionsTest(existing, context);

    const matches = result.match(/Causation Proof Failure/g) || [];
    expect(matches.length).toBe(1);
  });
});
