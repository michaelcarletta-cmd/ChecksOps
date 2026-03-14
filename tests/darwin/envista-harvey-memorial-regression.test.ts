/**
 * Regression tests for the Harvey Memorial / Envista low-slope snowmelt engineer report.
 *
 * Three validations:
 *   1. Dismantler classification
 *   2. Prompt-content assertions (attack vectors, scope guard, forbidden terms)
 *   3. Final-output enforcement (post-processing path)
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ─── Constants (mirrored from edge function) ─────────────────────────────────

const REQUIRED_LOW_SLOPE_OPENING =
  "The engineering report attributes the water intrusion to snow/ice meltwater penetrating age-related and maintenance-deferred openings in the low-slope roof covering.";

const LOW_SLOPE_PRIORITY_ORDER = `PRIORITY ORDER (MANDATORY):
1) timing of openings
2) missing membrane testing
3) drainage/snowmelt mechanics
4) contradiction in engineer reasoning
Do NOT prioritize wind mechanics.`;

const LOW_SLOPE_TIMING_FAILURE_SECTION = `SECTION 1 — TIMING FAILURE:
The report asserts openings developed over months or years but provides no objective testing that proves timing. Without membrane core cuts, seam adhesion/peel testing, moisture mapping, and leak-path tracing, the report cannot establish whether openings pre-dated the event or were created/expanded during snow/ice loading.`;

const LOW_SLOPE_DRAINAGE_FAILURE_SECTION = `SECTION 2 — DRAINAGE / SNOWMELT ANALYSIS FAILURE:
The report acknowledges snow and drainage conditions but does not quantify drainage capacity, snow-water equivalent, or runoff behavior. Without those analyses, the causation opinion is unsupported.`;

const LOW_SLOPE_CONTRADICTION_SECTION = `SECTION 3 — ENGINEER CONTRADICTION:
The report admits snow impeded drainage, standing water was present, and freeze-thaw cycles can worsen openings, yet it concludes deterioration alone caused the loss without proving the event did not create or expand the openings.`;

const LOW_SLOPE_STRUCTURAL_DISTINCTION = "Structural snow-load analysis is not membrane watertightness analysis.";

const TRIGGER_EVENT_KEYWORDS = [
  "storm","wind","hail","rain","snow","ice","freeze",
  "plumbing leak","pipe burst","fire","lightning","impact",
  "collapse","mechanical failure","water intrusion","drain backup",
  "sewer backup","tree impact","vehicle impact","tornado","hurricane",
  "tropical storm","thunderstorm","blizzard","ice storm","flood",
  "earthquake","explosion","power surge","electrical failure",
  "date of loss","loss date","event date","incident date",
  "weather event","storm event","occurrence",
];

const EXCLUSION_NARRATIVE_KEYWORDS = [
  "wear and tear","deterioration","age-related","aging","maintenance",
  "deferred maintenance","normal aging","expected life","service life",
  "end of useful life","pre-existing","long-term","gradual",
  "prior to the loss","cosmetic","granule loss",
  "installation defect","workmanship","construction defect","latent defect",
  "inherent vice","improper installation","faulty workmanship",
  "repeated seepage","long-term leakage",
  "rot","corrosion","rust","oxidation","marring","scratching",
  "cosmetic only","not storm related","not hail related","not wind related",
  "not sudden","not covered",
];

const WEATHER_ANALYSIS_KEYWORDS = [
  "weather data","weather analysis","meteorological","storm event",
  "wind speed","precipitation","temperature record","freeze-thaw cycle",
  "snow accumulation","rainfall","weather report","historical weather",
];

const DUAL_CAUSATION_KEYWORDS = [
  "concurrent cause","concurrent causation","dual causation",
  "contributing cause","multiple causes","contributing factor",
  "anti-concurrent","efficient proximate cause","trigger event",
  "root cause","precipitating event","aggravating factor",
];

const ENGINEER_CAUSE_PHRASES = [
  "caused by","resulted from","attributed to","consistent with","due to",
  "the damage was caused by","the observed condition was the result of",
  "not related to","not caused by","instead caused by",
  "the cause of the damage","we conclude","our conclusion","it is our opinion",
  "in our professional opinion","the evidence indicates","the findings suggest",
  "the observed damage is","the primary cause","the root cause",
];

const ENGINEER_EXCLUSION_PHRASES = [
  "not related to","not caused by","not storm related","not hail related",
  "not wind related","not sudden","pre-existing","long-term","deterioration",
  "maintenance","installation defect","wear and tear","repeated seepage",
  "weathering","latent defect","cosmetic only","workmanship",
];

type WeightedKeyword = { term: string; weight: 2 | 1 };

const SCENARIO_KEYWORDS_WEIGHTED: Record<string, WeightedKeyword[]> = {
  hail_impact: [
    { term: "hail impact", weight: 2 },{ term: "test square", weight: 2 },
    { term: "granule displacement", weight: 2 },{ term: "functional damage", weight: 2 },
    { term: "mat fracture", weight: 2 },{ term: "brittle fracture", weight: 2 },
    { term: "circular fracture", weight: 2 },
    { term: "hail", weight: 1 },{ term: "hailstone", weight: 1 },
    { term: "impact damage", weight: 1 },{ term: "impact mark", weight: 1 },
    { term: "bruising", weight: 1 },{ term: "granule loss", weight: 1 },
    { term: "indentation", weight: 1 },{ term: "soft metal", weight: 1 },
    { term: "collateral damage", weight: 1 },{ term: "spatter mark", weight: 1 },
    { term: "hail size", weight: 1 },{ term: "diameter", weight: 1 },
    { term: "impact pattern", weight: 1 },{ term: "spoliation", weight: 1 },
    { term: "random hits", weight: 1 },{ term: "directional impacts", weight: 1 },
    { term: "cosmetic damage", weight: 1 },
  ],
  wind_uplift: [
    { term: "wind uplift", weight: 2 },{ term: "peel back", weight: 2 },
    { term: "tab lift", weight: 2 },{ term: "lifted tab", weight: 2 },
    { term: "unsealed tab", weight: 2 },{ term: "loss of seal", weight: 2 },
    { term: "creased tab", weight: 2 },
    { term: "wind damage", weight: 1 },{ term: "uplift", weight: 1 },
    { term: "creasing", weight: 1 },{ term: "crease", weight: 1 },
    { term: "seal strip", weight: 1 },{ term: "adhesive failure", weight: 1 },
    { term: "gust", weight: 1 },{ term: "sustained wind", weight: 1 },
    { term: "prevailing wind", weight: 1 },{ term: "windward", weight: 1 },
    { term: "leeward", weight: 1 },{ term: "wind-driven rain", weight: 1 },
    { term: "blow off", weight: 1 },{ term: "blow-off", weight: 1 },
    { term: "lifted shingle", weight: 1 },{ term: "mechanical damage", weight: 1 },
    { term: "thermal sealing", weight: 1 },{ term: "repairability", weight: 1 },
    { term: "brittle test", weight: 1 },{ term: "hand seal", weight: 1 },
  ],
  plumbing_freeze_burst: [
    { term: "pipe burst", weight: 2 },{ term: "frozen pipe", weight: 2 },
    { term: "freeze burst", weight: 2 },{ term: "pipe split", weight: 2 },
    { term: "plumbing failure", weight: 1 },{ term: "water supply line", weight: 1 },
    { term: "copper pipe", weight: 1 },{ term: "pex", weight: 1 },
    { term: "galvanized", weight: 1 },{ term: "expansion", weight: 1 },
    { term: "ice expansion", weight: 1 },{ term: "water damage", weight: 1 },
    { term: "supply line", weight: 1 },{ term: "drain line", weight: 1 },
    { term: "water heater", weight: 1 },{ term: "pressure relief", weight: 1 },
  ],
  fire_causation: [
    { term: "point of origin", weight: 2 },{ term: "burn pattern", weight: 2 },
    { term: "v-pattern", weight: 2 },{ term: "arc mapping", weight: 2 },
    { term: "fire investigation", weight: 2 },
    { term: "fire", weight: 1 },{ term: "combustion", weight: 1 },
    { term: "ignition", weight: 1 },{ term: "char", weight: 1 },
    { term: "smoke damage", weight: 1 },{ term: "accelerant", weight: 1 },
    { term: "fire cause", weight: 1 },{ term: "electrical fire", weight: 1 },
    { term: "overloaded circuit", weight: 1 },{ term: "arson", weight: 1 },
    { term: "accidental fire", weight: 1 },
  ],
  structural_movement_settlement: [
    { term: "differential settlement", weight: 2 },{ term: "structural movement", weight: 2 },
    { term: "stair-step crack", weight: 2 },{ term: "lateral movement", weight: 2 },
    { term: "settlement", weight: 1 },{ term: "foundation", weight: 1 },
    { term: "subsidence", weight: 1 },{ term: "heaving", weight: 1 },
    { term: "crack pattern", weight: 1 },{ term: "shear crack", weight: 1 },
    { term: "bearing wall", weight: 1 },{ term: "load path", weight: 1 },
    { term: "footing", weight: 1 },{ term: "pier", weight: 1 },
    { term: "underpinning", weight: 1 },{ term: "soil movement", weight: 1 },
    { term: "expansive soil", weight: 1 },{ term: "clay soil", weight: 1 },
    { term: "hydrostatic pressure", weight: 1 },
  ],
  mechanical_failure: [
    { term: "mechanical failure", weight: 2 },{ term: "equipment failure", weight: 2 },
    { term: "motor failure", weight: 2 },{ term: "bearing failure", weight: 2 },
    { term: "hvac", weight: 1 },{ term: "compressor", weight: 1 },
    { term: "condensation", weight: 1 },{ term: "refrigerant leak", weight: 1 },
    { term: "ductwork", weight: 1 },{ term: "blower", weight: 1 },
    { term: "appliance", weight: 1 },{ term: "water heater", weight: 1 },
    { term: "sump pump", weight: 1 },{ term: "ejector pump", weight: 1 },
    { term: "backflow", weight: 1 },
  ],
  water_intrusion_envelope: [
    { term: "water intrusion", weight: 2 },{ term: "envelope failure", weight: 2 },
    { term: "building envelope", weight: 2 },{ term: "intrusion path", weight: 2 },
    { term: "penetration point", weight: 2 },
    { term: "weather barrier", weight: 1 },{ term: "vapor barrier", weight: 1 },
    { term: "moisture barrier", weight: 1 },{ term: "flashing failure", weight: 1 },
    { term: "sealant failure", weight: 1 },{ term: "caulk failure", weight: 1 },
    { term: "window leak", weight: 1 },{ term: "door leak", weight: 1 },
    { term: "wall penetration", weight: 1 },{ term: "weep hole", weight: 1 },
    { term: "kick-out flashing", weight: 1 },{ term: "head flashing", weight: 1 },
    { term: "housewrap", weight: 1 },{ term: "tyvek", weight: 1 },
    { term: "moisture migration", weight: 1 },{ term: "latent moisture", weight: 1 },
    { term: "concealed moisture", weight: 1 },{ term: "stucco", weight: 1 },
    { term: "masonry veneer", weight: 1 },{ term: "veneer", weight: 1 },
    { term: "facade", weight: 1 },{ term: "water track", weight: 1 },
    { term: "leak path", weight: 1 },{ term: "capillary action", weight: 1 },
  ],
  low_slope_snow_ice_ponding: [
    { term: "ice dam", weight: 2 },{ term: "ice damming", weight: 2 },
    { term: "snowmelt", weight: 2 },{ term: "ponding water", weight: 2 },
    { term: "snow-water equivalent", weight: 2 },{ term: "hydraulic loading", weight: 2 },
    { term: "negative drainage", weight: 2 },{ term: "drainage obstruction", weight: 2 },
    { term: "snowmelt infiltration", weight: 2 },{ term: "membrane deterioration", weight: 2 },
    { term: "drainage deficien", weight: 2 },{ term: "membrane system", weight: 2 },
    { term: "snow meltwater", weight: 1 },{ term: "freeze thaw", weight: 1 },
    { term: "freeze-thaw", weight: 1 },{ term: "standing water", weight: 1 },
    { term: "snow melt", weight: 1 },{ term: "meltwater", weight: 1 },
    { term: "ponding", weight: 1 },{ term: "snow load", weight: 1 },
    { term: "ice buildup", weight: 1 },{ term: "ice barrier", weight: 1 },
    { term: "low slope", weight: 1 },{ term: "low-slope", weight: 1 },
    { term: "flat roof", weight: 1 },{ term: "built-up roof", weight: 1 },
    { term: "membrane", weight: 1 },{ term: "tpo", weight: 1 },
    { term: "epdm", weight: 1 },{ term: "modified bitumen", weight: 1 },
    { term: "interior water damage", weight: 1 },{ term: "water intrusion", weight: 1 },
    { term: "roof covering", weight: 1 },{ term: "seam", weight: 1 },
    { term: "membrane seam", weight: 1 },{ term: "clogged drain", weight: 1 },
    { term: "snow event", weight: 1 },{ term: "inadequate slope", weight: 1 },
    { term: "drainage system", weight: 1 },{ term: "parapet", weight: 1 },
    { term: "ice formation", weight: 1 },{ term: "roof slope", weight: 1 },
  ],
};

const SCENARIO_MISSING_TESTING_MAP: Record<string, string[]> = {
  low_slope_snow_ice_ponding: [
    "membrane core cuts","seam adhesion/peel testing","drainage-capacity analysis",
    "snow-water equivalent/runoff analysis","leak-path tracing","moisture mapping",
    "proof of timing of openings",
  ],
  hail_impact: [
    "test squares (10x10 per slope)","soft-metal collateral review","mat fracture inspection",
    "directional hit analysis","functional vs cosmetic analysis","slope/elevation sampling",
    "brittle fracture testing","random vs pattern analysis","material age assessment",
  ],
  wind_uplift: [
    "hand-tab test","uplift resistance testing","seal strip condition testing",
    "fastener pattern review","directional wind correlation","brittle test",
    "slope-by-slope analysis","wind speed microclimate analysis","progressive damage tracing",
  ],
};

const LOW_SLOPE_FORBIDDEN_RULES: Array<{ regex: RegExp; supportTerms: string[] }> = [
  { regex: /\bshingle(?:s)?\b/i, supportTerms: ["shingle", "shingles"] },
  { regex: /\barchitectural\s+shingle(?:s)?\b/i, supportTerms: ["architectural shingle", "architectural shingles"] },
  { regex: /\bthermal\s+seal(?:ing)?\b/i, supportTerms: ["thermal seal", "thermal sealing"] },
  { regex: /\bseal\s+strip\b/i, supportTerms: ["seal strip"] },
  { regex: /\bseal\s+failure\b/i, supportTerms: ["seal failure"] },
  { regex: /\bfactory\s+seal(?:\s+failure)?\b/i, supportTerms: ["factory seal", "factory seal failure"] },
  { regex: /\buplift\s+check(?:s)?\b/i, supportTerms: ["uplift check", "uplift checks"] },
  { regex: /\buplift\s+resistance\b/i, supportTerms: ["uplift resistance"] },
  { regex: /\buplift\s+test(?:ing|s)?\b/i, supportTerms: ["uplift test", "uplift testing", "uplift tests"] },
  { regex: /\blift\s+test(?:s)?\b/i, supportTerms: ["lift test", "lift tests"] },
  { regex: /\bgranul(?:e|ar)s?(?:\s+loss)?\b/i, supportTerms: ["granule", "granules", "granular", "granule loss", "granular loss"] },
  { regex: /\bfractured\s+tab(?:s)?\b/i, supportTerms: ["fractured tab", "fractured tabs", "tab fracture", "fractured shingle tab"] },
  { regex: /\bARMA\b/i, supportTerms: ["arma"] },
  { regex: /\bfastener\s+pull-?out\b/i, supportTerms: ["fastener pull-out", "fastener pullout"] },
  { regex: /\bwind-?driven\s+rain\b/i, supportTerms: ["wind-driven rain"] },
  { regex: /\bhand[-\s]?tab\s+test(?:s)?\b/i, supportTerms: ["hand-tab test", "hand tab test", "hand-tab tests", "hand tab tests"] },
  { regex: /\b(?:GAF|CertainTeed|Owens\s+Corning)\b/i, supportTerms: ["gaf", "certainteed", "owens corning"] },
  { regex: /\bcreased\s+shingle\s+tab(?:s)?\b/i, supportTerms: ["creased shingle tab", "creased shingle tabs"] },
  { regex: /\bfractured\s+shingle(?:s)?\b/i, supportTerms: ["fractured shingle", "fractured shingles"] },
  { regex: /\bwind\s+uplift\s+mechanics?\b/i, supportTerms: ["wind uplift mechanic", "wind uplift mechanics"] },
  { regex: /\bthermal\s+expansion\s+of\s+shingle(?:s)?\b/i, supportTerms: ["thermal expansion of shingle", "thermal expansion of shingles"] },
  { regex: /\bstructural\s+racking\b/i, supportTerms: ["structural racking"] },
  { regex: /\bhigh[-\s]?wind(?:\s+pressure)?\b/i, supportTerms: ["high wind", "high wind pressure"] },
  { regex: /\bwind\s+pressure\b/i, supportTerms: ["wind pressure"] },
  { regex: /\bpressure\s+event\b/i, supportTerms: ["pressure event"] },
];

const LOW_SLOPE_FORBIDDEN_BULLET_LIST = [
  "shingle / shingles",
  "granules / granular loss",
  "uplift test",
  "seal failure / factory seal",
  "thermal expansion of shingles",
  "architectural shingles",
  "structural racking",
  "high wind pressure language",
  "thermal seal",
  "seal strip",
  "uplift checks",
  "fractured tabs",
  "ARMA",
  "fastener pull-out",
  "wind-driven rain",
  "hand tab test",
  "lift test",
  "GAF / CertainTeed / Owens Corning references",
].map((item) => `- ${item}`).join("\n");

// ─── Dismantler (mirrored) ───────────────────────────────────────────────────

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

function runEngineerReportDismantler(documentText: string): EngineerReportDismantlerResult {
  const textLower = documentText.toLowerCase();
  const triggerEventSignals = TRIGGER_EVENT_KEYWORDS.filter(kw => textLower.includes(kw));
  const denialNarrativeSignals = EXCLUSION_NARRATIVE_KEYWORDS.filter(kw => textLower.includes(kw));

  const sentences = documentText.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);
  const sentencesLower = sentences.map(s => s.toLowerCase());

  const engineerTheorySentences: string[] = [];
  const engineerExclusionNarrative: string[] = [];
  let engineerStatedCause = "";
  let engineerTriggerEvent = "";

  for (let i = 0; i < sentences.length; i++) {
    const sl = sentencesLower[i];
    const isCauseStatement = ENGINEER_CAUSE_PHRASES.some(phrase => sl.includes(phrase));
    if (isCauseStatement) engineerTheorySentences.push(sentences[i]);
    const isExclusion = ENGINEER_EXCLUSION_PHRASES.some(phrase => sl.includes(phrase));
    if (isExclusion && isCauseStatement) engineerExclusionNarrative.push(sentences[i]);
  }

  const conclusionIdx = sentencesLower.findIndex(s =>
    s.includes("conclusion") || s.includes("summary") || s.includes("opinion") || s.includes("determination")
  );
  if (conclusionIdx >= 0) {
    for (let i = conclusionIdx; i < Math.min(conclusionIdx + 5, sentences.length); i++) {
      const sl = sentencesLower[i];
      if (ENGINEER_CAUSE_PHRASES.some(p => sl.includes(p))) { engineerStatedCause = sentences[i]; break; }
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
      if (TRIGGER_EVENT_KEYWORDS.some(kw => s.toLowerCase().includes(kw))) { engineerTriggerEvent = s; break; }
    }
  }

  const scenarioScores: Record<string, number> = {};
  const scenarioTheoryAlignment: Record<string, number> = {};
  const scenarioActivationLog: ScenarioActivation[] = [];
  const activatedScenarios: string[] = [];
  const allMatchedKeywords: string[] = [];

  const conclusionText = conclusionIdx >= 0 ? sentencesLower.slice(conclusionIdx).join(" ") : "";
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
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
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
      ? `ACTIVATED: raw=${rawScore}, conclusion=${conclusionBoost}, theory=${theoryBoost}, freq=${frequencyBonus}, alignment=${alignmentScore}${hasStrongHit ? " [strong]" : ""}`
      : `NOT ACTIVATED: raw=${rawScore}, alignment=${alignmentScore}`;

    scenarioActivationLog.push({ scenario, matchedKeywords: matched, score: rawScore, theoryRelevanceScore: alignmentScore, reason });
    if (activated) { activatedScenarios.push(scenario); allMatchedKeywords.push(...matched); }
  }

  let primaryScenario: string | null = null;
  const secondaryScenarios: string[] = [];
  if (activatedScenarios.length > 0) {
    const sorted = [...activatedScenarios].sort(
      (a, b) => (scenarioTheoryAlignment[b] || 0) - (scenarioTheoryAlignment[a] || 0)
    );
    primaryScenario = sorted[0];
    secondaryScenarios.push(...sorted.slice(1));
  }

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

  const weatherAnalysisPresent = WEATHER_ANALYSIS_KEYWORDS.some(kw => textLower.includes(kw));
  const triggerPresent = triggerEventSignals.length > 0 || weatherAnalysisPresent;
  const exclusionPresent = denialNarrativeSignals.length > 0;
  const isMaintenanceDenialNarrative = triggerPresent && exclusionPresent;

  const explicitDualCausation = DUAL_CAUSATION_KEYWORDS.some(kw => textLower.includes(kw));
  const multipleScenarios = activatedScenarios.length >= 2;
  const triggerPlusDeterioration = triggerEventSignals.length > 0 && exclusionPresent;
  const isDualCausation = explicitDualCausation || multipleScenarios || triggerPlusDeterioration;

  const recommendedRebuttalAngles: string[] = [];
  if (isDualCausation) recommendedRebuttalAngles.push("dual/concurrent causation analysis");
  if (isMaintenanceDenialNarrative) recommendedRebuttalAngles.push("challenge maintenance narrative");
  if (denialNarrativeSignals.length > 0) recommendedRebuttalAngles.push("exclusion language rebuttal");
  for (const s of activatedScenarios) recommendedRebuttalAngles.push(`${s} technical rebuttal`);

  return {
    primaryScenario, secondaryScenarios, engineerStatedCause, engineerTheorySentences,
    engineerTriggerEvent, engineerExclusionNarrative, criticalTestingNotPerformed,
    scenarioTheoryAlignment, activatedScenarios,
    matchedKeywords: [...new Set(allMatchedKeywords)],
    isMaintenanceDenialNarrative, isDualCausation, promptInjection: "",
    signals: {
      triggerEventSignals, engineerCauseSignals: engineerTheorySentences,
      denialNarrativeSignals, contradictionSignals: [],
      missingTestingSignals: criticalTestingNotPerformed,
      scenarioScores, activatedScenarios: [...activatedScenarios],
      isDualCausation, isMaintenanceDenialNarrative, recommendedRebuttalAngles,
    },
    scenarioActivationLog,
  };
}

// ─── Prompt builders (mirrored) ──────────────────────────────────────────────

function buildScenarioAttackVectors(primary: string, _allActive: Set<string>): string {
  if (primary === "low_slope_snow_ice_ponding") {
    return `=== LOW-SLOPE / SNOW / ICE / MEMBRANE ATTACK APPROACH ===
MANDATORY THEORY SUMMARY (OPENING SENTENCE):
"${REQUIRED_LOW_SLOPE_OPENING}"

Do NOT default to generic storm/wind/shingle language in this scenario.
Unless a wind/shingle mechanic is directly quoted from the engineer's causation sentence, do NOT use:
${LOW_SLOPE_FORBIDDEN_BULLET_LIST}

${LOW_SLOPE_PRIORITY_ORDER}

REQUIRED ATTACK STRUCTURE (MANDATORY):
SECTION 1 — TIMING FAILURE
- Explain the report alleges openings developed over months/years without proving timing.
- Explicitly cite missing membrane core cuts, seam adhesion/peel testing, moisture mapping, and leak-path tracing.

SECTION 2 — DRAINAGE / SNOWMELT ANALYSIS FAILURE
- Explain the report admits snow and drainage issues but does not quantify drainage capacity, snow-water equivalent, or runoff analysis.

SECTION 3 — ENGINEER CONTRADICTION
- State the report admits snow impeded drainage, standing water was present, and freeze-thaw can worsen openings, yet still concludes deterioration alone caused the loss without proving the event did not create or expand openings.

MANDATORY DISTINCTION:
${LOW_SLOPE_STRUCTURAL_DISTINCTION}
Even if roof framing can carry load, that does not prove membrane watertightness.

EVIDENCE GROUNDING RULE:
Do not insert damage descriptions (e.g., creased shingle tabs, fractured shingles, wind uplift mechanics) unless those terms appear as direct quote text in the engineer’s causation sentence.`;
  }
  return "";
}

function buildScopeGuard(
  primarySc: string,
  lowSlopeTheoryExplicitlyReliesOnWind: boolean,
): string {
  if (primarySc !== "low_slope_snow_ice_ponding") return "";
  return `=== LOW-SLOPE REPORT-SPECIFIC ENFORCEMENT (MANDATORY) ===
OPENING SENTENCE REQUIREMENT (use this exact sentence first in the opening):
"${REQUIRED_LOW_SLOPE_OPENING}"

${LOW_SLOPE_PRIORITY_ORDER}

After that opening sentence, follow this required structure:
SECTION 1 — TIMING FAILURE
SECTION 2 — DRAINAGE / SNOWMELT ANALYSIS FAILURE
SECTION 3 — ENGINEER CONTRADICTION

Do NOT use generic storm/wind/shingle boilerplate unless it is directly quoted from the engineer's causation sentence.
Detected wind-centric causation reliance in extracted theory: ${lowSlopeTheoryExplicitlyReliesOnWind ? "YES" : "NO"}.
${lowSlopeTheoryExplicitlyReliesOnWind ? "If you use any wind/shingle language, quote the exact engineer causation sentence and explain why that quote is material." : `Do NOT use:\n${LOW_SLOPE_FORBIDDEN_BULLET_LIST}`}

MANDATORY LOW-SLOPE METHODOLOGY ATTACKS:
- no membrane core cuts
- no seam adhesion/peel testing
- no leak-path tracing
- no moisture mapping
- no proof of timing of openings

MANDATORY DRAINAGE / SNOWMELT ANALYSIS FAILURE ATTACK:
- no drainage-capacity analysis
- no snow-water equivalent/runoff analysis

MANDATORY CONTRADICTION ATTACK:
${LOW_SLOPE_CONTRADICTION_SECTION.replace("SECTION 3 — ENGINEER CONTRADICTION:\n", "")}

MANDATORY DISTINCTION:
${LOW_SLOPE_STRUCTURAL_DISTINCTION}

EVIDENCE GROUNDING RULE:
Do not insert damage facts unless grounded in direct report language. Do not insert creased shingle tabs, fractured shingles, wind uplift mechanics, structural racking, or high-wind pressure language unless those terms appear as direct quote text in the engineer’s causation sentence.`;
}

// ─── Enforcement functions (mirrored) ────────────────────────────────────────

function enforceEngineerRebuttalLowSlopeOpening(result: string, primaryScenario: string | null): string {
  if (!result || primaryScenario !== "low_slope_snow_ice_ponding") return result;
  const required = REQUIRED_LOW_SLOPE_OPENING;
  const requiredLower = required.toLowerCase();
  const lines = result.split("\n");

  const dateOfLossIdx = lines.findIndex((line) => /^\s*Date of Loss\s*:/i.test(line));
  const searchStart = dateOfLossIdx >= 0 ? dateOfLossIdx + 1 : 0;

  let firstBodyLineIdx = -1;
  for (let i = searchStart; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^(RE\s*:|Claim Number\s*:|Policy Number\s*:|Insured\s*:|Property Address\s*:|Date of Loss\s*:)/i.test(line)) continue;
    firstBodyLineIdx = i;
    break;
  }

  if (firstBodyLineIdx < 0) return `${required}\n\n${result}`.trim();

  const firstBodyLine = lines[firstBodyLineIdx].trim();
  if (firstBodyLine.toLowerCase().startsWith(requiredLower)) return result;

  lines[firstBodyLineIdx] = `${required} ${firstBodyLine}`;
  return lines.join("\n");
}

function suppressLowSlopeUnsupportedBoilerplate(result: string, supportCorpus: string): string {
  const theory = String(supportCorpus || "").toLowerCase();
  const unsupportedRules = LOW_SLOPE_FORBIDDEN_RULES.filter((rule) => {
    const supported = rule.supportTerms.some((term) => theory.includes(term.toLowerCase()));
    return !supported;
  });

  if (unsupportedRules.length === 0) return result.trim();

  const shouldRemoveSegment = (segment: string) => unsupportedRules.some((rule) => rule.regex.test(segment));

  const filteredLines = result
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (shouldRemoveSegment(trimmed)) return "";

      const sentenceChunks = trimmed.match(/[^.!?]+[.!?]?/g) || [trimmed];
      const keptChunks = sentenceChunks
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .filter((chunk) => !shouldRemoveSegment(chunk));

      if (keptChunks.length === 0) return "";
      return keptChunks.join(" ").replace(/\s{2,}/g, " ").trim();
    })
    .filter(Boolean);

  return filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function enforceLowSlopeRebuttalRequirements(result: string, primaryScenario: string | null, supportCorpus: string): string {
  if (!result || primaryScenario !== "low_slope_snow_ice_ponding") return result;

  let updated = enforceEngineerRebuttalLowSlopeOpening(result, primaryScenario);
  updated = suppressLowSlopeUnsupportedBoilerplate(updated, supportCorpus);

  const lower = updated.toLowerCase();

  const sectionsToAppend: string[] = [];

  const hasPriorityOrder = /priority order \(mandatory\)/i.test(lower)
    || /1\)\s*timing of openings/i.test(lower);
  if (!hasPriorityOrder) sectionsToAppend.push(LOW_SLOPE_PRIORITY_ORDER);

  const hasTimingFailureSection = /section\s*1\s*[—-]\s*timing failure/i.test(lower)
    || (/timing of openings/i.test(lower) && /months|years/i.test(lower) && /no objective testing|no testing|without testing|no proof/i.test(lower));
  if (!hasTimingFailureSection) sectionsToAppend.push(LOW_SLOPE_TIMING_FAILURE_SECTION);

  const hasMethodologyPack = [
    /membrane core cuts?/i,
    /seam adhesion|peel testing/i,
    /leak[-\s]path tracing/i,
    /moisture mapping/i,
  ].every((pattern) => pattern.test(updated));
  if (!hasMethodologyPack) {
    sectionsToAppend.push(`LOW-SLOPE MEMBRANE METHODOLOGY FAILURES (MANDATORY):
- no membrane core cuts
- no seam adhesion/peel testing
- no leak-path tracing
- no moisture mapping
- no proof of timing of openings`);
  }

  const hasDrainageFailureSection = /section\s*2\s*[—-]\s*drainage\s*\/\s*snowmelt analysis failure/i.test(lower)
    || (/drainage[-\s]capacity/i.test(lower) && /snow[-\s]water equivalent|runoff analysis/i.test(lower));
  if (!hasDrainageFailureSection) sectionsToAppend.push(LOW_SLOPE_DRAINAGE_FAILURE_SECTION);

  const hasContradictionAttack = /section\s*3\s*[—-]\s*engineer contradiction/i.test(lower)
    || (/snow impeded drainage/i.test(lower)
      && /standing water (was present|existed)/i.test(lower)
      && /freeze[-\s]thaw/i.test(lower)
      && /did not create or expand the openings|deterioration alone caused the loss|without proving/i.test(lower));
  if (!hasContradictionAttack) sectionsToAppend.push(LOW_SLOPE_CONTRADICTION_SECTION);

  const hasStructuralVsWatertightness = /structural snow[-\s]load analysis is not membrane watertightness analysis/i.test(lower)
    || (/structural snow[-\s]load analysis/i.test(lower) && /membrane watertightness analysis/i.test(lower));
  if (!hasStructuralVsWatertightness) {
    sectionsToAppend.push(`STRUCTURAL VS WATERTIGHTNESS DISTINCTION:
${LOW_SLOPE_STRUCTURAL_DISTINCTION} Even if framing can carry snow load, that does not prove membrane watertightness or entry-path causation.`);
  }

  if (sectionsToAppend.length > 0) {
    updated += `\n\n${sectionsToAppend.join("\n\n")}`;
  }

  return suppressLowSlopeUnsupportedBoilerplate(updated.trim(), supportCorpus);
}

interface EngineerRebuttalEnforcementContext {
  engineerStatedCause: string;
  engineerTheorySentences: string[];
  primaryScenario: string | null;
  secondaryScenarios: string[];
  criticalTestingNotPerformed: string[];
  reportText: string;
}

const DEFAULT_ENGINEER_REQUIRED_TESTS = [
  "material sampling/core verification",
  "moisture mapping",
  "leak-path tracing",
  "causation timeline analysis",
];

function parseTaggedMissingTest(testEntry: string): { scenario: string | null; testName: string } {
  const match = String(testEntry || "").match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!match) return { scenario: null, testName: String(testEntry || "").trim() };
  return {
    scenario: match[1]?.trim() || null,
    testName: match[2]?.trim() || "",
  };
}

function getEngineerRequiredTests(context: EngineerRebuttalEnforcementContext): string[] {
  const scenarioCandidates = [
    context.primaryScenario,
    ...(Array.isArray(context.secondaryScenarios) ? context.secondaryScenarios : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const scenarioFromMissing = (context.criticalTestingNotPerformed || [])
    .map((entry) => parseTaggedMissingTest(entry).scenario)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const scenarioList = Array.from(new Set([...scenarioCandidates, ...scenarioFromMissing]));
  const scenarioMappedTests = scenarioList.flatMap((scenario) => SCENARIO_MISSING_TESTING_MAP[scenario] || []);
  const taggedMissingTests = (context.criticalTestingNotPerformed || [])
    .map((entry) => parseTaggedMissingTest(entry).testName)
    .filter(Boolean);

  const merged = Array.from(new Set([...scenarioMappedTests, ...taggedMissingTests]));
  return merged.length > 0 ? merged : [...DEFAULT_ENGINEER_REQUIRED_TESTS];
}

function isTestMentionedInReport(reportText: string, testName: string): boolean {
  const textLower = String(reportText || "").toLowerCase();
  if (!textLower) return false;

  const normalizedTest = String(testName || "").toLowerCase().trim();
  if (!normalizedTest) return false;
  if (textLower.includes(normalizedTest)) return true;

  const ignoredTokens = new Set(["analysis", "testing", "review", "inspection", "proof", "assessment", "evaluation"]);
  const tokens = normalizedTest
    .split(/[\s/()\-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !ignoredTokens.has(token));

  if (tokens.length === 0) return false;
  return tokens.some((token) => textLower.includes(token));
}

function enforceEngineerRebuttalMandatorySections(result: string, context: EngineerRebuttalEnforcementContext): string {
  if (!result) return result;

  const quotedCause = String(
    context.engineerStatedCause
    || context.engineerTheorySentences?.[0]
    || "No explicit engineer causation sentence was extracted from the report."
  ).trim();

  const requiredTests = getEngineerRequiredTests(context);
  const testingLines = requiredTests.map((testName) => {
    const appears = isTestMentionedInReport(context.reportText, testName);
    return `- ${testName}: ${appears ? "Appears in report (identified in text)" : "Not documented in report"}`;
  });

  const missingCount = requiredTests.filter((testName) => !isTestMentionedInReport(context.reportText, testName)).length;
  const causationStatement = missingCount > 0
    ? `Because ${missingCount} required forensic test(s) are not documented, the engineer has not scientifically proven their conclusion and the causation statement is therefore speculative.`
    : "Core forensic tests are referenced in the report text; causation still must be tied to quantifiable, test-backed findings rather than assumption.";

  let updated = result.trim();
  const lower = updated.toLowerCase();
  const additions: string[] = [];

  if (!/engineer theory extraction/i.test(lower)) {
    additions.push(`Engineer Theory Extraction\nEngineer-stated cause (direct quote from report):\n"${quotedCause}"`);
  }

  if (!/required testing not performed/i.test(lower)) {
    additions.push(`Required Testing Not Performed\nThe following forensic testing is required to scientifically prove the engineer's causation theory, with report presence status:\n${testingLines.join("\n")}`);
  }

  const hasCausationProofFailureSection = /causation proof failure/i.test(lower);
  const hasSpeculativeFailureStatement = /has not scientifically proven their conclusion and the causation statement is therefore speculative/i.test(lower);
  if (!hasCausationProofFailureSection || (missingCount > 0 && !hasSpeculativeFailureStatement)) {
    additions.push(`Causation Proof Failure\n${causationStatement}`);
  }

  if (additions.length > 0) {
    updated += `\n\n${additions.join("\n\n")}`;
  }

  return updated;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, `../fixtures/darwin/${name}`), "utf-8");
}

const ENVISTA_REPORT_TEXT = loadFixture("engineer-snowmelt-with-wind-refs.txt");

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: DISMANTLER CLASSIFICATION
// ═════════════════════════════════════════════════════════════════════════════

describe("Harvey Memorial / Envista — dismantler classification", () => {
  const result = runEngineerReportDismantler(ENVISTA_REPORT_TEXT);

  it("primary scenario is low_slope_snow_ice_ponding", () => {
    expect(result.primaryScenario).toBe("low_slope_snow_ice_ponding");
  });

  it("engineer stated cause reflects snow/ice meltwater + age-related / maintenance-deferred", () => {
    const cause = result.engineerStatedCause.toLowerCase();
    expect(cause).toMatch(/deteriorat|maintenance|age/);
    // The conclusion sentence must reference the mechanism
    expect(cause).toMatch(/membrane|ponding|drainage|snow/);
  });

  it("criticalTestingNotPerformed includes key membrane methodology gaps", () => {
    const lowSlopeMissing = result.criticalTestingNotPerformed.filter(t =>
      t.startsWith("[low_slope_snow_ice_ponding]")
    );
    // The fixture mentions "membrane" and "seam" in the report text, so the
    // word-match heuristic may not flag those as missing. But it MUST flag
    // tests whose key words do NOT appear in the report.
    const alwaysMissingGaps = [
      "drainage-capacity analysis",
      "snow-water equivalent/runoff analysis",
      "leak-path tracing",
      "proof of timing of openings",
    ];
    for (const gap of alwaysMissingGaps) {
      expect(lowSlopeMissing).toContain(`[low_slope_snow_ice_ponding] ${gap}`);
    }
    // At minimum, more than half of the 7 required tests should be missing
    expect(lowSlopeMissing.length).toBeGreaterThanOrEqual(4);
  });

  it("isMaintenanceDenialNarrative is true", () => {
    expect(result.isMaintenanceDenialNarrative).toBe(true);
  });

  it("isDualCausation is true (snow event + deterioration narrative)", () => {
    expect(result.isDualCausation).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: PROMPT-CONTENT ASSERTIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("Harvey Memorial / Envista — prompt-content validation", () => {
  const dismantler = runEngineerReportDismantler(ENVISTA_REPORT_TEXT);
  const primarySc = dismantler.primaryScenario || "";
  const allActive = new Set([primarySc, ...dismantler.secondaryScenarios].filter(Boolean));

  const attackVectors = buildScenarioAttackVectors(primarySc, allActive);

  const engineerTheoryCorpus = String(
    dismantler.engineerStatedCause
    || dismantler.engineerTheorySentences[0]
    || ""
  ).toLowerCase();

  const windCausationTerms = Array.from(new Set(LOW_SLOPE_FORBIDDEN_RULES.flatMap((rule) => rule.supportTerms.map((term) => term.toLowerCase()))));
  const lowSlopeTheoryExplicitlyReliesOnWind = windCausationTerms.some(t => engineerTheoryCorpus.includes(t));

  const scopeGuard = buildScopeGuard(primarySc, lowSlopeTheoryExplicitlyReliesOnWind);

  const fullPrompt = attackVectors + "\n" + scopeGuard;

  // --- Required content ---
  it("contains the required low-slope opening sentence", () => {
    expect(fullPrompt).toContain(REQUIRED_LOW_SLOPE_OPENING);
  });

  it("contains membrane/drainage/freeze-thaw methodology attack language", () => {
    expect(fullPrompt).toContain("membrane core cuts");
    expect(fullPrompt).toContain("seam adhesion/peel testing");
    expect(fullPrompt).toContain("drainage-capacity analysis");
    expect(fullPrompt).toContain("snow-water equivalent/runoff analysis");
    expect(fullPrompt).toContain("leak-path tracing");
    expect(fullPrompt).toContain("moisture mapping");
    expect(fullPrompt).toContain("proof of timing of openings");
  });

  it("contains contradiction language", () => {
    expect(fullPrompt).toMatch(/snow impeded drainage/i);
    expect(fullPrompt).toMatch(/standing water/i);
    expect(fullPrompt).toMatch(/freeze-thaw/i);
    expect(fullPrompt).toMatch(/deterioration alone/i);
  });

  it("contains structural snow-load vs membrane watertightness distinction", () => {
    expect(fullPrompt).toMatch(/structural snow-?load/i);
    expect(fullPrompt).toMatch(/membrane watertightness/i);
  });

  // --- Forbidden content (unless supported by theory) ---
  it("wind-centric causation is NOT detected in engineer theory", () => {
    expect(lowSlopeTheoryExplicitlyReliesOnWind).toBe(false);
  });

  const forbiddenTerms = [
    { label: "shingle", regex: /\bshingle\b/i },
    { label: "granules/granular loss", regex: /\bgranul(?:e|ar)s?(?:\s+loss)?\b/i },
    { label: "uplift test", regex: /\buplift\s+test(?:ing|s)?\b/i },
    { label: "seal failure/factory seal", regex: /\bseal\s+failure\b|\bfactory\s+seal(?:\s+failure)?\b/i },
    { label: "thermal expansion of shingles", regex: /\bthermal\s+expansion\s+of\s+shingle(?:s)?\b/i },
    { label: "architectural shingles", regex: /\barchitectural\s+shingle(?:s)?\b/i },
    { label: "structural racking", regex: /\bstructural\s+racking\b/i },
    { label: "high wind pressure", regex: /\bhigh[-\s]?wind(?:\s+pressure)?\b|\bwind\s+pressure\b/i },
    { label: "thermal seal", regex: /\bthermal\s+seal\b/i },
    { label: "seal strip", regex: /\bseal\s+strip\b/i },
    { label: "uplift checks", regex: /\buplift\s+check/i },
    { label: "ARMA", regex: /\bARMA\b/ },
    { label: "fractured tabs", regex: /\bfractured\s+tab/i },
    { label: "fastener pull-out", regex: /\bfastener\s+pull-?out\b/i },
    { label: "wind-driven rain", regex: /\bwind-?driven\s+rain\b/i },
    { label: "hand tab test", regex: /\bhand[-\s]?tab\s+test/i },
    { label: "lift test", regex: /\blift\s+test/i },
    { label: "GAF/CertainTeed/Owens Corning", regex: /\b(?:GAF|CertainTeed|Owens\s+Corning)\b/i },
  ];

  // These terms appear in the "do NOT use" instruction list (allowed there), but
  // must NOT appear as affirmative rebuttal advice outside of the forbidden list.
  // The scope guard explicitly says "Do NOT use X" — that's the only allowed context.
  for (const { label, regex } of forbiddenTerms) {
    it(`forbidden term "${label}" does NOT appear as affirmative rebuttal methodology`, () => {
      // The attack vectors mention these terms ONLY in the "do NOT use" list.
      // Outside of that list, the methodology questions should focus on membrane/drainage.
      // Find the methodology section (after the required attack structure heading)
      const methodologyStart = attackVectors.indexOf("REQUIRED ATTACK STRUCTURE");
      expect(methodologyStart).toBeGreaterThan(-1);

      const groundingRuleStart = attackVectors.indexOf("EVIDENCE GROUNDING RULE:", methodologyStart);
      const methodologySection = groundingRuleStart > methodologyStart
        ? attackVectors.slice(methodologyStart, groundingRuleStart)
        : attackVectors.slice(methodologyStart);
      expect(methodologySection).not.toMatch(regex);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: FINAL-OUTPUT ENFORCEMENT (post-processing path)
// ═════════════════════════════════════════════════════════════════════════════

describe("Harvey Memorial / Envista — final-output enforcement", () => {
  const dismantler = runEngineerReportDismantler(ENVISTA_REPORT_TEXT);
  const engineerTheoryCorpus = String(
    dismantler.engineerStatedCause
    || dismantler.engineerTheorySentences[0]
    || ""
  ).toLowerCase();

  // Simulate a raw AI-generated rebuttal with wind/shingle boilerplate injected
  const SAMPLE_RAW_REBUTTAL = `RE: Rebuttal to Engineering Report
Claim Number: HM-2026-001
Policy Number: POL-12345
Insured: Harvey Memorial
Property Address: 789 Industrial Blvd, Minneapolis MN
Date of Loss: January 2026

We have reviewed the engineering report and find it fundamentally flawed.

The shingle damage observed on the property is inconsistent with the engineer's conclusions.
The ARMA Technical Bulletin 201 and GAF guidance documents that seal strip adhesion degrades over time.
The engineer failed to perform uplift checks, uplift tests, hand tab tests, and lift tests on the affected areas.
Granules and granular loss patterns suggest storm-related damage rather than normal aging.
The fractured tabs and fractured shingles observed are consistent with wind uplift mechanics and wind-driven rain penetration.
Fastener pull-out testing was not performed, undermining the engineer's conclusions.
Thermal sealing analysis was omitted from the inspection.
The report references seal failure, factory seal concerns, and thermal expansion of shingles.
Architectural shingles showed structural racking and high wind pressure effects in multiple areas.

The membrane seams near the drainage obstruction area showed signs of stress.
The engineer performed no membrane core cuts to determine water intrusion pathways.
No seam adhesion or peel testing was conducted.
No drainage-capacity analysis was performed to evaluate the drain system.
No snow-water equivalent or runoff analysis was performed.
No leak-path tracing was conducted from entry to interior damage.
No moisture mapping was performed.
There is no proof of timing of openings in the membrane.

The engineer's methodology was fundamentally inadequate for a low-slope membrane system.`;

  const enforced = enforceLowSlopeRebuttalRequirements(
    SAMPLE_RAW_REBUTTAL,
    "low_slope_snow_ice_ponding",
    engineerTheoryCorpus,
  );

  const enforcedWithMandatorySections = enforceEngineerRebuttalMandatorySections(enforced, {
    engineerStatedCause: dismantler.engineerStatedCause,
    engineerTheorySentences: dismantler.engineerTheorySentences,
    primaryScenario: dismantler.primaryScenario,
    secondaryScenarios: dismantler.secondaryScenarios,
    criticalTestingNotPerformed: dismantler.criticalTestingNotPerformed,
    reportText: ENVISTA_REPORT_TEXT,
  });

  it("output starts with the required low-slope opening", () => {
    // Find the first non-header body line
    const lines = enforced.split("\n");
    const headerPrefixes = ["RE:", "Claim Number:", "Policy Number:", "Insured:", "Property Address:", "Date of Loss:"];
    let firstBodyLine = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (headerPrefixes.some(p => trimmed.startsWith(p))) continue;
      firstBodyLine = trimmed;
      break;
    }
    expect(firstBodyLine.startsWith(REQUIRED_LOW_SLOPE_OPENING)).toBe(true);
  });

  it("includes membrane methodology failures section", () => {
    expect(enforced).toMatch(/membrane core cuts?/i);
    expect(enforced).toMatch(/seam adhesion|peel testing/i);
    expect(enforced).toMatch(/drainage[-\s]capacity analysis/i);
    expect(enforced).toMatch(/snow[-\s]water equivalent|runoff analysis/i);
    expect(enforced).toMatch(/leak[-\s]path tracing/i);
    expect(enforced).toMatch(/moisture mapping/i);
    expect(enforced).toMatch(/proof of timing of openings|timing of openings/i);
  });

  it("includes contradiction block", () => {
    expect(enforced).toMatch(/snow impeded drainage/i);
    expect(enforced).toMatch(/standing water/i);
    expect(enforced).toMatch(/freeze[-\s]thaw/i);
    expect(enforced).toMatch(/without proving deterioration alone caused the loss|deterioration alone caused the loss/i);
  });

  it("includes structural vs membrane distinction", () => {
    expect(enforced).toMatch(/structural snow[-\s]load analysis/i);
    expect(enforced).toMatch(/membrane watertightness analysis/i);
  });

  it("strips unsupported wind/shingle boilerplate", () => {
    // The engineer theory corpus for this report does NOT contain shingle/ARMA/etc.
    // so these lines should have been removed by suppressLowSlopeUnsupportedBoilerplate
    expect(enforced).not.toMatch(/\bshingle\b/i);
    expect(enforced).not.toMatch(/\bARMA\b/i);
    expect(enforced).not.toMatch(/\buplift\s+check/i);
    expect(enforced).not.toMatch(/\buplift\s+test(?:ing|s)?\b/i);
    expect(enforced).not.toMatch(/\bgranul(?:e|ar)s?(?:\s+loss)?\b/i);
    expect(enforced).not.toMatch(/\bseal\s+failure\b/i);
    expect(enforced).not.toMatch(/\bfactory\s+seal(?:\s+failure)?\b/i);
    expect(enforced).not.toMatch(/\bthermal\s+expansion\s+of\s+shingle(?:s)?\b/i);
    expect(enforced).not.toMatch(/\barchitectural\s+shingle(?:s)?\b/i);
    expect(enforced).not.toMatch(/\bstructural\s+racking\b/i);
    expect(enforced).not.toMatch(/\bhigh[-\s]?wind(?:\s+pressure)?\b|\bwind\s+pressure\b/i);
    expect(enforced).not.toMatch(/\bfractured\s+tab/i);
    expect(enforced).not.toMatch(/\bfractured\s+shingle/i);
    expect(enforced).not.toMatch(/\bfastener\s+pull-?out\b/i);
    expect(enforced).not.toMatch(/\bthermal\s+seal/i);
    expect(enforced).not.toMatch(/\bseal\s+strip/i);
    expect(enforced).not.toMatch(/\bwind-?driven\s+rain\b/i);
    expect(enforced).not.toMatch(/\bhand[-\s]?tab\s+test/i);
    expect(enforced).not.toMatch(/\blift\s+test/i);
    expect(enforced).not.toMatch(/\b(?:GAF|CertainTeed|Owens\s+Corning)\b/i);
    expect(enforced).not.toMatch(/\bwind\s+uplift\s+mechanics?\b/i);
  });

  it("retains legitimate membrane-focused content", () => {
    expect(enforced).toMatch(/membrane seam/i);
    expect(enforced).toMatch(/drainage obstruction/i);
    expect(enforced).toMatch(/low-slope membrane/i);
  });

  it("includes Engineer Theory Extraction section with direct quoted cause", () => {
    expect(enforcedWithMandatorySections).toMatch(/Engineer Theory Extraction/i);
    expect(enforcedWithMandatorySections).toContain(`"${dismantler.engineerStatedCause}"`);
  });

  it("includes Required Testing Not Performed section with report presence status", () => {
    expect(enforcedWithMandatorySections).toMatch(/Required Testing Not Performed/i);
    expect(enforcedWithMandatorySections).toMatch(/membrane core cuts/i);
    expect(enforcedWithMandatorySections).toMatch(/Not documented in report|Appears in report/i);
  });

  it("includes Causation Proof Failure section with speculative-causation statement when testing is missing", () => {
    expect(enforcedWithMandatorySections).toMatch(/Causation Proof Failure/i);
    expect(enforcedWithMandatorySections).toMatch(/has not scientifically proven their conclusion and the causation statement is therefore speculative/i);
  });
});
