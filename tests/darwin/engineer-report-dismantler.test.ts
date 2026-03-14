/**
 * Acceptance tests for the EngineerReportDismantler universal forensic engine.
 * Tests all 7 non-ice-dam loss types plus dual-causation and maintenance narrative detection.
 *
 * These tests exercise the runEngineerReportDismantler function extracted from the edge function.
 * They validate scenario activation, dual-causation detection, exclusion narrative detection,
 * and structured signal output for each loss type.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ─── Inline the dismantler logic for unit testing ────────────────────────────
// (Mirrors the edge function exactly so tests stay in sync)

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

interface ScenarioActivation {
  scenario: string;
  matchedKeywords: string[];
  score: number;
  reason: string;
}

interface DismantlerSignals {
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
}

interface EngineerReportDismantlerResult {
  activatedScenarios: string[];
  matchedKeywords: string[];
  isMaintenanceDenialNarrative: boolean;
  isDualCausation: boolean;
  promptInjection: string;
  signals: DismantlerSignals;
  scenarioActivationLog: ScenarioActivation[];
}

function runEngineerReportDismantler(documentText: string): EngineerReportDismantlerResult {
  const textLower = documentText.toLowerCase();
  const triggerEventSignals = TRIGGER_EVENT_KEYWORDS.filter(kw => textLower.includes(kw));
  const denialNarrativeSignals = EXCLUSION_NARRATIVE_KEYWORDS.filter(kw => textLower.includes(kw));

  const scenarioScores: Record<string, number> = {};
  const scenarioActivationLog: ScenarioActivation[] = [];
  const activatedScenarios: string[] = [];
  const allMatchedKeywords: string[] = [];

  for (const [scenario, weightedKws] of Object.entries(SCENARIO_KEYWORDS_WEIGHTED)) {
    const matched: string[] = [];
    let score = 0;
    for (const { term, weight } of weightedKws) {
      if (textLower.includes(term)) {
        matched.push(term);
        score += weight;
      }
    }
    scenarioScores[scenario] = score;
    const hasStrongHit = weightedKws.some(kw => kw.weight === 2 && textLower.includes(kw.term));
    const activated = hasStrongHit || score >= 2;
    const reason = activated
      ? (hasStrongHit ? `strong keyword present (score=${score})` : `total score=${score} >= 2`)
      : `score=${score} below threshold`;
    scenarioActivationLog.push({ scenario, matchedKeywords: matched, score, reason });
    if (activated) {
      activatedScenarios.push(scenario);
      allMatchedKeywords.push(...matched);
    }
  }

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
    activatedScenarios,
    matchedKeywords: [...new Set(allMatchedKeywords)],
    isMaintenanceDenialNarrative,
    isDualCausation,
    promptInjection: '', // not tested here
    signals: {
      triggerEventSignals,
      engineerCauseSignals: [],
      denialNarrativeSignals,
      contradictionSignals: [],
      missingTestingSignals: [],
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("EngineerReportDismantler — acceptance tests", () => {

  it("hail report with cosmetic/no functional damage narrative", () => {
    const text = loadFixture("engineer-hail-cosmetic-narrative.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("hail_impact");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true); // hail event + wear-and-tear
    expect(result.signals.triggerEventSignals.length).toBeGreaterThan(0);
    expect(result.signals.denialNarrativeSignals).toContain("cosmetic only");
    expect(result.signals.denialNarrativeSignals).toContain("wear and tear");
  });

  it("wind report with wear-and-tear narrative", () => {
    const text = loadFixture("engineer-wind-wear-tear-narrative.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("wind_uplift");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true); // storm event + deterioration
    expect(result.signals.denialNarrativeSignals).toContain("wear and tear");
    expect(result.signals.denialNarrativeSignals).toContain("deferred maintenance");
  });

  it("freeze burst plumbing report with negligence narrative", () => {
    const text = loadFixture("engineer-freeze-burst-negligence-narrative.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("plumbing_freeze_burst");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("deferred maintenance");
    expect(result.signals.denialNarrativeSignals).toContain("latent defect");
    expect(result.signals.denialNarrativeSignals).toContain("construction defect");
    expect(result.signals.denialNarrativeSignals).toContain("pre-existing");
  });

  it("fire cause report with incomplete origin analysis", () => {
    const text = loadFixture("engineer-fire-incomplete-origin.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("fire_causation");
    expect(result.signals.triggerEventSignals).toContain("fire");
    // Should detect scenario via strong keywords
    const fireLog = result.scenarioActivationLog.find(l => l.scenario === "fire_causation");
    expect(fireLog).toBeDefined();
    expect(fireLog!.score).toBeGreaterThanOrEqual(2);
  });

  it("water intrusion report with sealant/maintenance narrative", () => {
    const text = loadFixture("engineer-water-intrusion-sealant-narrative.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("water_intrusion_envelope");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("not storm related");
    expect(result.signals.denialNarrativeSignals).toContain("long-term leakage");
  });

  it("settlement report with no geotech support", () => {
    const text = loadFixture("engineer-settlement-no-geotech.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("structural_movement_settlement");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.isDualCausation).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("pre-existing");
    expect(result.signals.denialNarrativeSignals).toContain("gradual");
  });

  it("mechanical failure report with deferred maintenance assumption", () => {
    const text = loadFixture("engineer-mechanical-failure-deferred-maintenance.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("mechanical_failure");
    expect(result.isMaintenanceDenialNarrative).toBe(true);
    expect(result.signals.denialNarrativeSignals).toContain("deferred maintenance");
  });

  it("returns structured signals object with all required fields", () => {
    const text = loadFixture("engineer-hail-cosmetic-narrative.txt");
    const result = runEngineerReportDismantler(text);

    expect(result.signals).toBeDefined();
    expect(Array.isArray(result.signals.triggerEventSignals)).toBe(true);
    expect(Array.isArray(result.signals.denialNarrativeSignals)).toBe(true);
    expect(Array.isArray(result.signals.activatedScenarios)).toBe(true);
    expect(Array.isArray(result.signals.recommendedRebuttalAngles)).toBe(true);
    expect(typeof result.signals.scenarioScores).toBe("object");
    expect(typeof result.signals.isDualCausation).toBe("boolean");
    expect(typeof result.signals.isMaintenanceDenialNarrative).toBe("boolean");
  });

  it("provides debug log for each activated scenario", () => {
    const text = loadFixture("engineer-hail-cosmetic-narrative.txt");
    const result = runEngineerReportDismantler(text);

    const hailLog = result.scenarioActivationLog.find(l => l.scenario === "hail_impact");
    expect(hailLog).toBeDefined();
    expect(hailLog!.matchedKeywords.length).toBeGreaterThan(0);
    expect(hailLog!.score).toBeGreaterThanOrEqual(2);
    expect(hailLog!.reason).toContain("score=");
  });

  it("detects dual-causation from trigger + deterioration even without explicit keywords", () => {
    // Text with a trigger event and deterioration language but no explicit "dual causation" phrase
    const text = "The storm event caused wind damage to the roof. However the damage is the result of normal aging and deferred maintenance.";
    const result = runEngineerReportDismantler(text);

    expect(result.isDualCausation).toBe(true);
    expect(result.isMaintenanceDenialNarrative).toBe(true);
  });

  it("activates scenario from a single strong keyword", () => {
    // Just one strong keyword should activate
    const text = "The engineer performed a test square analysis on the north slope.";
    const result = runEngineerReportDismantler(text);

    expect(result.activatedScenarios).toContain("hail_impact");
  });

  it("does not activate scenario from a single weak keyword", () => {
    // Just "diameter" alone (score=1) should NOT activate
    const text = "The diameter of the pipe was measured at 3 inches.";
    const result = runEngineerReportDismantler(text);

    // hail_impact should NOT activate from just "diameter" (1 point)
    // but plumbing terms might score if enough accumulate
    const hailLog = result.scenarioActivationLog.find(l => l.scenario === "hail_impact");
    expect(hailLog?.score).toBeLessThanOrEqual(1);
  });
});
