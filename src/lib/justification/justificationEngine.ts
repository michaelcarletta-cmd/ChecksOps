/**
 * Line Item Justification Engine
 * Orchestrates three authority layers: Manufacturer, Code, Policy.
 * Returns structured justification per line item.
 */

import { normalizeLineItem } from "./lineItemTaxonomy";
import { getManufacturerRequirements } from "./manufacturerRequirements";
import { getCodeRequirements, getStateCodeInfo } from "./codeRequirements";

export interface JustificationResult {
  normalizedItem: string;
  trade: string;
  whyRequired: string;
  manufacturer: {
    text: string;
    confidence: "direct" | "inferred" | "needs_evidence";
    manufacturer?: string;
  };
  code: {
    text: string;
    confidence: "direct" | "inferred" | "needs_evidence";
    reference: string;
  };
  policy: {
    text: string;
    confidence: "direct" | "inferred" | "needs_evidence";
  };
  missingEvidence: string[];
  confidenceScore: number;
  supportStrength: "direct" | "inferred" | "needs_evidence";
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

const MISSING_EVIDENCE_RULES: { item: string; flag: string }[] = [
  { item: "Roof Decking", flag: "Decking replacement claimed without proof of damage to substrate. Provide photo or inspection evidence." },
  { item: "Drywall Replace", flag: "Full drywall replacement claimed. Provide evidence that repair is not feasible." },
  { item: "Code Upgrade", flag: "Code upgrade claimed without confirmed ordinance or law coverage in policy." },
  { item: "Tear-Off", flag: "Tear-off claimed. Confirm existing layer count and local code limit." },
];

export function justifyLineItem(args: JustifyLineItemArgs): JustificationResult {
  const { rawDescription, stateCode, manufacturer, policyText, quantity, unit } = args;
  const { normalized, trade } = normalizeLineItem(rawDescription);

  // Layer 1: Manufacturer
  const mfrReqs = getManufacturerRequirements(normalized, manufacturer);
  const mfrBest = mfrReqs[0];
  const mfrResult = mfrBest
    ? { text: mfrBest.requirementText, confidence: mfrBest.confidence, manufacturer: mfrBest.manufacturer }
    : { text: "No specific manufacturer requirement on file. General industry standards apply.", confidence: "inferred" as const };

  // Layer 2: Code
  const { stateInfo, requirements: codeReqs } = getCodeRequirements(normalized, stateCode);
  const codeBest = codeReqs[0];
  const codeResult = {
    text: codeBest.requirementText,
    confidence: codeBest.confidence,
    reference: codeBest.codeReference,
  };

  // Layer 3: Policy
  let policyResult: { text: string; confidence: "direct" | "inferred" | "needs_evidence" };
  if (policyText && policyText.length > 10) {
    // Try to extract relevant provisions
    const lower = policyText.toLowerCase();
    const hasMatching = lower.includes("matching") || lower.includes("uniform appearance");
    const hasOrdinance = lower.includes("ordinance") || lower.includes("law");
    const hasTearOut = lower.includes("tear") || lower.includes("removal");

    const parts: string[] = [];
    if (hasMatching) parts.push("Policy contains matching/uniform appearance provisions supporting like-kind restoration.");
    if (hasOrdinance) parts.push("Policy includes ordinance or law coverage supporting code-required upgrades.");
    if (hasTearOut) parts.push("Policy covers tear-out and removal as part of the repair process.");

    if (parts.length > 0) {
      policyResult = { text: parts.join(" "), confidence: "direct" };
    } else {
      policyResult = { text: "Policy provisions reviewed. Standard loss settlement terms apply to this line item.", confidence: "inferred" };
    }
  } else {
    policyResult = { text: "Policy text not available for direct reference. General loss settlement logic applies.", confidence: "needs_evidence" };
  }

  // Missing evidence flags
  const missingEvidence: string[] = [];
  for (const rule of MISSING_EVIDENCE_RULES) {
    if (normalized.toLowerCase().includes(rule.item.toLowerCase())) {
      missingEvidence.push(rule.flag);
    }
  }

  // Confidence score
  const scores = [mfrResult.confidence, codeResult.confidence, policyResult.confidence];
  const scoreMap = { direct: 90, inferred: 60, needs_evidence: 30 };
  const avg = Math.round(scores.reduce((s, c) => s + scoreMap[c], 0) / scores.length);
  const finalScore = Math.max(10, Math.min(100, avg - missingEvidence.length * 10));

  const supportStrength: "direct" | "inferred" | "needs_evidence" =
    finalScore >= 75 ? "direct" : finalScore >= 45 ? "inferred" : "needs_evidence";

  // Why required (1 sentence)
  const whyRequired = `${normalized} is required to restore the ${trade} system to its pre-loss condition and comply with manufacturer installation standards and adopted building code.`;

  // Inline note (1-2 sentences)
  const inlineNote = mfrBest
    ? `${normalized}: ${mfrBest.requirementText.split(".")[0]}. ${codeBest.requirementText.split(".")[0]}.`
    : `${normalized}: Required per adopted building code (${stateInfo.adoptedCode}, ${stateInfo.codeYear}).`;

  // Carrier-facing text (professional, no markdown/bullets/symbols)
  const qtyStr = quantity && unit ? ` at ${quantity} ${unit}` : "";
  const carrierFacingText = buildCarrierText(normalized, trade, qtyStr, mfrResult, codeResult, policyResult, stateInfo);

  return {
    normalizedItem: normalized,
    trade,
    whyRequired,
    manufacturer: mfrResult,
    code: codeResult,
    policy: policyResult,
    missingEvidence,
    confidenceScore: finalScore,
    supportStrength,
    inlineNote,
    carrierFacingText,
  };
}

function buildCarrierText(
  item: string,
  trade: string,
  qtyStr: string,
  mfr: { text: string; confidence: string },
  code: { text: string; reference: string },
  policy: { text: string; confidence: string },
  stateInfo: { adoptedCode: string; codeYear: string }
): string {
  const sentences: string[] = [];

  sentences.push(
    `${item}${qtyStr} is necessary to perform proper ${trade} replacement and restore the damaged system to its pre-loss condition.`
  );

  if (mfr.confidence === "direct") {
    sentences.push(mfr.text);
  }

  sentences.push(
    `This component is required to comply with the adopted building code (${stateInfo.adoptedCode}, ${stateInfo.codeYear} edition, ${code.reference}).`
  );

  if (policy.confidence === "direct") {
    sentences.push(policy.text);
  }

  sentences.push(
    "Omission of this item would result in an incomplete repair that fails to meet industry standards and applicable building code requirements."
  );

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
