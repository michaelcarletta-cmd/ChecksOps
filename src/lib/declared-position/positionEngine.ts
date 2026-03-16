import {
  DarwinDeclaredPosition,
  OutputDriftResult,
  PositionScoreResult,
  PositionValidationResult,
} from "@/types/darwinDeclaredPosition";

function hasText(value?: string | null) {
  return !!value && value.trim().length > 0;
}

function weakPhrase(value: string) {
  const weakPatterns = [
    /\bstorm damage\b/i,
    /\bthey were wrong\b/i,
    /\bbad faith\b/i,
    /\brepair not possible\b/i,
    /\bfull replacement needed\b/i,
    /\bcovered\b/i,
    /\bnot covered\b/i,
    /\bwear and tear\b/i,
  ];
  return weakPatterns.some((p) => p.test(value));
}

/**
 * Tokenize a text into lowercased, cleaned tokens for concept matching.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

/**
 * Calculate concept/token coverage between a declared field and generated output.
 * Returns a ratio 0-1 of how many declared concept tokens appear in the output.
 */
function conceptCoverage(declaredField: string, outputText: string): number {
  const declaredTokens = tokenize(declaredField);
  if (declaredTokens.size === 0) return 1;

  const outputTokens = tokenize(outputText);
  let matched = 0;
  for (const token of declaredTokens) {
    if (outputTokens.has(token)) matched++;
  }
  return matched / declaredTokens.size;
}

export function buildMasterPositionStatement(
  position: Partial<DarwinDeclaredPosition>
): string | null {
  if (
    !hasText(position.requested_remedy) ||
    !hasText(position.primary_loss_mechanism) ||
    !hasText(position.observed_damage_condition) ||
    !hasText(position.decisive_contradiction) ||
    !hasText(position.specific_carrier_failure)
  ) {
    return null;
  }

  return `Darwin should advocate for ${position.requested_remedy?.trim()} because ${position.primary_loss_mechanism?.trim()} produced ${position.observed_damage_condition?.trim()}, the carrier's contrary position is defective due to ${position.specific_carrier_failure?.trim()}, and that position is defeated by ${position.decisive_contradiction?.trim()}.`;
}

export function validateDeclaredPosition(
  position: Partial<DarwinDeclaredPosition>,
  targetLock: "draft" | "strategic_lock" | "litigation_grade" = "draft"
): PositionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const blockingRiskFlags: string[] = [];

  const requiredForStrategicLock: Array<[string, string | undefined | null]> = [
    ["Observed Damage Condition", position.observed_damage_condition],
    ["Primary Loss Mechanism", position.primary_loss_mechanism],
    ["Coverage Trigger Theory", position.coverage_trigger_theory],
    ["Specific Carrier Failure", position.specific_carrier_failure],
    ["Decisive Contradiction", position.decisive_contradiction],
    ["Requested Remedy", position.requested_remedy],
  ];

  if (targetLock === "strategic_lock" || targetLock === "litigation_grade") {
    for (const [field, value] of requiredForStrategicLock) {
      if (!hasText(String(value || ""))) {
        errors.push(`${field} is required`);
      }
    }
  }

  const strategicFields = [
    position.observed_damage_condition,
    position.primary_loss_mechanism,
    position.coverage_trigger_theory,
    position.specific_carrier_failure,
    position.decisive_contradiction,
    position.requested_remedy,
  ].filter(Boolean) as string[];

  for (const field of strategicFields) {
    if (weakPhrase(field)) {
      warnings.push(`Field contains weak/vague phrasing: "${field.slice(0, 60)}..."`);
    }
    if (field.trim().length < 20) {
      warnings.push(`Field may be too short to be strategically useful: "${field}"`);
    }
  }

  if (targetLock === "strategic_lock") {
    if (!position.key_supporting_evidence || position.key_supporting_evidence.length < 1) {
      errors.push("At least one Key Supporting Evidence item is required");
    }
  }

  if (targetLock === "litigation_grade") {
    if (!position.key_supporting_evidence || position.key_supporting_evidence.length < 2) {
      errors.push("At least two Key Supporting Evidence items are required");
    }
    if (!position.policy_standard_support || position.policy_standard_support.length < 1) {
      errors.push("At least one Policy / Standard Support item is required");
    }
    if (!position.carrier_evidence_rebutted || position.carrier_evidence_rebutted.length < 1) {
      errors.push("At least one Carrier Evidence Being Rebutted item is required");
    }
  }

  const weaknesses = position.known_weaknesses || [];
  const missingProof = position.missing_proof_needed || [];

  if (targetLock === "litigation_grade" && missingProof.length > 2) {
    blockingRiskFlags.push("Too many unresolved missing proof items for litigation-grade lock");
  }

  if (
    targetLock === "litigation_grade" &&
    weaknesses.some((w) => /no expert|no policy|unclear date|no causation/i.test(w))
  ) {
    blockingRiskFlags.push("Critical unresolved weakness prevents litigation-grade lock");
  }

  return {
    valid: errors.length === 0 && blockingRiskFlags.length === 0,
    errors,
    warnings,
    blockingRiskFlags,
  };
}

export function scoreDeclaredPosition(
  position: Partial<DarwinDeclaredPosition>
): PositionScoreResult {
  let score = 0;
  const reasons: string[] = [];

  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (hasText(position.observed_damage_condition)) add(10, "Observed damage defined");
  if (hasText(position.primary_loss_mechanism)) add(15, "Loss mechanism defined");
  if (hasText(position.coverage_trigger_theory)) add(15, "Coverage trigger defined");
  if (hasText(position.specific_carrier_failure)) add(15, "Carrier failure defined");
  if (hasText(position.decisive_contradiction)) add(15, "Decisive contradiction defined");
  if (hasText(position.requested_remedy)) add(10, "Requested remedy defined");

  const evidenceCount = position.key_supporting_evidence?.length || 0;
  const policyCount = position.policy_standard_support?.length || 0;
  const rebuttedCount = position.carrier_evidence_rebutted?.length || 0;

  if (evidenceCount >= 1) add(5, "Has core evidence anchors");
  if (evidenceCount >= 3) add(5, "Has multiple evidence anchors");
  if (policyCount >= 1) add(5, "Has policy/standard support");
  if (rebuttedCount >= 1) add(5, "Has identified carrier evidence being rebutted");

  const weaknessCount = position.known_weaknesses?.length || 0;
  const missingProofCount = position.missing_proof_needed?.length || 0;

  score -= weaknessCount * 4;
  score -= missingProofCount * 3;

  if (position.master_position_statement) add(5, "Master position statement present");

  score = Math.max(0, Math.min(100, score));

  let label: "fragile" | "moderate" | "strong" = "fragile";
  if (score >= 75) label = "strong";
  else if (score >= 45) label = "moderate";

  let driftRisk: "low" | "medium" | "high" = "high";
  if (score >= 75) driftRisk = "low";
  else if (score >= 45) driftRisk = "medium";

  return { score, label, driftRisk, reasons };
}

/**
 * Required section headers in carrier-facing output.
 */
const REQUIRED_OUTPUT_SECTIONS = [
  "Cause of Loss",
  "Coverage Analysis",
  "Carrier Error",
  "Decisive Contradiction",
  "Requested Remedy",
];

/**
 * Minimum concept/token coverage ratio to consider a field adequately represented.
 */
const MIN_CONCEPT_COVERAGE = 0.35;

export function detectOutputDrift(
  position: Partial<DarwinDeclaredPosition>,
  outputText: string
): OutputDriftResult {
  const reasons: string[] = [];
  const textLower = outputText.toLowerCase();

  // Check required section presence
  for (const section of REQUIRED_OUTPUT_SECTIONS) {
    if (!textLower.includes(section.toLowerCase())) {
      reasons.push(`Output missing required section: "${section}"`);
    }
  }

  // Check concept/token coverage for each declared field
  const coverageChecks: Array<[string, string | undefined | null]> = [
    ["primary loss mechanism", position.primary_loss_mechanism],
    ["coverage trigger theory", position.coverage_trigger_theory],
    ["specific carrier failure", position.specific_carrier_failure],
    ["decisive contradiction", position.decisive_contradiction],
    ["requested remedy", position.requested_remedy],
  ];

  for (const [label, value] of coverageChecks) {
    if (value && value.trim().length > 0) {
      const coverage = conceptCoverage(value, outputText);
      if (coverage < MIN_CONCEPT_COVERAGE) {
        reasons.push(
          `Generated output may drift from declared ${label} (concept coverage: ${Math.round(coverage * 100)}%)`
        );
      }
    }
  }

  return {
    passes: reasons.length === 0,
    reasons,
  };
}
