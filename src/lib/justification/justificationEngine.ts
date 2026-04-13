/**
 * Line Item Justification Engine v2
 * Weighted confidence, system-based reasoning, weak language filtering.
 * Three authority layers: Manufacturer (40%), Code (30%), Policy (30%).
 */

import { normalizeLineItem } from "./lineItemTaxonomy";
import { getManufacturerRequirements } from "./manufacturerRequirements";
import { getCodeRequirements, getStateCodeInfo } from "./codeRequirements";
import { getSystemForTrade, getItemFunction } from "./systemMapping";
import { filterWeakLanguage } from "./weakLanguageFilter";

export type ConfidenceLevel = "direct" | "inferred" | "needs_evidence";
export type ConfidenceLabel = "High" | "Medium" | "Low";

export interface JustificationResult {
  normalizedItem: string;
  trade: string;
  system: string;
  whyRequired: string;
  manufacturer: {
    text: string;
    functionText: string;
    failureRisk: string;
    confidence: ConfidenceLevel;
    manufacturer?: string;
  };
  code: {
    text: string;
    confidence: ConfidenceLevel;
    reference: string;
  };
  policy: {
    text: string;
    confidence: ConfidenceLevel;
  };
  missingEvidence: string[];
  confidenceScore: number;
  confidenceLabel: ConfidenceLabel;
  supportStrength: ConfidenceLevel;
  inlineNote: string;
  carrierFacingText: string;
}

interface JustifyLineItemArgs {
  rawDescription: string;
  stateCode: string;
  manufacturer?: string | null;
  policyText?: string | null;
  lossType?: string | null;
  quantity?: number;
  unit?: string;
}

// Expanded missing evidence rules
const MISSING_EVIDENCE_RULES: { test: (item: string) => boolean; flag: string }[] = [
  { test: (i) => i === "Roof Decking", flag: "Full decking replacement requires documented proof of substrate damage and fastening failure. Provide photo or inspection evidence." },
  { test: (i) => i === "Drywall Replace", flag: "Full drywall replacement requires evidence that repair is not feasible. Provide documentation of damage extent." },
  { test: (i) => i === "Code Upgrade", flag: "Code upgrade requires confirmed ordinance or law coverage in the policy. Verify coverage before including." },
  { test: (i) => i === "Tear-Off", flag: "Tear-off requires confirmation of existing layer count and local code limit on overlay. Verify before proceeding." },
  { test: (i) => i.includes("Replace") && i !== "Drywall Replace", flag: "Full replacement scope requires repairability limitation evidence. Document why repair is insufficient." },
  { test: (i) => i.includes("Detach") || i.includes("Reset"), flag: "Detach and reset scope requires access justification. Document why removal is necessary to complete adjacent repairs." },
  { test: (i) => i === "Window" || i === "Window Screen", flag: "Window replacement or repair requires documented impact damage or seal failure evidence." },
];

// Matching items need explicit policy support
const MATCHING_ITEMS = ["Field Shingles", "Vinyl Siding", "Fiber Cement Siding", "Paint"];

const CONFIDENCE_WEIGHTS = { manufacturer: 0.4, code: 0.3, policy: 0.3 };
const LEVEL_SCORES: Record<ConfidenceLevel, number> = { direct: 100, inferred: 60, needs_evidence: 20 };

function computeConfidence(
  mfr: ConfidenceLevel,
  code: ConfidenceLevel,
  policy: ConfidenceLevel,
  missingCount: number
): { score: number; label: ConfidenceLabel; strength: ConfidenceLevel } {
  const raw =
    LEVEL_SCORES[mfr] * CONFIDENCE_WEIGHTS.manufacturer +
    LEVEL_SCORES[code] * CONFIDENCE_WEIGHTS.code +
    LEVEL_SCORES[policy] * CONFIDENCE_WEIGHTS.policy;

  const score = Math.max(5, Math.min(100, Math.round(raw) - missingCount * 10));
  const label: ConfidenceLabel = score >= 75 ? "High" : score >= 45 ? "Medium" : "Low";
  const strength: ConfidenceLevel = score >= 75 ? "direct" : score >= 45 ? "inferred" : "needs_evidence";
  return { score, label, strength };
}

export function justifyLineItem(args: JustifyLineItemArgs): JustificationResult {
  const { rawDescription, stateCode, manufacturer, policyText, quantity, unit } = args;
  const { normalized, trade } = normalizeLineItem(rawDescription);
  const systemDef = getSystemForTrade(trade);
  const itemFunction = getItemFunction(normalized, trade);

  // Layer 1: Manufacturer (function-first)
  const mfrReqs = getManufacturerRequirements(normalized, manufacturer);
  const mfrBest = mfrReqs[0];
  let mfrConfidence: ConfidenceLevel;
  let mfrText: string;
  let mfrFunctionText: string;
  let mfrFailureRisk: string;

  if (mfrBest) {
    mfrText = mfrBest.requirementText;
    mfrFunctionText = mfrBest.functionText;
    mfrFailureRisk = mfrBest.failureRisk;
    mfrConfidence = mfrBest.confidence;
    // Validate reasoning strength
    if (!mfrBest.functionText || mfrBest.functionText.length < 20) {
      mfrConfidence = "inferred";
    }
  } else {
    mfrText = "No manufacturer-specific requirement identified. Component must be installed per applicable manufacturer installation instructions.";
    mfrFunctionText = `This component ${itemFunction}.`;
    mfrFailureRisk = "Omission compromises the integrity of the installed system.";
    mfrConfidence = "inferred";
  }

  // Layer 2: Code (strict: use verified section or fallback only)
  const { stateInfo, requirements: codeReqs } = getCodeRequirements(normalized, stateCode);
  const codeBest = codeReqs[0];
  const codeResult = {
    text: codeBest.requirementText,
    confidence: codeBest.confidence,
    reference: codeBest.codeReference,
  };

  // Layer 3: Policy (deep extraction, never fabricate)
  let policyResult: { text: string; confidence: ConfidenceLevel };
  if (policyText && policyText.length > 10) {
    const lower = policyText.toLowerCase();
    const parts: string[] = [];

    // Extract actual meaning, not just keywords
    if (lower.includes("matching") || lower.includes("uniform appearance") || lower.includes("like kind and quality")) {
      if (MATCHING_ITEMS.includes(normalized)) {
        parts.push("Policy contains matching or uniform appearance provisions that support like-kind restoration of this component to maintain visual consistency with undamaged areas.");
      }
    }
    if (lower.includes("ordinance") || lower.includes("law coverage") || lower.includes("building code")) {
      parts.push("Policy includes ordinance or law coverage supporting the cost of code-required upgrades during covered repairs.");
    }
    if (lower.includes("tear") || lower.includes("removal") || lower.includes("tear-out")) {
      parts.push("Policy covers necessary tear-out and removal as part of the restoration process when required to access or replace damaged components.");
    }
    if (lower.includes("replacement cost") || lower.includes("rcv")) {
      parts.push("Policy provides replacement cost value coverage, supporting restoration with new materials of like kind and quality.");
    }

    if (parts.length > 0) {
      policyResult = { text: parts.join(" "), confidence: "direct" };
    } else {
      policyResult = { text: "Policy reviewed. Standard loss settlement terms apply to this line item. No specific endorsement language identified for this component.", confidence: "inferred" };
    }
  } else {
    policyResult = { text: "Policy-specific support not available. General loss settlement principles apply to restore the damaged property.", confidence: "needs_evidence" };
  }

  // Missing evidence evaluation
  const missingEvidence: string[] = [];
  for (const rule of MISSING_EVIDENCE_RULES) {
    if (rule.test(normalized)) {
      missingEvidence.push(rule.flag);
    }
  }
  // Matching items without policy support
  if (MATCHING_ITEMS.includes(normalized) && policyResult.confidence !== "direct") {
    missingEvidence.push("Matching scope requires explicit policy support for uniform appearance. Verify matching provisions exist in the policy.");
  }

  // Weighted confidence
  const { score, label, strength } = computeConfidence(
    mfrConfidence,
    codeResult.confidence,
    policyResult.confidence,
    missingEvidence.length
  );

  // Downgrade manufacturer confidence if reasoning is weak
  const adjustedMfrConfidence = mfrConfidence;

  // System-based whyRequired
  const whyRequired = `${normalized} ${itemFunction}. This component is integral to the ${systemDef.system} and must be restored to maintain system performance and code compliance.`;

  // Inline note (filtered for weak language)
  const rawInline = mfrBest
    ? `${normalized}: ${mfrBest.functionText.split(".")[0]}. ${codeBest.requirementText.split(".")[0]}.`
    : `${normalized}: Required per adopted building code (${stateInfo.adoptedCode}, ${stateInfo.codeYear}).`;
  const { text: inlineNote } = filterWeakLanguage(rawInline);

  // Carrier-facing text (strict 5-sentence structure)
  const qtyStr = quantity && unit ? ` at ${quantity} ${unit}` : "";
  const carrierFacingText = buildCarrierText(normalized, trade, qtyStr, systemDef, itemFunction, { text: mfrText, functionText: mfrFunctionText, confidence: adjustedMfrConfidence, manufacturer: mfrBest?.manufacturer }, codeResult, policyResult, stateInfo, score);

  return {
    normalizedItem: normalized,
    trade,
    system: systemDef.system,
    whyRequired,
    manufacturer: { text: mfrText, functionText: mfrFunctionText, failureRisk: mfrFailureRisk, confidence: adjustedMfrConfidence, manufacturer: mfrBest?.manufacturer },
    code: codeResult,
    policy: policyResult,
    missingEvidence,
    confidenceScore: score,
    confidenceLabel: label,
    supportStrength: strength,
    inlineNote,
    carrierFacingText,
  };
}

function buildCarrierText(
  item: string,
  trade: string,
  qtyStr: string,
  systemDef: { system: string },
  itemFunction: string,
  mfr: { text: string; functionText: string; confidence: string; manufacturer?: string },
  code: { text: string; reference: string; confidence: string },
  policy: { text: string; confidence: string },
  stateInfo: { adoptedCode: string; codeYear: string },
  confidenceScore: number
): string {
  const sentences: string[] = [];

  // Sentence 1: What + why (functional)
  sentences.push(
    `${item}${qtyStr} is necessary to restore the ${systemDef.system} to its pre-loss condition. This component ${itemFunction}.`
  );

  // Sentence 2: Manufacturer/system reasoning (only if confidence >50)
  if (confidenceScore > 50 && mfr.confidence !== "needs_evidence") {
    const { text: filtered } = filterWeakLanguage(mfr.functionText);
    sentences.push(filtered);
  }

  // Sentence 3: Code compliance
  if (code.confidence === "direct") {
    sentences.push(
      `This component is required per adopted building code (${stateInfo.adoptedCode}, ${stateInfo.codeYear} edition, ${code.reference}).`
    );
  } else {
    sentences.push(
      `This component must comply with adopted building code (${stateInfo.adoptedCode}, ${stateInfo.codeYear} edition). Specific section not identified.`
    );
  }

  // Sentence 4: Policy tie-in (only if available and relevant)
  if (policy.confidence === "direct") {
    const { text: filtered } = filterWeakLanguage(policy.text);
    sentences.push(filtered);
  }

  // Sentence 5: Consequence of omission
  if (confidenceScore >= 45) {
    sentences.push(
      `Omission of this item would result in an incomplete repair that fails to meet manufacturer installation requirements and applicable building code, leaving the property vulnerable to further damage.`
    );
  } else {
    sentences.push(
      `This item may be needed to complete a code-compliant repair. Additional documentation is recommended to substantiate the scope.`
    );
  }

  return sentences.join(" ");
}

/**
 * Batch-justify an array of line items.
 */
export function justifyLineItems(
  items: Array<{ description: string; quantity?: number; unit?: string; code?: string }>,
  context: { stateCode: string; manufacturer?: string | null; policyText?: string | null; lossType?: string | null }
): JustificationResult[] {
  return items.map((item) =>
    justifyLineItem({
      rawDescription: item.description || item.code || "",
      stateCode: context.stateCode,
      manufacturer: context.manufacturer,
      policyText: context.policyText,
      lossType: context.lossType,
      quantity: item.quantity,
      unit: item.unit,
    })
  );
}
