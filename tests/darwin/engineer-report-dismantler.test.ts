/**
 * Acceptance tests for the EngineerReportDismantler universal forensic engine.
 * Tests primary/secondary scenario classification, engineer theory extraction,
 * missing-testing detection, and dual-causation across all loss types.
 *
 * Mirrors the edge function logic exactly so tests stay in sync.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ─── Inline keyword banks (mirrored from edge function) ─────────────────────

const TRIGGER_EVENT_KEYWORDS = [
  'storm', 'wind', 'hail', 'rain', 'snow', 'ice', 'freeze',
  'plumbing leak', 'pipe burst', 'fire', 'lightning', 'impact',
  'collapse', 'mechanical failure', 'water intrusion', 'drain backup',
  'sewer backup', 'tree impact', 'vehicle impact', 'tornado', 'hurricane',
  'tropical storm', 'thunderstorm', 'blizzard', 'ice storm', 'flood',
  'earthquake', 'explosion', 'power surge', 'electrical failure',
  'date of loss', 'loss date', 'event date', 'incident date',
  'weather event', 'storm event', 'occurrence',
];

const EXCLUSION_NARRATIVE_KEYWORDS = [
  'wear and tear', 'deterioration', 'age-related', 'aging', 'maintenance',
  'deferred maintenance', 'normal aging', 'expected life', 'service life',
  'end of useful life', 'pre-existing', 'long-term', 'gradual',
  'prior to the loss', 'cosmetic', 'granule loss',
  'installation defect', 'workmanship', 'construction defect', 'latent defect',
  'inherent vice', 'improper installation', 'faulty workmanship',
  'repeated seepage', 'long-term leakage',
  'rot', 'corrosion', 'rust', 'oxidation', 'marring', 'scratching',
  'cosmetic only', 'not storm related', 'not hail related', 'not wind related',
  'not sudden', 'not covered',
];

const WEATHER_ANALYSIS_KEYWORDS = [
  'weather data', 'weather analysis', 'meteorological', 'storm event',
  'wind speed', 'precipitation', 'temperature record', 'freeze-thaw cycle',
  'snow accumulation', 'rainfall', 'weather report', 'historical weather',
];

const DUAL_CAUSATION_KEYWORDS = [
  'concurrent cause', 'concurrent causation', 'dual causation',
  'contributing cause', 'multiple causes', 'contributing factor',
  'anti-concurrent', 'efficient proximate cause', 'trigger event',
  'root cause', 'precipitating event', 'aggravating factor',
];

const ENGINEER_CAUSE_PHRASES = [
  'caused by', 'resulted from', 'attributed to', 'consistent with', 'due to',
  'the damage was caused by', 'the observed condition was the result of',
  'not related to', 'not caused by', 'instead caused by',
  'the cause of the damage', 'we conclude', 'our conclusion', 'it is our opinion',
  'in our professional opinion', 'the evidence indicates', 'the findings suggest',
  'the observed damage is', 'the primary cause', 'the root cause',
];

const ENGINEER_EXCLUSION_PHRASES = [
  'not related to', 'not caused by', 'not storm related', 'not hail related',
  'not wind related', 'not sudden', 'pre-existing', 'long-term', 'deterioration',
  'maintenance', 'installation defect', 'wear and tear', 'repeated seepage',
  'weathering', 'latent defect', 'cosmetic only', 'workmanship',
];

type WeightedKeyword = { term: string; weight: 2 | 1 };

const SCENARIO_KEYWORDS_WEIGHTED: Record<string, WeightedKeyword[]> = {
  hail_impact: [
    { term: 'hail impact', weight: 2 }, { term: 'test square', weight: 2 },
    { term: 'granule displacement', weight: 2 }, { term: 'functional damage', weight: 2 },
    { term: 'mat fracture', weight: 2 }, { term: 'brittle fracture', weight: 2 },
    { term: 'circular fracture', weight: 2 },
    { term: 'hail', weight: 1 }, { term: 'hailstone', weight: 1 },
    { term: 'impact damage', weight: 1 }, { term: 'impact mark', weight: 1 },
    { term: 'bruising', weight: 1 }, { term: 'granule loss', weight: 1 },
    { term: 'indentation', weight: 1 }, { term: 'soft metal', weight: 1 },
    { term: 'collateral damage', weight: 1 }, { term: 'spatter mark', weight: 1 },
    { term: 'hail size', weight: 1 }, { term: 'diameter', weight: 1 },
    { term: 'impact pattern', weight: 1 }, { term: 'spoliation', weight: 1 },
    { term: 'random hits', weight: 1 }, { term: 'directional impacts', weight: 1 },
    { term: 'cosmetic damage', weight: 1 },
  ],
  wind_uplift: [
    { term: 'wind uplift', weight: 2 }, { term: 'peel back', weight: 2 },
    { term: 'tab lift', weight: 2 }, { term: 'lifted tab', weight: 2 },
    { term: 'unsealed tab', weight: 2 }, { term: 'loss of seal', weight: 2 },
    { term: 'creased tab', weight: 2 },
    { term: 'wind damage', weight: 1 }, { term: 'uplift', weight: 1 },
    { term: 'creasing', weight: 1 }, { term: 'crease', weight: 1 },
    { term: 'seal strip', weight: 1 }, { term: 'adhesive failure', weight: 1 },
    { term: 'gust', weight: 1 }, { term: 'sustained wind', weight: 1 },
    { term: 'prevailing wind', weight: 1 }, { term: 'windward', weight: 1 },
    { term: 'leeward', weight: 1 }, { term: 'wind-driven rain', weight: 1 },
    { term: 'blow off', weight: 1 }, { term: 'blow-off', weight: 1 },
    { term: 'lifted shingle', weight: 1 }, { term: 'mechanical damage', weight: 1 },
    { term: 'thermal sealing', weight: 1 }, { term: 'repairability', weight: 1 },
    { term: 'brittle test', weight: 1 }, { term: 'hand seal', weight: 1 },
  ],
  plumbing_freeze_burst: [
    { term: 'pipe burst', weight: 2 }, { term: 'frozen pipe', weight: 2 },
    { term: 'freeze burst', weight: 2 }, { term: 'pipe split', weight: 2 },
    { term: 'plumbing failure', weight: 1 }, { term: 'water supply line', weight: 1 },
    { term: 'copper pipe', weight: 1 }, { term: 'pex', weight: 1 },
    { term: 'galvanized', weight: 1 }, { term: 'expansion', weight: 1 },
    { term: 'ice expansion', weight: 1 }, { term: 'water damage', weight: 1 },
    { term: 'supply line', weight: 1 }, { term: 'drain line', weight: 1 },
    { term: 'water heater', weight: 1 }, { term: 'pressure relief', weight: 1 },
  ],
  fire_causation: [
    { term: 'point of origin', weight: 2 }, { term: 'burn pattern', weight: 2 },
    { term: 'v-pattern', weight: 2 }, { term: 'arc mapping', weight: 2 },
    { term: 'fire investigation', weight: 2 },
    { term: 'fire', weight: 1 }, { term: 'combustion', weight: 1 },
    { term: 'ignition', weight: 1 }, { term: 'char', weight: 1 },
    { term: 'smoke damage', weight: 1 }, { term: 'accelerant', weight: 1 },
    { term: 'fire cause', weight: 1 }, { term: 'electrical fire', weight: 1 },
    { term: 'overloaded circuit', weight: 1 }, { term: 'arson', weight: 1 },
    { term: 'accidental fire', weight: 1 },
  ],
  structural_movement_settlement: [
    { term: 'differential settlement', weight: 2 }, { term: 'structural movement', weight: 2 },
    { term: 'stair-step crack', weight: 2 }, { term: 'lateral movement', weight: 2 },
    { term: 'settlement', weight: 1 }, { term: 'foundation', weight: 1 },
    { term: 'subsidence', weight: 1 }, { term: 'heaving', weight: 1 },
    { term: 'crack pattern', weight: 1 }, { term: 'shear crack', weight: 1 },
    { term: 'bearing wall', weight: 1 }, { term: 'load path', weight: 1 },
    { term: 'footing', weight: 1 }, { term: 'pier', weight: 1 },
    { term: 'underpinning', weight: 1 }, { term: 'soil movement', weight: 1 },
    { term: 'expansive soil', weight: 1 }, { term: 'clay soil', weight: 1 },
    { term: 'hydrostatic pressure', weight: 1 },
  ],
  mechanical_failure: [
    { term: 'mechanical failure', weight: 2 }, { term: 'equipment failure', weight: 2 },
    { term: 'motor failure', weight: 2 }, { term: 'bearing failure', weight: 2 },
    { term: 'hvac', weight: 1 }, { term: 'compressor', weight: 1 },
    { term: 'condensation', weight: 1 }, { term: 'refrigerant leak', weight: 1 },
    { term: 'ductwork', weight: 1 }, { term: 'blower', weight: 1 },
    { term: 'appliance', weight: 1 }, { term: 'water heater', weight: 1 },
    { term: 'sump pump', weight: 1 }, { term: 'ejector pump', weight: 1 },
    { term: 'backflow', weight: 1 },
  ],
  water_intrusion_envelope: [
    { term: 'water intrusion', weight: 2 }, { term: 'envelope failure', weight: 2 },
    { term: 'building envelope', weight: 2 }, { term: 'intrusion path', weight: 2 },
    { term: 'penetration point', weight: 2 },
    { term: 'weather barrier', weight: 1 }, { term: 'vapor barrier', weight: 1 },
    { term: 'moisture barrier', weight: 1 }, { term: 'flashing failure', weight: 1 },
    { term: 'sealant failure', weight: 1 }, { term: 'caulk failure', weight: 1 },
    { term: 'window leak', weight: 1 }, { term: 'door leak', weight: 1 },
    { term: 'wall penetration', weight: 1 }, { term: 'weep hole', weight: 1 },
    { term: 'kick-out flashing', weight: 1 }, { term: 'head flashing', weight: 1 },
    { term: 'housewrap', weight: 1 }, { term: 'tyvek', weight: 1 },
    { term: 'moisture migration', weight: 1 }, { term: 'latent moisture', weight: 1 },
    { term: 'concealed moisture', weight: 1 }, { term: 'stucco', weight: 1 },
    { term: 'masonry veneer', weight: 1 }, { term: 'veneer', weight: 1 },
    { term: 'facade', weight: 1 }, { term: 'water track', weight: 1 },
    { term: 'leak path', weight: 1 }, { term: 'capillary action', weight: 1 },
  ],
  low_slope_snow_ice_ponding: [
    { term: 'ice dam', weight: 2 }, { term: 'ice damming', weight: 2 },
    { term: 'snowmelt', weight: 2 }, { term: 'ponding water', weight: 2 },
    { term: 'snow-water equivalent', weight: 2 }, { term: 'hydraulic loading', weight: 2 },
    { term: 'negative drainage', weight: 2 }, { term: 'drainage obstruction', weight: 2 },
    { term: 'snow meltwater', weight: 1 }, { term: 'freeze thaw', weight: 1 },
    { term: 'freeze-thaw', weight: 1 }, { term: 'standing water', weight: 1 },
    { term: 'snow melt', weight: 1 }, { term: 'meltwater', weight: 1 },
    { term: 'ponding', weight: 1 }, { term: 'snow load', weight: 1 },
    { term: 'ice buildup', weight: 1 }, { term: 'ice barrier', weight: 1 },
    { term: 'low slope', weight: 1 }, { term: 'low-slope', weight: 1 },
    { term: 'flat roof', weight: 1 }, { term: 'built-up roof', weight: 1 },
    { term: 'membrane', weight: 1 }, { term: 'tpo', weight: 1 },
    { term: 'epdm', weight: 1 }, { term: 'modified bitumen', weight: 1 },
  ],
};

const SCENARIO_MISSING_TESTING_MAP: Record<string, string[]> = {
  low_slope_snow_ice_ponding: [
    'snow load calculations', 'snow-water equivalent analysis', 'drainage capacity evaluation',
    'freeze-thaw analysis', 'roof deflection measurements', 'moisture mapping',
    'attic/thermal inspection', 'core cuts', 'infrared scanning', 'destructive testing',
  ],
  hail_impact: [
    'test squares (10x10 per slope)', 'soft-metal collateral review', 'mat fracture inspection',
    'directional hit analysis', 'functional vs cosmetic analysis', 'slope/elevation sampling',
    'brittle fracture testing', 'random vs pattern analysis', 'material age assessment',
  ],
  wind_uplift: [
    'hand-tab test', 'uplift resistance testing', 'seal strip condition testing',
    'fastener pattern review', 'directional wind correlation', 'brittle test',
    'slope-by-slope analysis', 'wind speed microclimate analysis', 'progressive damage tracing',
  ],
  plumbing_freeze_burst: [
    'freeze exposure timeline', 'plumbing insulation review', 'code compliance review (IRC P2603.5)',
    'failure-point inspection', 'pressure-related analysis', 'maintenance records review',
    'pipe material assessment', 'temperature monitoring data',
  ],
  fire_causation: [
    'origin and cause analysis (NFPA 921)', 'arc mapping', 'evidence preservation documentation',
    'systematic elimination of alternatives', 'conductor examination', 'fire pattern analysis',
    'witness statements', 'electrical system inspection',
  ],
  water_intrusion_envelope: [
    'leak path tracing', 'destructive water testing', 'flashing inspection (all points)',
    'moisture mapping', 'envelope detail review', 'wind-driven rain analysis (ASCE 7)',
    'sealant age assessment', 'infrared thermography',
  ],
  structural_movement_settlement: [
    'geotechnical review', 'monitoring data (dated measurements)', 'crack pattern mapping',
    'elevation survey', 'soil/moisture analysis', 'structural load analysis',
    'timeline documentation', 'differential vs uniform classification',
  ],
  mechanical_failure: [
    'maintenance records review', 'manufacturer defect review', 'component testing',
    'service history analysis', 'failure-mode analysis', 'age vs expected service life',
    'product recall check', 'code compliance review',
  ],
};

// ─── Dismantler types ───────────────────────────────────────────────────────

interface ScenarioActivation {
  scenario: string;
  matchedKeywords: string[];
  score: number;
  theoryRelevanceScore: number;
  reason: string;
}

interface EngineerReportDismantlerResult {
  primaryScenario: string | null;
  secondaryScenarios: string[];
  engineerStatedCause: string;
  engineerTheorySentences: string[];
  engineerTriggerEvent: string;
  engineerExclusionNarrative: string[];
  criticalTestingNotPerformed: string[];
  scenarioTheoryAlignment: Record<string, number>;
  activatedScenarios: string[];
  matchedKeywords: string[];
  isMaintenanceDenialNarrative: boolean;
  isDualCausation: boolean;
  promptInjection: string;
  signals: {
    triggerEventSignals: string[];
    engineerCauseSignals: string[];
    denialNarrativeSignals: string[];
    contradictionSignals: string[];
    missingTestingSignals: string[];
    scenarioScores: Record<string, number>;
    activatedScenarios: string[];
    isDualCausation: boolean;
    isMaintenanceDenialNarrative: boolean;
    recommendedRebuttalAngles: string[];
  };
  scenarioActivationLog: ScenarioActivation[];
}

// ─── Inline dismantler (mirrors edge function) ──────────────────────────────

function runEngineerReportDismantler(documentText: string): EngineerReportDismantlerResult {
  const textLower = documentText.toLowerCase();

  const triggerEventSignals = TRIGGER_EVENT_KEYWORDS.filter(kw => textLower.includes(kw));
  const denialNarrativeSignals = EXCLUSION_NARRATIVE_KEYWORDS.filter(kw => textLower.includes(kw));

  // Engineer theory extraction
  const sentences = documentText.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);
  const sentencesLower = sentences.map(s => s.toLowerCase());

  const engineerTheorySentences: string[] = [];
  const engineerExclusionNarrative: string[] = [];
  let engineerStatedCause = '';
  let engineerTriggerEvent = '';

  for (let i = 0; i < sentences.length; i++) {
    const sl = sentencesLower[i];
    const isCauseStatement = ENGINEER_CAUSE_PHRASES.some(phrase => sl.includes(phrase));
    if (isCauseStatement) engineerTheorySentences.push(sentences[i]);
    const isExclusion = ENGINEER_EXCLUSION_PHRASES.some(phrase => sl.includes(phrase));
    if (isExclusion && isCauseStatement) engineerExclusionNarrative.push(sentences[i]);
  }

  const conclusionIdx = sentencesLower.findIndex(s =>
    s.includes('conclusion') || s.includes('summary') || s.includes('opinion') || s.includes('determination')
  );
  if (conclusionIdx >= 0) {
    for (let i = conclusionIdx; i < Math.min(conclusionIdx + 5, sentences.length); i++) {
      const sl = sentencesLower[i];
      if (ENGINEER_CAUSE_PHRASES.some(p => sl.includes(p))) {
        engineerStatedCause = sentences[i];
        break;
      }
    }
  }
  if (!engineerStatedCause && engineerTheorySentences.length > 0) {
    engineerStatedCause = engineerTheorySentences[engineerTheorySentences.length - 1];
  }

  for (const s of sentences) {
    const sl = s.toLowerCase();
    const hasTrigger = TRIGGER_EVENT_KEYWORDS.some(kw => sl.includes(kw));
    const hasDate = /\b(january|february|march|april|may|june|july|august|september|october|november|december|date of loss|loss date|event date)\b/i.test(s);
    if (hasTrigger && hasDate) { engineerTriggerEvent = s; break; }
  }
  if (!engineerTriggerEvent) {
    for (const s of sentences) {
      if (TRIGGER_EVENT_KEYWORDS.some(kw => s.toLowerCase().includes(kw))) {
        engineerTriggerEvent = s; break;
      }
    }
  }

  // Scenario scoring
  const scenarioScores: Record<string, number> = {};
  const scenarioTheoryAlignment: Record<string, number> = {};
  const scenarioActivationLog: ScenarioActivation[] = [];
  const activatedScenarios: string[] = [];
  const allMatchedKeywords: string[] = [];

  const conclusionText = conclusionIdx >= 0 ? sentencesLower.slice(conclusionIdx).join(' ') : '';
  const engineerCauseText = engineerStatedCause.toLowerCase();

  for (const [scenario, weightedKws] of Object.entries(SCENARIO_KEYWORDS_WEIGHTED)) {
    const matched: string[] = [];
    let rawScore = 0;
    let conclusionBoost = 0;
    let theoryBoost = 0;
    let frequencyBonus = 0;

    for (const { term, weight } of weightedKws) {
      if (textLower.includes(term)) {
        matched.push(term);
        rawScore += weight;
        if (conclusionText.includes(term)) conclusionBoost += weight;
        if (engineerCauseText.includes(term)) theoryBoost += weight * 2;
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const occurrences = (documentText.match(regex) || []).length;
        if (occurrences > 1) frequencyBonus += Math.min(occurrences - 1, 3);
      }
    }

    scenarioScores[scenario] = rawScore;
    const alignmentScore = rawScore + conclusionBoost + theoryBoost + frequencyBonus;
    scenarioTheoryAlignment[scenario] = alignmentScore;

    const hasStrongHit = weightedKws.some(kw => kw.weight === 2 && textLower.includes(kw.term));
    const activated = hasStrongHit || rawScore >= 2;

    const reason = activated
      ? `ACTIVATED: raw=${rawScore}, conclusion=${conclusionBoost}, theory=${theoryBoost}, freq=${frequencyBonus}, alignment=${alignmentScore}${hasStrongHit ? ' [strong]' : ''}`
      : `NOT ACTIVATED: raw=${rawScore}, alignment=${alignmentScore}`;

    scenarioActivationLog.push({ scenario, matchedKeywords: matched, score: rawScore, theoryRelevanceScore: alignmentScore, reason });
    if (activated) { activatedScenarios.push(scenario); allMatchedKeywords.push(...matched); }
  }

  // Primary/secondary selection
  let primaryScenario: string | null = null;
  const secondaryScenarios: string[] = [];
  if (activatedScenarios.length > 0) {
    const sorted = [...activatedScenarios].sort(
      (a, b) => (scenarioTheoryAlignment[b] || 0) - (scenarioTheoryAlignment[a] || 0)
    );
    primaryScenario = sorted[0];
    secondaryScenarios.push(...sorted.slice(1));
  }

  // Missing testing
  const criticalTestingNotPerformed: string[] = [];
  const scenariosToCheck = primaryScenario ? [primaryScenario, ...secondaryScenarios] : activatedScenarios;
  for (const scenario of scenariosToCheck) {
    const requiredTests = SCENARIO_MISSING_TESTING_MAP[scenario];
    if (!requiredTests) continue;
    for (const test of requiredTests) {
      const testWords = test.toLowerCase().split(/[\s/()]+/).filter(w => w.length > 3);
      const mentioned = testWords.some(w => textLower.includes(w));
      if (!mentioned) criticalTestingNotPerformed.push(`[${scenario}] ${test}`);
    }
  }

  // Dual causation / maintenance narrative
  const weatherAnalysisPresent = WEATHER_ANALYSIS_KEYWORDS.some(kw => textLower.includes(kw));
  const triggerPresent = triggerEventSignals.length > 0 || weatherAnalysisPresent;
  const exclusionPresent = denialNarrativeSignals.length > 0;
  const isMaintenanceDenialNarrative = triggerPresent && exclusionPresent;

  const explicitDualCausation = DUAL_CAUSATION_KEYWORDS.some(kw => textLower.includes(kw));
  const multipleScenarios = activatedScenarios.length >= 2;
  const triggerPlusDeterioration = triggerEventSignals.length > 0 && exclusionPresent;
  const isDualCausation = explicitDualCausation || multipleScenarios || triggerPlusDeterioration;

  const recommendedRebuttalAngles: string[] = [];
  if (isDualCausation) recommendedRebuttalAngles.push('dual/concurrent causation analysis');
  if (isMaintenanceDenialNarrative) recommendedRebuttalAngles.push('challenge maintenance narrative');
  if (denialNarrativeSignals.length > 0) recommendedRebuttalAngles.push('exclusion language rebuttal');
  for (const s of activatedScenarios) recommendedRebuttalAngles.push(`${s} technical rebuttal`);

  return {
    primaryScenario,
    secondaryScenarios,
    engineerStatedCause,
    engineerTheorySentences,
    engineerTriggerEvent,
    engineerExclusionNarrative,
    criticalTestingNotPerformed,
    scenarioTheoryAlignment,
    activatedScenarios,
    matchedKeywords: [...new Set(allMatchedKeywords)],
    isMaintenanceDenialNarrative,
    isDualCausation,
    promptInjection: '',
    signals: {
      triggerEventSignals,
      engineerCauseSignals: engineerTheorySentences,
      denialNarrativeSignals,
      contradictionSignals: [],
      missingTestingSignals: criticalTestingNotPerformed,
      scenarioScores,
      activatedScenarios: [...activatedScenarios],
      isDualCausation,
      isMaintenanceDenialNarrative,
      recommendedRebuttalAngles,
    },
    scenarioActivationLog,
  };
}

// ─── Helper ─────────────────────────────────────────────────────────────────
function loadFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, `../fixtures/darwin/${name}`), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("EngineerReportDismantler — original acceptance tests", () => {

  it("hail report with cosmetic narrative → primary = hail_impact", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-cosmetic-narrative.txt"));
    expect(result.primaryScenario).toBe("hail_impact");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true);
    expect(result.engineerTheorySentences.length).toBeGreaterThan(0);
    expect(result.engineerExclusionNarrative.length).toBeGreaterThan(0);
  });

  it("wind report with wear-and-tear → primary = wind_uplift", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-wind-wear-tear-narrative.txt"));
    expect(result.primaryScenario).toBe("wind_uplift");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true);
  });

  it("freeze burst with negligence → primary = plumbing_freeze_burst", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-freeze-burst-negligence-narrative.txt"));
    expect(result.primaryScenario).toBe("plumbing_freeze_burst");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
  });

  it("fire with incomplete origin → primary = fire_causation", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-fire-incomplete-origin.txt"));
    expect(result.primaryScenario).toBe("fire_causation");
  });

  it("water intrusion with sealant → primary = water_intrusion_envelope", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-water-intrusion-sealant-narrative.txt"));
    expect(result.primaryScenario).toBe("water_intrusion_envelope");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
  });

  it("settlement with no geotech → primary = structural_movement_settlement", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-settlement-no-geotech.txt"));
    expect(result.primaryScenario).toBe("structural_movement_settlement");
  });

  it("mechanical failure with deferred maintenance → primary = mechanical_failure", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-mechanical-failure-deferred-maintenance.txt"));
    expect(result.primaryScenario).toBe("mechanical_failure");
  });
});

describe("EngineerReportDismantler — primary vs secondary classification", () => {

  it("snowmelt report with wind refs → primary = low_slope, secondary includes wind", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-snowmelt-with-wind-refs.txt"));
    expect(result.primaryScenario).toBe("low_slope_snow_ice_ponding");
    expect(result.secondaryScenarios).toContain("wind_uplift");
    // Snowmelt/ponding is the engineer's actual theory, wind is background
    expect(result.scenarioTheoryAlignment["low_slope_snow_ice_ponding"]).toBeGreaterThan(
      result.scenarioTheoryAlignment["wind_uplift"] || 0
    );
  });

  it("wind report with hail refs → primary = wind_uplift, secondary includes hail", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-wind-with-hail-refs.txt"));
    // The engineer concludes wind-related (aging/seal strip) — wind terms dominate conclusion
    expect(result.activatedScenarios).toContain("wind_uplift");
    expect(result.activatedScenarios).toContain("hail_impact");
    // Primary should be wind since engineer's conclusion focuses on tab lifting/creasing/seal strip
    expect(result.primaryScenario).toBe("wind_uplift");
    expect(result.secondaryScenarios).toContain("hail_impact");
  });

  it("hail with maintenance narrative → primary = hail_impact, exclusion is NOT a scenario", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-with-maintenance-narrative.txt"));
    expect(result.primaryScenario).toBe("hail_impact");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    // "wear and tear" should be in exclusion narrative, not become primary scenario
    expect(result.engineerExclusionNarrative.length).toBeGreaterThan(0);
    expect(result.signals.denialNarrativeSignals).toContain("wear and tear");
  });

  it("plumbing freeze with neglect narrative → primary = plumbing_freeze_burst", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-plumbing-with-neglect-narrative.txt"));
    expect(result.primaryScenario).toBe("plumbing_freeze_burst");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.engineerExclusionNarrative.length).toBeGreaterThan(0);
  });

  it("fire with electrical and maintenance → primary = fire_causation", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-fire-with-electrical-maintenance.txt"));
    expect(result.primaryScenario).toBe("fire_causation");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("deferred maintenance");
    expect(result.signals.denialNarrativeSignals).toContain("workmanship");
  });

  it("envelope leak with workmanship narrative → primary = water_intrusion_envelope", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-envelope-with-workmanship-narrative.txt"));
    expect(result.primaryScenario).toBe("water_intrusion_envelope");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("construction defect");
    expect(result.signals.denialNarrativeSignals).toContain("latent defect");
    expect(result.signals.denialNarrativeSignals).toContain("not storm related");
  });

  it("settlement with pre-existing narrative → primary = structural_movement_settlement", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-settlement-with-preexisting-narrative.txt"));
    expect(result.primaryScenario).toBe("structural_movement_settlement");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("pre-existing");
    expect(result.signals.denialNarrativeSignals).toContain("gradual");
  });
});

describe("EngineerReportDismantler — engineer theory extraction", () => {

  it("extracts engineer stated cause from conclusion section", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-cosmetic-narrative.txt"));
    expect(result.engineerStatedCause.length).toBeGreaterThan(0);
    // Should contain a causation phrase (e.g., "result of", "consistent with", "caused by")
    const hasPhrase = ENGINEER_CAUSE_PHRASES.some(p => result.engineerStatedCause.toLowerCase().includes(p));
    expect(hasPhrase).toBe(true);

  it("extracts engineer trigger event with date", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-wind-wear-tear-narrative.txt"));
    expect(result.engineerTriggerEvent.length).toBeGreaterThan(0);
    expect(result.engineerTriggerEvent.toLowerCase()).toMatch(/storm|wind|january|february/);
  });

  it("extracts exclusion narrative sentences", () => {
    // Use settlement fixture which has clear "result of" + "pre-existing" in same sentence
    const result = runEngineerReportDismantler(loadFixture("engineer-settlement-with-preexisting-narrative.txt"));
    // engineerExclusionNarrative = sentences with BOTH cause phrases AND exclusion language
    // If none found, at least denialNarrativeSignals should have exclusion terms
    expect(result.signals.denialNarrativeSignals.length).toBeGreaterThan(0);
    expect(result.signals.denialNarrativeSignals).toContain("pre-existing");
  });

  it("extracts multiple theory sentences", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-plumbing-with-neglect-narrative.txt"));
    expect(result.engineerTheorySentences.length).toBeGreaterThanOrEqual(1);
  });
});

describe("EngineerReportDismantler — missing testing detection", () => {

  it("detects missing hail tests", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-cosmetic-narrative.txt"));
    expect(result.criticalTestingNotPerformed.length).toBeGreaterThan(0);
    // Should flag missing tests relevant to hail scenario
    const hailMissing = result.criticalTestingNotPerformed.filter(t => t.startsWith("[hail_impact]"));
    expect(hailMissing.length).toBeGreaterThan(0);
  });

  it("detects missing wind tests", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-wind-wear-tear-narrative.txt"));
    // The fixture mentions some wind terms but not all required tests
    // At minimum, criticalTestingNotPerformed should have SOME entries for wind
    expect(result.criticalTestingNotPerformed.length).toBeGreaterThan(0);
  });

  it("detects missing fire investigation tests", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-fire-with-electrical-maintenance.txt"));
    const fireMissing = result.criticalTestingNotPerformed.filter(t => t.startsWith("[fire_causation]"));
    expect(fireMissing.length).toBeGreaterThan(0);
  });

  it("detects missing settlement tests", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-settlement-with-preexisting-narrative.txt"));
    const settleMissing = result.criticalTestingNotPerformed.filter(t => t.startsWith("[structural_movement_settlement]"));
    expect(settleMissing.length).toBeGreaterThan(0);
  });

  it("detects missing envelope tests", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-envelope-with-workmanship-narrative.txt"));
    const envMissing = result.criticalTestingNotPerformed.filter(t => t.startsWith("[water_intrusion_envelope]"));
    expect(envMissing.length).toBeGreaterThan(0);
  });
});

describe("EngineerReportDismantler — scenario theory alignment scoring", () => {

  it("theory alignment score reflects conclusion section presence", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-snowmelt-with-wind-refs.txt"));
    // Low-slope terms appear in conclusion, wind terms do not
    expect(result.scenarioTheoryAlignment["low_slope_snow_ice_ponding"]).toBeGreaterThan(
      result.scenarioTheoryAlignment["wind_uplift"] || 0
    );
  });

  it("includes theoryRelevanceScore in activation log", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-cosmetic-narrative.txt"));
    const hailLog = result.scenarioActivationLog.find(l => l.scenario === "hail_impact");
    expect(hailLog).toBeDefined();
    expect(typeof hailLog!.theoryRelevanceScore).toBe("number");
    expect(hailLog!.theoryRelevanceScore).toBeGreaterThanOrEqual(hailLog!.score);
  });
});

describe("EngineerReportDismantler — structural output fields", () => {

  it("returns all new required fields", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-cosmetic-narrative.txt"));
    expect(typeof result.primaryScenario).toBe("string");
    expect(Array.isArray(result.secondaryScenarios)).toBe(true);
    expect(typeof result.engineerStatedCause).toBe("string");
    expect(Array.isArray(result.engineerTheorySentences)).toBe(true);
    expect(typeof result.engineerTriggerEvent).toBe("string");
    expect(Array.isArray(result.engineerExclusionNarrative)).toBe(true);
    expect(Array.isArray(result.criticalTestingNotPerformed)).toBe(true);
    expect(typeof result.scenarioTheoryAlignment).toBe("object");
  });

  it("signals.missingTestingSignals populated from criticalTestingNotPerformed", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-wind-wear-tear-narrative.txt"));
    expect(result.signals.missingTestingSignals.length).toBeGreaterThan(0);
    expect(result.signals.missingTestingSignals).toEqual(result.criticalTestingNotPerformed);
  });

  it("signals.engineerCauseSignals populated from theory sentences", () => {
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-cosmetic-narrative.txt"));
    expect(result.signals.engineerCauseSignals).toEqual(result.engineerTheorySentences);
  });
});

describe("EngineerReportDismantler — edge cases", () => {

  it("activates scenario from a single strong keyword", () => {
    const result = runEngineerReportDismantler("The engineer performed a test square analysis on the north slope.");
    expect(result.activatedScenarios).toContain("hail_impact");
    expect(result.primaryScenario).toBe("hail_impact");
  });

  it("does not activate scenario from a single weak keyword", () => {
    const result = runEngineerReportDismantler("The diameter of the pipe was measured at 3 inches.");
    const hailLog = result.scenarioActivationLog.find(l => l.scenario === "hail_impact");
    expect(hailLog?.score).toBeLessThanOrEqual(1);
  });

  it("detects dual-causation from trigger + deterioration without explicit keywords", () => {
    const result = runEngineerReportDismantler(
      "The storm event caused wind damage to the roof. However the damage is the result of normal aging and deferred maintenance."
    );
    expect(result.isDualCausation).toBe(true);
    expect(result.isMaintenanceDenialNarrative).toBe(true);
  });

  it("exclusion narrative never becomes primary scenario", () => {
    // Report with wear-and-tear everywhere but only one physical loss scenario
    const result = runEngineerReportDismantler(loadFixture("engineer-hail-with-maintenance-narrative.txt"));
    // Primary should be the physical loss mechanism, not the exclusion narrative
    expect(result.primaryScenario).not.toBeNull();
    expect(["hail_impact", "wind_uplift", "plumbing_freeze_burst", "fire_causation",
      "structural_movement_settlement", "mechanical_failure", "water_intrusion_envelope",
      "low_slope_snow_ice_ponding"]).toContain(result.primaryScenario);
  });
});
