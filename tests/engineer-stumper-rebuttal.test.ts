/**
 * Engineer Stumper Rebuttal — Regression Tests
 *
 * These tests validate the helper functions and post-processing enforcement
 * for the forensic "Engineer Stumper" mode. They do NOT call the AI model;
 * they test deterministic logic only.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Re-implement the helpers inline so tests run without Deno edge-function env
// ---------------------------------------------------------------------------

const LOW_SLOPE_PRIMARY_SCENARIO = 'low_slope_snow_ice_ponding';

function buildEngineerMustAnswerQuestions(primaryScenario: string | null): string[] {
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
    case 'wind_uplift':
      return [
        'What hand-tab, seal integrity, or comparable bond testing was performed?',
        'What fastener pattern review or deck attachment inspection was performed?',
        'What slope-by-slope directional wind analysis was performed?',
        'What testing ruled out event-driven seal failure?',
        'What objective method was used to date the alleged wear versus storm-caused displacement?',
      ];
    case 'hail_impact':
      return [
        'What test squares were performed on each slope?',
        'What soft-metal collateral evidence was documented?',
        'What method differentiated functional damage from cosmetic damage?',
        'What testing ruled out hail-caused mat fracture?',
        'What random versus pattern analysis was performed to distinguish hail from other impact sources?',
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

function buildTimingFailureSection(primaryScenario: string | null, engineerCause: string): string {
  const universalStatement = 'The report attempts to assign a pre-existing timeline to the observed condition without employing any forensic method capable of establishing when the relevant opening, breach, displacement, or failure actually occurred.';
  let scenarioSpecific = '';
  switch (primaryScenario) {
    case 'low_slope_snow_ice_ponding':
      scenarioSpecific = 'Specifically, the report provides no membrane core cuts, seam adhesion testing, moisture mapping, or leak-path tracing that could establish when the membrane openings developed.';
      break;
    case 'wind_uplift':
      scenarioSpecific = 'The report provides no seal adhesion testing, fastener withdrawal testing, or pre-loss condition documentation that could establish whether seal failure, displacement, or uplift-related distress existed before the wind event.';
      break;
    default:
      scenarioSpecific = 'No forensic timeline analysis was performed to establish when the observed conditions developed relative to the loss event.';
  }
  return `Timing Failure\n\n${universalStatement}\n\n${scenarioSpecific}\n\nEngineer stated cause: "${engineerCause || 'No explicit causation statement extracted.'}"`;
}

function buildCausationProofFailureSectionStumper(primaryScenario: string | null, missingTests: string[]): string {
  const missingList = missingTests.map((t) => `- ${t}`).join('\n');
  return `Causation Proof Failure\n\nCondition evidence is not causation proof.\n\nWithout the testing necessary to separate pre-existing vulnerability from event-driven failure, the report does not establish sole causation to a reasonable degree of engineering certainty.\n\n${missingTests.length > 0 ? `The following ${missingTests.length} required forensic test(s) are not documented in the report, rendering the causation opinion speculative:\n${missingList}` : ''}\n\nThe report did not scientifically prove sole causation.`;
}

function buildEngineerContradictionSection(primaryScenario: string | null, engineerTheorySentences: string[]): string {
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

// Simplified enforcer for testing
const LOW_SLOPE_FORBIDDEN_TERMS = ['shingle', 'uplift', 'ARMA', 'seal strip', 'fastener pull-out', 'unsealed tabs'];

interface EnforcementContext {
  engineerStatedCause: string;
  engineerTheorySentences: string[];
  primaryScenario: string | null;
  criticalTestingNotPerformed: string[];
  reportText: string;
}

function enforceEngineerRebuttalMandatorySections(result: string, context: EnforcementContext): string {
  if (!result) return result;
  let updated = result.trim();
  const lower = updated.toLowerCase();
  const additions: string[] = [];

  if (!/engineer theory extraction/i.test(lower)) {
    additions.push(`Engineer Theory Extraction\nEngineer-stated cause (direct quote from report):\n"${context.engineerStatedCause || 'No explicit engineer causation sentence was extracted from the report.'}"`);
  }
  if (!/timing failure/i.test(lower)) {
    additions.push(buildTimingFailureSection(context.primaryScenario, context.engineerStatedCause));
  }
  if (!/required testing not performed/i.test(lower)) {
    additions.push(`Required Testing Not Performed\nThe following forensic testing is required:\n${context.criticalTestingNotPerformed.map(t => `- ${t}`).join('\n')}`);
  }
  if (!/causation proof failure/i.test(lower)) {
    additions.push(buildCausationProofFailureSectionStumper(context.primaryScenario, context.criticalTestingNotPerformed));
  }
  if (!/internal contradictions/i.test(lower)) {
    additions.push(buildEngineerContradictionSection(context.primaryScenario, context.engineerTheorySentences));
  }
  if (!/questions the engineer must answer/i.test(lower)) {
    const questions = buildEngineerMustAnswerQuestions(context.primaryScenario);
    additions.push(`Questions the Engineer Must Answer\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
  }
  if (additions.length > 0) {
    updated += `\n\n${additions.join('\n\n')}`;
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. LOW-SLOPE CASE
// ═══════════════════════════════════════════════════════════════════════════
describe('Low-slope engineer rebuttal enforcement', () => {
  const lowSlopeContext: EnforcementContext = {
    engineerStatedCause: 'long-term deterioration of the membrane system and deferred maintenance of the drainage system',
    engineerTheorySentences: [
      'The observed damage is the result of long-term deterioration of the membrane system.',
      'The ponding water and snowmelt infiltration are consequences of inadequate slope and clogged drains.',
    ],
    primaryScenario: LOW_SLOPE_PRIMARY_SCENARIO,
    criticalTestingNotPerformed: ['membrane core cuts', 'seam adhesion/peel testing', 'drainage-capacity analysis', 'leak-path tracing'],
    reportText: 'The membrane system exhibited ponding water. Snow load accumulation was significant. The wind damage to the parapet cap is incidental.',
  };

  it('appends all missing sections when model output is empty-ish', () => {
    const result = enforceEngineerRebuttalMandatorySections('This is a basic rebuttal with no required sections.', lowSlopeContext);
    expect(result).toContain('Engineer Theory Extraction');
    expect(result).toContain('Timing Failure');
    expect(result).toContain('Required Testing Not Performed');
    expect(result).toContain('Causation Proof Failure');
    expect(result).toContain('Internal Contradictions');
    expect(result).toContain('Questions the Engineer Must Answer');
  });

  it('includes low-slope-specific questions', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic output.', lowSlopeContext);
    expect(result).toContain('What membrane core cuts were taken');
    expect(result).toContain('What seam adhesion or peel testing was performed');
    expect(result).toContain('What drainage-capacity analysis was performed');
    expect(result).toContain('structural load adequacy from membrane watertightness');
  });

  it('does NOT include wind-specific questions', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic output.', lowSlopeContext);
    expect(result).not.toContain('hand-tab');
    expect(result).not.toContain('fastener pattern review');
    expect(result).not.toContain('seal failure');
  });

  it('includes timing failure with low-slope-specific language', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic output.', lowSlopeContext);
    expect(result).toContain('membrane openings developed');
    expect(result).toContain('freeze-thaw');
  });

  it('includes causation proof failure with required statement', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic output.', lowSlopeContext);
    expect(result).toContain('Condition evidence is not causation proof');
    expect(result).toContain('does not establish sole causation to a reasonable degree of engineering certainty');
  });

  it('includes contradiction section with low-slope-specific language', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic output.', lowSlopeContext);
    expect(result).toContain('snow accumulation');
    expect(result).toContain('drainage impedance');
    expect(result).toContain('cannot logically conclude deterioration alone');
  });

  it('does not duplicate sections already present', () => {
    const existingResult = 'Engineer Theory Extraction\nSome content.\n\nTiming Failure\nSome content.\n\nRequired Testing Not Performed\nSome content.\n\nCausation Proof Failure\nCondition evidence is not causation proof.\nDoes not establish sole causation to a reasonable degree of engineering certainty.\n\nInternal Contradictions\nSome content.\n\nQuestions the Engineer Must Answer\n1. Question?';
    const result = enforceEngineerRebuttalMandatorySections(existingResult, lowSlopeContext);
    // Count occurrences of each section heading
    const theoryCount = (result.match(/Engineer Theory Extraction/gi) || []).length;
    const timingCount = (result.match(/Timing Failure/gi) || []).length;
    expect(theoryCount).toBe(1);
    expect(timingCount).toBe(1);
  });

  it('output contains no forbidden wind/shingle terms from low-slope questions', () => {
    const questions = buildEngineerMustAnswerQuestions(LOW_SLOPE_PRIMARY_SCENARIO);
    const allQuestionsText = questions.join(' ').toLowerCase();
    for (const term of LOW_SLOPE_FORBIDDEN_TERMS) {
      expect(allQuestionsText).not.toContain(term.toLowerCase());
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. WIND CASE
// ═══════════════════════════════════════════════════════════════════════════
describe('Wind uplift engineer rebuttal enforcement', () => {
  const windContext: EnforcementContext = {
    engineerStatedCause: 'Wind damage was not observed; displacement is from aging and thermal cycling.',
    engineerTheorySentences: ['The displacement is from aging and thermal cycling.'],
    primaryScenario: 'wind_uplift',
    criticalTestingNotPerformed: ['hand-tab test', 'seal strip condition testing', 'fastener pattern review'],
    reportText: 'Shingles showed displacement on the north slope. No active leaks observed.',
  };

  it('includes timing failure section', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic wind rebuttal.', windContext);
    expect(result).toContain('Timing Failure');
    expect(result).toContain('seal adhesion testing');
  });

  it('includes required testing not performed', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic wind rebuttal.', windContext);
    expect(result).toContain('Required Testing Not Performed');
  });

  it('includes wind-specific engineer questions', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic wind rebuttal.', windContext);
    expect(result).toContain('hand-tab');
    expect(result).toContain('fastener pattern review');
    expect(result).toContain('seal failure');
  });

  it('does NOT include low-slope membrane language', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic wind rebuttal.', windContext);
    expect(result).not.toContain('membrane core cuts');
    expect(result).not.toContain('drainage-capacity analysis');
    expect(result).not.toContain('snow-water equivalent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. HAIL CASE
// ═══════════════════════════════════════════════════════════════════════════
describe('Hail impact engineer rebuttal enforcement', () => {
  const hailContext: EnforcementContext = {
    engineerStatedCause: 'Damage is cosmetic granule loss from normal weathering.',
    engineerTheorySentences: ['Granule loss is consistent with normal aging.'],
    primaryScenario: 'hail_impact',
    criticalTestingNotPerformed: ['test squares', 'soft-metal collateral review', 'mat fracture inspection'],
    reportText: 'Test squares not performed. Minor granule loss observed.',
  };

  it('includes hail-specific questions', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic hail rebuttal.', hailContext);
    expect(result).toContain('test squares');
    expect(result).toContain('soft-metal collateral');
    expect(result).toContain('functional damage from cosmetic damage');
  });

  it('does NOT include wind-only or low-slope-only language', () => {
    const result = enforceEngineerRebuttalMandatorySections('Basic hail rebuttal.', hailContext);
    expect(result).not.toContain('membrane core cuts');
    expect(result).not.toContain('drainage-capacity');
    expect(result).not.toContain('hand-tab');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. UNIVERSAL — POST-PROCESSOR APPENDS MISSING SECTIONS
// ═══════════════════════════════════════════════════════════════════════════
describe('Universal engineer rebuttal post-processing', () => {
  const universalContext: EnforcementContext = {
    engineerStatedCause: 'Damage is from normal wear and tear.',
    engineerTheorySentences: ['Normal wear and tear.'],
    primaryScenario: null,
    criticalTestingNotPerformed: ['material sampling', 'moisture mapping'],
    reportText: 'General inspection performed.',
  };

  it('appends all 6 required sections when model omits them', () => {
    const modelOutput = 'The engineer report is flawed. We demand reconsideration.';
    const result = enforceEngineerRebuttalMandatorySections(modelOutput, universalContext);
    expect(result).toContain('Engineer Theory Extraction');
    expect(result).toContain('Timing Failure');
    expect(result).toContain('Required Testing Not Performed');
    expect(result).toContain('Causation Proof Failure');
    expect(result).toContain('Internal Contradictions');
    expect(result).toContain('Questions the Engineer Must Answer');
  });

  it('uses universal/default questions when no scenario matches', () => {
    const questions = buildEngineerMustAnswerQuestions(null);
    expect(questions.length).toBeGreaterThanOrEqual(5);
    expect(questions.some(q => q.includes('timing'))).toBe(true);
    expect(questions.some(q => q.includes('forensic methodology'))).toBe(true);
  });

  it('causation proof failure includes mandatory language', () => {
    const section = buildCausationProofFailureSectionStumper(null, ['material sampling', 'moisture mapping']);
    expect(section).toContain('Condition evidence is not causation proof');
    expect(section).toContain('does not establish sole causation to a reasonable degree of engineering certainty');
    expect(section).toContain('material sampling');
    expect(section).toContain('moisture mapping');
  });
});
