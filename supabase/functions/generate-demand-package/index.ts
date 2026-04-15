import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "../_shared/ai/generate.ts";
// Using Lovable AI gateway instead of OpenAI Responses API for reliability

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Json = Record<string, unknown>;
type DemandMode = "standard" | "proven";
type PolicyMatchConfidence = "none" | "low" | "medium" | "high";
type PolicyReferenceMode = "general_only" | "qualified_reference" | "claim_specific";

interface PolicyMatchResult {
  confidence: PolicyMatchConfidence;
  score: number;
  referenceMode: PolicyReferenceMode;
  matchedFiles: string[];
  rationale: string[];
  hasPolicyFiles: boolean;
  hasCarrierMatch: boolean;
  hasPolicyNumberMatch: boolean;
  hasStateMatch: boolean;
  hasDeclarationsIndicator: boolean;
  genericFileCount: number;
}

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  new_hampshire: "NH",
  new_jersey: "NJ",
  new_mexico: "NM",
  new_york: "NY",
  north_carolina: "NC",
  north_dakota: "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  rhode_island: "RI",
  south_carolina: "SC",
  south_dakota: "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  west_virginia: "WV",
  wisconsin: "WI",
  wyoming: "WY",
  district_of_columbia: "DC",
};
const PROVEN_MODE_RULES = `
You are generating a claim documentation package in "Proven Mode".

CRITICAL INSTRUCTIONS:
- Maintain authority but remain procedurally respectful
- Do NOT use adversarial or demanding language
- Do NOT instruct the carrier what they "must" do
- Frame all conclusions as supported by documentation
- Position all findings as assisting the carrier's investigation
- Use policy language from the provided policy documents to support coverage position where available
- Quote or paraphrase only policy language present in provided materials; do not invent provisions

REQUIRED LANGUAGE STYLE:
- Use phrases like:
  - "based on observed conditions"
  - "consistent with"
  - "supports the conclusion that"
  - "documentation indicates"
  - "warrants consideration for"
- Avoid phrases like:
  - "must pay"
  - "bad faith"
  - "clearly covered"
  - "failure to"

TONE:
- Professional
- Neutral but confident
- Cooperative, not submissive
- Authoritative without being confrontational
`;

const PROVEN_MODE_POLICY_RULES = `
PROVEN MODE POLICY UTILIZATION (CRITICAL):
- Treat policy documents (declarations, forms, endorsements, conditions, exclusions, exceptions, and definitions) as primary evidence when present.
- Build a "policy support chain": observed condition -> loss mechanism -> applicable policy language -> coverage-supporting interpretation.
- If policy language supports the claim, explain how the documented facts are consistent with that language.
- If exclusions are present, analyze whether exceptions, carve-backs, ensuing loss language, or burden-of-proof limits (if supported by provided documents) warrant consideration for coverage.
- Cite policy wording in plain language and, where available, reference section labels exactly as shown in the provided policy documents.
- Do not fabricate policy citations or quote text that is not present in the provided materials.
- If policy documents are missing or incomplete, state the limitation in "missing_evidence" and keep the coverage discussion appropriately qualified.
`;

const PROVEN_MODE_OPENING = `
We are submitting this claim along with a comprehensive documentation package to assist in your investigation and evaluation of the reported loss.

The enclosed materials include our findings regarding cause of loss, observed damages, and supporting documentation relevant to scope and repair considerations.

We understand that your standard process may include inspection and further evaluation, and this package is intended to streamline and assist that process from the outset.
`;

const PROCESS_ALIGNMENT = `
This documentation is provided to align with and support your standard investigation process, including inspection, evaluation, and determination. The intent is to present a clear and well-supported understanding of the loss to facilitate an efficient and accurate resolution.
`;

const PROVEN_MODE_CLOSE = `
We respectfully request your review of the enclosed materials and look forward to your determination. Should any additional information be required to assist in your evaluation, please advise and we will promptly provide it.
`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function truncate(text: string, max = 60000): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n\n[TRUNCATED]` : text;
}

function money(value: unknown): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
}

function pick(obj: Record<string, any>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return fallback;
}

function normalizeLower(value: unknown): string {
  return safeString(value).toLowerCase();
}

function normalizeDemandMode(value: unknown): DemandMode {
  return safeString(value).toLowerCase() === "proven" ? "proven" : "standard";
}

const FORBIDDEN_INSURANCE_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\brotted\s+decking\b/gi, "compromised decking"],
  [/\brotten\s+decking\b/gi, "compromised decking"],
  [/\brotted\s+(?:wood|sheathing|substrate)\b/gi, "damaged sheathing"],
  [/\brotten\s+(?:wood|sheathing|substrate)\b/gi, "damaged sheathing"],
  [/\bwood\s+rot\b/gi, "storm-damaged substrate"],
  [/\bdry\s+rot\b/gi, "storm-damaged substrate"],
  [/\bwet\s+rot\b/gi, "storm-damaged substrate"],
  [/\bdecay(?:ed|ing)?\b/gi, "deterioration"],
  [/\brot(?:ted|ting|ten)?\b/gi, "compromised"],
];

function sanitizeForbiddenInsuranceTerms(value: string): string {
  let sanitized = value;
  for (const [pattern, replacement] of FORBIDDEN_INSURANCE_TERM_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function sanitizeDemandPackageObject(demandPackage: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...demandPackage };
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === "string") {
      sanitized[key] = sanitizeForbiddenInsuranceTerms(value);
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === "string" ? sanitizeForbiddenInsuranceTerms(item) : item
      );
    }
  }
  return sanitized;
}

function containsForbiddenInsuranceTerms(text: string): boolean {
  return /\brot(?:ted|ting|ten)?\b|\bdecay(?:ed|ing)?\b/i.test(text);
}

function getBestDocumentText(file: Record<string, any>): string {
  const cleanText = safeString(file.clean_text);
  const extractedText = safeString(file.extracted_text);
  return cleanText.length >= extractedText.length ? cleanText : extractedText;
}

function looksLikeInspectionFile(file: Record<string, any>): boolean {
  const name = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(file.doc_type)} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
  return ["inspection", "photo packet", "damage assessment", "field report", "site report", "scope report", "engineer", "photos", "inspection report"].some((term) => name.includes(term));
}

function looksLikeEstimateFile(file: Record<string, any>): boolean {
  const name = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(file.doc_type)} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
  return ["estimate", "xactimate", "scope", "repair estimate", "rebuild", "loss estimate"].some((term) => name.includes(term));
}

function looksLikeCarrierEstimateFile(file: Record<string, any>): boolean {
  const name = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(file.doc_type)} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
  return [
    "carrier estimate",
    "insurance estimate",
    "adjuster estimate",
    "state farm",
    "allstate",
    "travelers",
    "farmers",
    "liberty mutual",
  ].some((term) => name.includes(term));
}

function looksLikePolicyFile(file: Record<string, any>): boolean {
  const name = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(file.doc_type)} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
  return [
    "policy",
    "declarations",
    "dec page",
    "declaration page",
    "coverage",
    "endorsement",
    "exclusion",
    "policy jacket",
    "hoa policy",
  ].some((term) => name.includes(term));
}

function normalizeStateCode(value: unknown): string {
  const raw = safeString(value).toLowerCase().replace(/\s+/g, "_");
  if (!raw) return "";
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return STATE_NAME_TO_CODE[raw] || "";
}

function extractClaimPolicyNumberCandidates(claim: Record<string, any>): string[] {
  const candidates = [
    safeString(claim.policy_number),
    safeString(claim.policy_no),
    safeString(claim.policyNumber),
  ]
    .map((v) => v.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())
    .filter((v) => v.length >= 6);
  return [...new Set(candidates)];
}

function scorePolicyMatch(args: {
  claim: Record<string, any>;
  policyFiles: Record<string, any>[];
  policyTextFromFiles: string;
}): PolicyMatchResult {
  const claim = args.claim || {};
  const claimCarrier = normalizeLower(
    pick(claim, ["carrier", "carrier_name", "insurance_company"], "")
  );
  const claimStateCode = normalizeStateCode(
    pick(claim, ["state", "state_code", "loss_state", "property_state"], "")
  );
  const claimPolicyCandidates = extractClaimPolicyNumberCandidates(claim);
  const policyFiles = args.policyFiles || [];

  if (!policyFiles.length) {
    return {
      confidence: "none",
      score: 0,
      referenceMode: "general_only",
      matchedFiles: [],
      rationale: ["No policy files selected for this demand package."],
      hasPolicyFiles: false,
      hasCarrierMatch: false,
      hasPolicyNumberMatch: false,
      hasStateMatch: false,
      hasDeclarationsIndicator: false,
      genericFileCount: 0,
    };
  }

  let bestFileScore = 0;
  let hasCarrierMatch = false;
  let hasPolicyNumberMatch = false;
  let hasStateMatch = false;
  let hasDeclarationsIndicator = false;
  let genericFileCount = 0;
  const matchedFiles: string[] = [];
  const rationale: string[] = [];

  for (const file of policyFiles) {
    const fileName = pick(file, ["file_name", "name"], "Unknown file");
    const fileMeta = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(
      file.doc_type
    )} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
    const text = normalizeLower(getBestDocumentText(file));
    const haystack = `${fileMeta} ${text}`;

    let score = 15;
    let fileMatched = false;

    const hasDecl = /declarations?|dec\s*page|declaration\s*page|coverage\s+summary/.test(haystack);
    if (hasDecl) {
      score += 20;
      hasDeclarationsIndicator = true;
      fileMatched = true;
    }

    if (claimCarrier && haystack.includes(claimCarrier)) {
      score += 30;
      hasCarrierMatch = true;
      fileMatched = true;
    }

    if (claimStateCode && new RegExp(`\\b${claimStateCode.toLowerCase()}\\b`).test(haystack)) {
      score += 15;
      hasStateMatch = true;
      fileMatched = true;
    }

    const compactHaystack = haystack.replace(/[^a-z0-9]/g, "");
    const policyNumberMatched = claimPolicyCandidates.some((candidate) =>
      compactHaystack.includes(candidate)
    );
    if (policyNumberMatched) {
      score += 35;
      hasPolicyNumberMatch = true;
      fileMatched = true;
    }

    if (/sample|generic|template|specimen|example/.test(haystack)) {
      score -= 20;
      genericFileCount += 1;
      rationale.push(`${fileName}: appears to be generic/sample policy content.`);
    }

    if (fileMatched) matchedFiles.push(fileName);
    bestFileScore = Math.max(bestFileScore, Math.max(0, Math.min(100, score)));
  }

  const policyTextLength = safeString(args.policyTextFromFiles).length;
  if (policyTextLength < 250) {
    bestFileScore = Math.max(0, bestFileScore - 10);
    rationale.push("Policy text extraction is limited; restrict policy-specific conclusions.");
  }

  if (hasPolicyNumberMatch) {
    rationale.push("Policy number indicators matched selected policy materials.");
  } else {
    rationale.push("No direct policy number match found in selected policy materials.");
  }
  if (hasCarrierMatch) {
    rationale.push("Carrier indicators matched selected policy materials.");
  } else {
    rationale.push("Carrier indicators not clearly matched in selected policy materials.");
  }
  if (hasStateMatch) {
    rationale.push("State indicators matched selected policy materials.");
  } else {
    rationale.push("State indicators not clearly matched in selected policy materials.");
  }

  let confidence: PolicyMatchConfidence = "low";
  if (bestFileScore >= 80 && hasCarrierMatch && hasPolicyNumberMatch) {
    confidence = "high";
  } else if (bestFileScore >= 55 && (hasCarrierMatch || hasPolicyNumberMatch || hasStateMatch)) {
    confidence = "medium";
  }

  if (genericFileCount > 0) {
    if (confidence === "high") confidence = "medium";
    else if (confidence === "medium") confidence = "low";
  }

  const referenceMode: PolicyReferenceMode =
    confidence === "high"
      ? "claim_specific"
      : confidence === "medium"
      ? "qualified_reference"
      : "general_only";

  return {
    confidence,
    score: bestFileScore,
    referenceMode,
    matchedFiles: [...new Set(matchedFiles)],
    rationale,
    hasPolicyFiles: true,
    hasCarrierMatch,
    hasPolicyNumberMatch,
    hasStateMatch,
    hasDeclarationsIndicator,
    genericFileCount,
  };
}

function buildPolicyGateInstructions(
  policyMatch: PolicyMatchResult,
  policyText: string
): string {
  const base = [
    "POLICY MATCH SUMMARY:",
    `- Match confidence: ${policyMatch.confidence}`,
    `- Match score: ${policyMatch.score}/100`,
    `- Reference mode: ${policyMatch.referenceMode}`,
    `- Policy files selected: ${policyMatch.hasPolicyFiles ? "yes" : "no"}`,
    `- Carrier match: ${policyMatch.hasCarrierMatch ? "yes" : "no"}`,
    `- Policy number match: ${policyMatch.hasPolicyNumberMatch ? "yes" : "no"}`,
    `- State match: ${policyMatch.hasStateMatch ? "yes" : "no"}`,
    `- Declarations indicator: ${policyMatch.hasDeclarationsIndicator ? "yes" : "no"}`,
  ];

  if (policyMatch.matchedFiles.length > 0) {
    base.push(`- Matched policy files: ${policyMatch.matchedFiles.join(", ")}`);
  }
  if (policyMatch.rationale.length > 0) {
    base.push("- Match rationale:");
    for (const note of policyMatch.rationale) base.push(`  - ${note}`);
  }

  if (!policyText.trim() || policyMatch.confidence === "none" || policyMatch.referenceMode === "general_only") {
    base.push(
      "",
      "POLICY REFERENCE GATE (ENFORCED):",
      "- Do NOT quote or paraphrase specific policy clauses, section numbers, or endorsement language.",
      "- Do NOT represent any generic/sample/specimen wording as the insured's actual policy terms.",
      "- Keep policy discussion to general claim-handling obligations and qualify all coverage statements.",
      "- Add a missing_evidence entry requesting the certified policy packet (declarations, form editions, endorsements, exclusions, and conditions)."
    );
    return base.join("\n");
  }

  if (policyMatch.referenceMode === "qualified_reference") {
    base.push(
      "",
      "POLICY REFERENCE GATE (ENFORCED):",
      "- You may use policy language only as qualified reference.",
      "- Explicitly label references as 'based on selected policy materials' rather than confirmed claim-specific terms.",
      "- Avoid definitive clause-to-loss conclusions unless directly supported by matching indicators.",
      "- Include a missing_evidence item requesting full certified policy for final confirmation."
    );
    return base.join("\n");
  }

  base.push(
    "",
    "POLICY REFERENCE GATE (ENFORCED):",
    "- You may cite and analyze specific policy language from the selected policy materials.",
    "- Tie each cited policy term to observed facts and claimed scope.",
    "- Do not cite any policy text not present in the selected materials."
  );
  return base.join("\n");
}

function applyPolicyReferenceMode(
  policyText: string,
  policyMatch: PolicyMatchResult
): string {
  const gateBlock = buildPolicyGateInstructions(policyMatch, policyText);
  if (!policyText.trim() || policyMatch.confidence === "none" || policyMatch.referenceMode === "general_only") {
    return [
      gateBlock,
      "",
      "POLICY TEXT PAYLOAD:",
      "Not provided to model as claim-specific policy evidence due to low/none policy match confidence.",
    ].join("\n");
  }

  if (policyMatch.referenceMode === "qualified_reference") {
    return [
      gateBlock,
      "",
      "POLICY TEXT PAYLOAD (QUALIFIED):",
      policyText,
    ].join("\n");
  }

  return [
    gateBlock,
    "",
    "POLICY TEXT PAYLOAD (CLAIM-SPECIFIC):",
    policyText,
  ].join("\n");
}

function summarizeEstimateLines(lines: Record<string, any>[]) {
  const roomTradeTotals = new Map<string, number>();
  const tradeTotals = new Map<string, number>();
  let grandTotal = 0;

  for (const line of lines) {
    const room = pick(line, ["room_name", "room", "area"], "Unassigned Room");
    const trade = pick(line, ["trade", "category"], "General");
    const total = Number(line.total) || Number(line.rcv_total) || (Number(line.quantity) || 0) * (Number(line.unit_price) || 0);
    grandTotal += total;
    const roomTradeKey = `${room}__${trade}`;
    roomTradeTotals.set(roomTradeKey, (roomTradeTotals.get(roomTradeKey) || 0) + total);
    tradeTotals.set(trade, (tradeTotals.get(trade) || 0) + total);
  }

  const tradeSummary = [...tradeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([trade, total]) => `${trade}: ${money(total)}`).join("\n");
  const roomTradeSummary = [...roomTradeTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([key, total]) => {
    const [room, trade] = key.split("__");
    return `${room} | ${trade}: ${money(total)}`;
  }).join("\n");

  return { grandTotal, tradeSummary, roomTradeSummary };
}

function estimateLinesToText(lines: Record<string, any>[]) {
  if (!lines.length) return "";
  const summary = summarizeEstimateLines(lines);
  const detailLines = lines.slice(0, 800).map((line) => {
    const room = pick(line, ["room_name", "room", "area"], "Unassigned Room");
    const trade = pick(line, ["trade", "category"], "General");
    const code = pick(line, ["code", "line_code", "item_code"]);
    const description = pick(line, ["description", "item_description"], "No description");
    const quantity = pick(line, ["quantity", "qty"], "0");
    const unit = pick(line, ["unit", "uom"], "");
    const unitPrice = money(line.unit_price ?? line.price ?? 0);
    const total = money(line.total ?? line.rcv_total ?? (Number(line.quantity ?? line.qty ?? 0) * Number(line.unit_price ?? line.price ?? 0)));
    return [`Room: ${room}`, `Trade: ${trade}`, code ? `Code: ${code}` : null, `Description: ${description}`, `Qty: ${quantity} ${unit}`.trim(), `Unit Price: ${unitPrice}`, `Total: ${total}`].filter(Boolean).join(" | ");
  }).join("\n");

  return [`ESTIMATE GRAND TOTAL: ${money(summary.grandTotal)}`, "", "TRADE SUMMARY:", summary.tradeSummary || "None", "", "ROOM / TRADE SUMMARY:", summary.roomTradeSummary || "None", "", "DETAILED LINE ITEMS:", detailLines].join("\n");
}

function extractAuthoritativeEstimateTotal(args: {
  explicitTotal?: unknown;
  estimateLines: Record<string, any>[];
  estimateFiles?: Record<string, any>[];
}): number {
  // 1. Explicit total passed from client (e.g. selectedEstimate.grandTotal)
  const explicit = Number(args.explicitTotal);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  // 2. Check estimate file-level totals
  for (const file of args.estimateFiles || []) {
    const candidates = [
      Number(file.estimate_total),
      Number(file.grand_total),
      Number(file.total_amount),
      Number(file.rcv_total),
    ].filter((n) => Number.isFinite(n) && n > 0);
    if (candidates.length) return candidates[0];
  }

  // 3. Sum from line items, filtering out void/deleted/summary rows
  const currentLines = (args.estimateLines || []).filter((line) => {
    if (line.is_void === true) return false;
    if (line.is_deleted === true) return false;
    if (line.include_in_total === false) return false;
    if (String(line.line_type || "").toLowerCase() === "summary") return false;
    if (String(line.line_type || "").toLowerCase() === "subtotal") return false;
    if (String(line.line_type || "").toLowerCase() === "tax") return false;
    return true;
  });

  // Group by version and pick the most recent version with a positive total
  const versionGroups = new Map<string, Record<string, any>[]>();
  for (const line of currentLines) {
    const versionKey = String(
      line.estimate_version_id ?? line.version_id ?? line.estimate_id ?? "default"
    );
    versionGroups.set(versionKey, [...(versionGroups.get(versionKey) || []), line]);
  }

  const versionTotals = [...versionGroups.entries()].map(([versionKey, lines]) => {
    const total = lines.reduce((sum, line) => {
      const qty = Number(line.quantity ?? line.qty ?? 0);
      const unitPrice = Number(line.unit_price ?? line.price ?? 0);
      const lineTotal =
        Number(line.total) ||
        Number(line.rcv_total) ||
        (Number.isFinite(qty) && Number.isFinite(unitPrice) ? qty * unitPrice : 0);
      return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
    }, 0);
    const latestTs = Math.max(
      ...lines.map((l) => new Date(l.updated_at || l.created_at || 0).getTime())
    );
    return { versionKey, total, latestTs, count: lines.length };
  });

  versionTotals.sort((a, b) => b.latestTs - a.latestTs);
  const best = versionTotals.find((v) => v.total > 0);
  return best ? best.total : 0;
}

function getToneInstructions(tone: string): string {
  switch (tone) {
    case "aggressive":
      return `
TONE OVERRIDE — AGGRESSIVE:
- Increase assertiveness in every section.
- Emphasize carrier failures, under-scoping, and inadequate investigation more forcefully.
- Frame every disputed item as an obligation the carrier has failed to meet.
- Use stronger causation language and leave no room for partial payment justification.`;
    case "litigation":
      return `
TONE OVERRIDE — LITIGATION READY:
- Write as if this demand is the final step before formal dispute resolution or litigation.
- Increase firmness dramatically. Reduce flexibility. Emphasize carrier exposure.
- Frame every unresolved item as potential bad faith conduct.
- Reference the carrier's duty of good faith and fair dealing prominently.
- Make clear that failure to respond adequately will result in escalation.
- Every section should read as if it will be exhibit-ready in a proceeding.`;
    default:
      return "";
  }
}

function buildDemandPrompt(args: {
  claim: Record<string, any> | null;
  masterState: Record<string, any> | null;
  intelligence: Record<string, any> | null;
  inspectionText: string;
  estimateText: string;
  policyText: string;
  policyMatch: PolicyMatchResult;
  timelineText: string;
  priorPaymentsText: string;
  userNotes: string;
  carrierPositionText: string;
  declaredPositionText: string;
  tone: string;
  carrierEstimateText: string;
  mode: DemandMode;
}) {
  const claim = args.claim || {};
  const insuredName = pick(claim, ["insured_name", "insured", "policyholder_name"], "Insured");
  const propertyAddress = pick(claim, ["property_address", "loss_address", "address", "propertyLocation"], "");
  const dateOfLoss = pick(claim, ["date_of_loss", "loss_date", "dol"], "");
  const claimNumber = pick(claim, ["claim_number", "claim_no", "number"], "");
  const carrier = pick(claim, ["carrier", "carrier_name", "insurance_company"], "");
  const policyNumber = pick(claim, ["policy_number", "policy_no"], "");

  const masterStateText = args.masterState ? JSON.stringify(args.masterState, null, 2) : "No master state available.";
  const intelligenceText = args.intelligence ? JSON.stringify(args.intelligence, null, 2) : "No intelligence summary available.";
  const isProven = args.mode === "proven";
  const toneBlock = isProven ? "" : getToneInstructions(args.tone);
  const policyConstraintBlock = isProven
    ? args.policyMatch.referenceMode === "claim_specific"
      ? `POLICY REFERENCE MODE: claim_specific (high-confidence policy match).\nYou may use direct policy-language analysis from selected materials, with precise section labels where available.`
      : args.policyMatch.referenceMode === "qualified_reference"
      ? `POLICY REFERENCE MODE: qualified_reference (medium-confidence policy match).\nUse cautious, qualified policy references. Do not present policy language as definitively claim-specific unless clearly labeled in selected documents.`
      : `POLICY REFERENCE MODE: general_only (low/no policy match confidence).\nDo NOT use specific policy provisions as controlling. Use general policy principles only and explicitly note missing/inconclusive policy proof in "missing_evidence".`
    : "";

  return `
You are Darwin, a professional property restoration report writer for public adjusters.

Your task is to analyze:
1. A third-party inspection report / damage assessment
2. A repair estimate
3. Claim timeline context
4. Claim intelligence context

Then generate a FACTUAL, TECHNICALLY SOUND RESTORATION REPORT that documents observed damage, assessment methodology, and repair scope.

${isProven ? PROVEN_MODE_RULES : ""}
${policyConstraintBlock}

REPORT WRITING RULES:
- Write as a professional property restoration assessment report — NOT a persuasive demand letter.
- Remove all generic carrier-pressure statements, broad legal commentary, and over-explanations of obvious damage.
- Keep only technical facts, observed conditions, and repair justifications.
- Do not mention AI.
- Do not say "based on the prompt" or "based on the documents provided."
- Do not editorialize or insert persuasive narrative. State facts and let them speak.
- Every damage observation should link directly to a specific repair scope item.
- Use short professional headings. No multi-paragraph blocks unless essential for repair rationale.
- Add explanation ONLY for: repair scope justification, code requirements, manufacturer specs, system interdependency.
- Use counterfactual causation logic only where directly relevant:
  "If not for the reported loss event, the observed condition would not be present."
- ${isProven
    ? "Address incomplete or partial repairs using documentation-backed reasoning where facts support full repair/replacement."
    : "State why partial or cosmetic repairs are inadequate where the facts support full repair/replacement."}
- Emphasize repairability limits, interdependency, access requirements, code triggers, and manufacturer specs where supported. NEVER use the word "matching" — PA and NJ are NOT matching states.
- ${isProven ? "Keep it professional, neutral, and evidence-driven." : "Keep it factual, evidence-driven, and direct."}
- Only analyze the selected insured-side documents provided.
- Do not reference carrier estimates unless explicitly provided.
- Do not invent code citations or policy language.
- You MUST use the authoritative estimate total if one is provided.
- NEVER use "rot", "rotted", "rotting", "rotten", "decay", "decayed", or "decaying". Use "compromised decking", "damaged sheathing", or "storm-damaged substrate" instead.
- Use the estimate total as the demand amount unless the materials support another specific figure.
- If there are weak points or missing proof, identify them in the "strategic_notes" field only, not in the report body.
${isProven ? PROVEN_MODE_POLICY_RULES : ""}

REPORT FORMAT RULES (CRITICAL):
- Summary of Findings MUST be bullet points ONLY — no paragraph text. Each bullet: one fact, factual/specific, tied to observed damage.
- Include exclusion bullets (e.g., "No hail damage observed") in Summary of Findings.
- End Summary of Findings with the total estimate amount if available.
- Use subheadings within damage assessment sections for scannability.
- Break technical details into scannable chunks. Avoid dense paragraphs.
- Remove redundant conclusions across sections — state a finding once.

CONCISION RULES (CRITICAL — ENFORCE STRICTLY):
- Prefer bullet points over paragraphs in EVERY section. Use paragraphs only when explaining repair rationale, code requirements, or manufacturer specs.
- Do NOT repeat the same fact in multiple sections. If a damage observation appears in Summary of Findings, do NOT restate it in the damage assessment section — instead, expand on it with new detail (location specifics, measurements, repair implications).
- Each section must introduce NEW VALUE. If a section would only restate content from a prior section, shorten it to a single bullet or omit the redundant content entirely.
- The entire document must be scannable — an adjuster should understand the full claim position in under 60 seconds of reading.
- Eliminate filler phrases: "It should be noted that", "It is important to understand", "As previously mentioned", "Upon review of the documentation".
- Maximum 3 sentences per paragraph. If a paragraph exceeds 3 sentences, convert to bullet points.

DAMAGE CHARACTERIZATION RULES (CRITICAL):
- Do NOT simply state "distinct, demonstrable, detrimental, direct" as a list or checklist. These words alone are meaningless without evidence.
- Each damage element must be supported by specific observations from the inspection, photos, or documentation:
  - DISTINCT: Identify the specific component and location (e.g., "3-tab shingle creasing on the south-facing slope at ridge line").
  - DEMONSTRABLE: Cite the observable evidence (e.g., "visible granule displacement measuring approximately 2 inches in diameter").
  - DETRIMENTAL: Explain the functional impairment (e.g., "exposed fiberglass mat compromises waterproofing integrity of the shingle").
  - DIRECT: Link to the specific loss event (e.g., "consistent with wind-driven debris impact from the 09/15/2024 storm event").
- Tie each characterization element to actual damaged components identified in the inspection (roof, siding, gutters, windows, etc.).
- Do NOT introduce damage categories that are not supported by the provided inspection reports, photos, or estimate scope.
- Do NOT use generic or boilerplate damage characterization language. Every statement must reference a specific observation.

${toneBlock}

DECLARED POSITION ALIGNMENT:
${args.declaredPositionText || "No declared position provided."}
- If a declared position is provided, align the report with it and do not deviate.

RETURN STRICT JSON with this exact shape:
{
  "title": "string",
  "subject_line": "string",
  "demand_amount": "string",
  "summary_of_findings": "string",
  "narrative_framing": "string",
  "roof_damage_assessment": "string",
  "exterior_siding_assessment": "string",
  "gutter_downspout_assessment": "string",
  "damage_characterization_analysis": "string",
  "scope_of_repair_justification": "string",
  "formal_demand": "string",
  "full_demand_package": "string",
  "strategic_notes": "string",
  "missing_evidence": ["string"],
  "confidence_score": 0
}

NARRATIVE FRAMING & PREEMPTIVE CLARIFICATION RULES:
- The "narrative_framing" field contains 3–6 bullet points positioned AFTER Summary of Findings and BEFORE Assessment Process.
- Each bullet must be concise (1–2 lines), factual, and technical. No emotional tone, no accusations, no bad faith references, no delay references unless directly supported by documentation.
- Required bullet topics (include only those relevant to the claim):
  1. Clear definition of the cause of loss (e.g., "Wind event on 09/15/2024 producing sustained winds of 60+ mph").
  2. Preemptive distinction between storm damage and wear/tear/maintenance (e.g., "Observed damage is mechanically distinct from gradual deterioration").
  3. Repair vs. replacement rationale (e.g., "Partial repair is not feasible due to system interdependency and manufacturer discontinuation").
  4. Scope boundaries — what IS and IS NOT being claimed (e.g., "This report does not include interior contents or landscaping").
  5. Code or manufacturer requirements that may expand scope.
  6. Any other factual clarification that preempts common carrier objections for this loss type.
- Do NOT include bullets that are generic boilerplate. Every bullet must reference specific claim facts.

CLAIM FACTS:
Insured Name: ${insuredName}
Property Address: ${propertyAddress}
Date of Loss: ${dateOfLoss}
Claim Number: ${claimNumber}
Carrier: ${carrier}
Policy Number: ${policyNumber}

CLAIM MASTER STATE:
${masterStateText}

CLAIM INTELLIGENCE:
${intelligenceText}

CLAIM TIMELINE:
${args.timelineText || "No timeline context available."}

PRIOR PAYMENTS / CHECKS:
${args.priorPaymentsText || "No prior payment context available."}

KNOWN CARRIER POSITION / DISPUTE:
${args.carrierPositionText || "No specific carrier position provided."}

USER NOTES / STRATEGY:
${args.userNotes || "No additional notes provided."}

THIRD-PARTY INSPECTION REPORT / DAMAGE ASSESSMENT:
${args.inspectionText || "No inspection report text available."}

REPAIR ESTIMATE:
${args.estimateText || "No estimate text available."}

CARRIER ESTIMATE:
${args.carrierEstimateText || "None provided."}

POLICY DOCUMENTS (SELECTED):
${args.policyText || "No policy text was identified in the selected materials."}

POLICY MATCH SUMMARY:
- Confidence: ${args.policyMatch.confidence}
- Score: ${args.policyMatch.score}
- Reference Mode: ${args.policyMatch.referenceMode}
- Matched Files: ${args.policyMatch.matchedFiles.length ? args.policyMatch.matchedFiles.join(", ") : "None"}
- Rationale: ${args.policyMatch.rationale.length ? args.policyMatch.rationale.join(" | ") : "No policy-match rationale available."}

FINAL REQUIREMENT:
The "full_demand_package" field must be a polished, carrier-ready restoration report with these exact 8 section headings IN THIS ORDER:
1. Summary of Findings
2. Narrative Framing & Preemptive Clarification
3. Roof Damage Assessment
4. Exterior / Siding Damage Assessment
5. Gutter / Downspout Assessment
6. Damage Characterization Analysis
7. Scope of Repair / Justification
8. Demand

COMPLETION GATE (MANDATORY):
- The demand package is INVALID if missing ANY of the 8 sections above.
- Every section heading must appear as a subheading in the "full_demand_package" field.
- Do NOT output placeholder text like "[Section Coming]" or "TBD" in any section.

ANTI-GENERIC CONTENT RULE (MANDATORY):
- Remove or rewrite any sentence that could apply to multiple claims (e.g., "We are submitting this claim...", "This package assists...", "The enclosed materials include...").
- Every statement in the report must cite specific claim data: inspection findings, estimate line items, measurements, dates, policyholder details, or property characteristics.
- If a sentence contains no claim-specific fact, do NOT include it.

OUTPUT QUALITY REQUIREMENTS:
- Each section must contain at minimum 2–3 claim-specific paragraphs or bullet groups with actual data from the provided materials.
- No filler sentences. Every sentence must add factual value.
- If insufficient inspection data is available for a section, generate the most complete version possible using ALL provided materials and note limitations in "missing_evidence".

SECTION RULES:
- "Summary of Findings" = bullet points ONLY. Each bullet is one factual observation. Include negative findings. End with estimate total.
- "Narrative Framing & Preemptive Clarification" = 3–6 bullet points defining cause of loss, preempting carrier counter-arguments, and clarifying scope boundaries. Factual and technical only.
- Damage assessment sections = Use subheadings (e.g., "Front Slope", "East Elevation"). Short factual descriptions per component.
- "Damage Characterization Analysis" = Evidence-based characterization of each damage element tied to specific components and the loss event. No boilerplate.
- "Scope of Repair / Justification" = Summarize the estimate scope by trade/component. Reference code triggers, manufacturer requirements, and system interdependency. Explain why full repair/replacement is warranted.
- "Demand" = State the amount. One paragraph maximum.

${isProven
    ? `Use this opening in substance for the report introduction:
${PROVEN_MODE_OPENING}

Use this conclusion language in substance:
${PROVEN_MODE_CLOSE}

The document should read like a technical restoration assessment report.`
    : "The document should read like a professional property damage restoration report that makes the repair scope self-evident."}
`.trim();
}

function buildDocxHtml(demandPackage: Record<string, any>): string {
  const escHtml = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fullText = String(demandPackage.full_demand_package || "");
  const bodyHtml = fullText
    .split("\n")
    .map((line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return "<br/>";
      return `<p>${escHtml(trimmed)}</p>`;
    })
    .join("\n");

  return `<h1>${escHtml(String(demandPackage.title || "Demand Package"))}</h1>
<p><strong>Subject:</strong> ${escHtml(String(demandPackage.subject_line || ""))}</p>
<p><strong>Demand Amount:</strong> ${escHtml(String(demandPackage.demand_amount || ""))}</p>
<br/>
${bodyHtml}`;
}

function buildClaimContextFallback(args: {
  claim: Record<string, any> | null;
  masterState: Record<string, any> | null;
  intelligence: Record<string, any> | null;
  timelineText: string;
  priorPaymentsText: string;
  userNotes: string;
  carrierPositionText: string;
  declaredPositionText: string;
}) {
  const claim = args.claim || {};

  const claimFacts = [
    pick(claim, ["insured_name", "insured", "policyholder_name"]) && `Insured: ${pick(claim, ["insured_name", "insured", "policyholder_name"])}`,
    pick(claim, ["property_address", "loss_address", "address", "propertyLocation"]) && `Property: ${pick(claim, ["property_address", "loss_address", "address", "propertyLocation"])}`,
    pick(claim, ["date_of_loss", "loss_date", "dol"]) && `Date of Loss: ${pick(claim, ["date_of_loss", "loss_date", "dol"])}`,
    pick(claim, ["claim_number", "claim_no", "number"]) && `Claim Number: ${pick(claim, ["claim_number", "claim_no", "number"])}`,
    pick(claim, ["carrier", "carrier_name", "insurance_company"]) && `Carrier: ${pick(claim, ["carrier", "carrier_name", "insurance_company"])}`,
    pick(claim, ["policy_number", "policy_no"]) && `Policy Number: ${pick(claim, ["policy_number", "policy_no"])}`,
  ].filter(Boolean).join("\n");

  return truncate([
    claimFacts ? `CLAIM FACTS\n${claimFacts}` : "",
    args.declaredPositionText ? `DECLARED POSITION\n${args.declaredPositionText}` : "",
    args.carrierPositionText ? `KNOWN CARRIER POSITION\n${args.carrierPositionText}` : "",
    args.timelineText ? `CLAIM TIMELINE\n${args.timelineText}` : "",
    args.priorPaymentsText ? `PRIOR PAYMENTS\n${args.priorPaymentsText}` : "",
    args.userNotes ? `USER NOTES\n${args.userNotes}` : "",
    args.intelligence ? `CLAIM INTELLIGENCE\n${JSON.stringify(args.intelligence, null, 2)}` : "",
    args.masterState ? `CLAIM MASTER STATE\n${JSON.stringify(args.masterState, null, 2)}` : "",
  ].filter(Boolean).join("\n\n"), 30000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase environment variables");
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = (await req.json()) as Json;

    const claimId = safeString(body.claimId);
    const inspectionReportTextOverride = safeString(body.inspectionReportText);
    const estimateTextOverride = safeString(body.estimateText);
    const carrierPositionText = safeString(body.carrierPositionText);
    const declaredPositionText = safeString(body.declaredPositionText);
    const userNotes = safeString(body.userNotes);
    const tone = safeString(body.tone) || "standard"; // "standard" | "aggressive" | "litigation"
    const mode = normalizeDemandMode(body.mode); // "standard" | "proven"
    const saveToMasterState = Boolean(body.saveToMasterState ?? true);

    if (!claimId) {
      return json({ error: "claimId is required" }, 400);
    }

    const selectedFileIds = Array.isArray(body.selectedFileIds)
      ? body.selectedFileIds.map((x) => String(x))
      : [];

    let filesQuery = supabase.from("claim_files").select("*").eq("claim_id", claimId);
    if (selectedFileIds.length > 0) {
      filesQuery = filesQuery.in("id", selectedFileIds);
    }

    const [claimRes, filesRes, estimateLinesRes, masterStateRes, intelligenceRes, eventsRes, paymentsRes] = await Promise.all([
      supabase.from("claims").select("*").eq("id", claimId).maybeSingle(),
      filesQuery,
      supabase.from("darwin_estimate_lines").select("*").eq("claim_id", claimId).order("created_at", { ascending: true }),
      supabase.from("claim_master_state").select("*").eq("claim_id", claimId).maybeSingle(),
      supabase.from("claim_intelligence_summary").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("claim_events").select("*").eq("claim_id", claimId).order("occurred_at", { ascending: true }).limit(200),
      supabase.from("claim_payments").select("*").eq("claim_id", claimId).order("created_at", { ascending: true }).limit(50),
    ]);

    const claim = claimRes.data || null;
    const files = filesRes.data || [];
    const estimateLines = estimateLinesRes.data || [];
    const masterState = masterStateRes.data || null;
    const intelligence = intelligenceRes.data || null;
    const events = eventsRes.data || [];
    const payments = paymentsRes.data || [];

    if (!claim) {
      return json({ error: "Claim not found" }, 404);
    }

    if (filesRes.error) {
      console.error("Failed loading claim files for demand package", {
        claimId,
        selectedFileIds,
        error: filesRes.error,
      });
      return json({ error: "Failed to load selected documents for the demand package." }, 500);
    }

    // Also pull declared position from master state if not explicitly provided
    let resolvedDeclaredPosition = declaredPositionText;
    if (!resolvedDeclaredPosition && masterState?.state_json) {
      const stateJson = masterState.state_json as Record<string, any>;
      const dp = stateJson?.declared_position;
      if (dp) {
        resolvedDeclaredPosition = [
          dp.observed_damage_condition ? `Observed Damage: ${dp.observed_damage_condition}` : "",
          dp.primary_loss_mechanism ? `Loss Mechanism: ${dp.primary_loss_mechanism}` : "",
          dp.coverage_trigger_theory ? `Coverage Trigger: ${dp.coverage_trigger_theory}` : "",
          dp.specific_carrier_failure ? `Carrier Failure: ${dp.specific_carrier_failure}` : "",
          dp.decisive_contradiction ? `Decisive Contradiction: ${dp.decisive_contradiction}` : "",
          dp.requested_remedy ? `Requested Remedy: ${dp.requested_remedy}` : "",
          dp.master_position_statement ? `Position Statement: ${dp.master_position_statement}` : "",
        ].filter(Boolean).join("\n");
      }
    }

    // Filter files to user-selected files if provided
    const effectiveFiles =
      selectedFileIds.length > 0
        ? files.filter((f: Record<string, any>) => selectedFileIds.includes(String(f.id)))
        : [];

    console.log("Demand package file filtering", {
      claimId,
      selectedFileIds,
      totalClaimFiles: files.length,
      matchedEffectiveFiles: effectiveFiles.map((f: Record<string, any>) => ({
        id: f.id,
        file_name: f.file_name,
        name: f.name,
      })),
    });

    if (!effectiveFiles.length) {
      return json({ error: "No selected documents were provided for the demand package." }, 400);
    }

    const inspectionFiles = effectiveFiles.filter((f: Record<string, any>) => looksLikeInspectionFile(f));
    const estimateFiles = effectiveFiles.filter((f: Record<string, any>) => looksLikeEstimateFile(f));
    const policyFiles = effectiveFiles.filter((f: Record<string, any>) => looksLikePolicyFile(f));
    const carrierEstimateFiles: Record<string, any>[] = [];

    // Gather extracted text from matched files
    const inspectionTextFromFiles = inspectionFiles.map((f: Record<string, any>) =>
      [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, getBestDocumentText(f)].filter(Boolean).join("\n")
    ).filter((t: string) => t.length > 20).join("\n\n");

    const estimateTextFromFiles = estimateFiles.map((f: Record<string, any>) =>
      [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, getBestDocumentText(f)].filter(Boolean).join("\n")
    ).filter((t: string) => t.length > 20).join("\n\n");

    const policyTextFromFiles = policyFiles.map((f: Record<string, any>) =>
      [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, getBestDocumentText(f)].filter(Boolean).join("\n")
    ).filter((t: string) => t.length > 20).join("\n\n");

    // Fallback: if no inspection/estimate-specific files matched, use ALL files with extracted_text
    const allFileText = files
      .filter((f: Record<string, any>) => getBestDocumentText(f).length > 20)
      .map((f: Record<string, any>) =>
        [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, getBestDocumentText(f)].filter(Boolean).join("\n")
      ).join("\n\n");

    // Filter estimate lines to selected estimate if provided
    const selectedEstimateId = safeString(body.selectedEstimateId);
    const filteredEstimateLines = selectedEstimateId
      ? estimateLines.filter((line) =>
          String(line.estimate_version_id ?? line.version_id ?? line.estimate_id) === selectedEstimateId
        )
      : estimateLines;

    const estimateLinesText = estimateLinesToText(filteredEstimateLines);
    const explicitEstimateTotal = extractAuthoritativeEstimateTotal({
      explicitTotal: body.estimateTotal,
      estimateLines: filteredEstimateLines,
      estimateFiles: estimateFiles,
    });

    // Sanity check: reject wildly inflated totals
    if (explicitEstimateTotal > 0) {
      const largestSingleLine = Math.max(
        0,
        ...filteredEstimateLines.map((line) =>
          Number(line.total) ||
          Number(line.rcv_total) ||
          (Number(line.quantity ?? 0) * Number(line.unit_price ?? 0))
        )
      );
      if (largestSingleLine > 0 && explicitEstimateTotal > largestSingleLine * 200) {
        console.error(`Estimate total sanity check failed: ${money(explicitEstimateTotal)} vs largest line ${money(largestSingleLine)}`);
        return json({ error: `Estimate total sanity check failed. Computed total ${money(explicitEstimateTotal)} looks inflated.` }, 400);
      }
    }

    const estimateAuthorityBlock = explicitEstimateTotal > 0
      ? `AUTHORITATIVE ESTIMATE TOTAL: ${money(explicitEstimateTotal)}`
      : "AUTHORITATIVE ESTIMATE TOTAL: Not available from structured estimate lines.";

    const timelineText = truncate(
      events.map((e: Record<string, any>) => {
        const occurredAt = pick(e, ["occurred_at", "created_at"], "");
        const type = pick(e, ["event_type", "type"], "event");
        const summary = pick(e, ["summary", "description", "title"], "");
        return `${occurredAt} | ${type} | ${summary}`;
      }).join("\n"),
      15000
    );

    const priorPaymentsText = truncate(
      payments.map((p: Record<string, any>) => {
        const createdAt = pick(p, ["created_at", "paid_at", "issued_at"], "");
        const amount = money(p.amount ?? p.payment_amount ?? 0);
        const type = pick(p, ["payment_type", "type"], "payment");
        const note = pick(p, ["note", "memo", "summary"], "");
        return `${createdAt} | ${type} | ${amount} | ${note}`;
      }).join("\n"),
      8000
    );

    const claimContextFallback = buildClaimContextFallback({
      claim,
      masterState,
      intelligence,
      timelineText,
      priorPaymentsText,
      userNotes,
      carrierPositionText,
      declaredPositionText: resolvedDeclaredPosition,
    });

    const inspectionText = truncate(
      inspectionReportTextOverride || inspectionTextFromFiles || allFileText || claimContextFallback,
      30000
    );
    const estimateText = truncate(
      [
        estimateAuthorityBlock,
        estimateTextOverride || "",
        estimateLinesText,
        estimateTextFromFiles,
      ].filter(Boolean).join("\n\n") || allFileText || claimContextFallback,
      70000
    );
    const policyText = truncate(
      policyTextFromFiles,
      30000
    );
    const policyMatch = scorePolicyMatch({
      claim,
      policyFiles,
      policyTextFromFiles,
    });
    const policyTextForPrompt = applyPolicyReferenceMode(policyText, policyMatch);

    if (!inspectionText && !estimateText && !claimContextFallback) {
      return json({ error: "Not enough claim context was found to build a demand package yet. Add claim facts, document text, or estimate lines and try again." }, 400);
    }

    // Build carrier estimate context
    const carrierEstimateTextFromFiles = carrierEstimateFiles
      .map((f: Record<string, any>) =>
        [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, safeString(f.extracted_text)]
          .filter(Boolean)
          .join("\n")
      )
      .filter(Boolean)
      .join("\n\n");

    const carrierEstimateBlock = carrierEstimateTextFromFiles
      ? `CARRIER ESTIMATE:\n${carrierEstimateTextFromFiles}`
      : "CARRIER ESTIMATE:\nNone provided.";

    console.log(`Demand package context: inspection=${inspectionText.length} chars, estimate=${estimateText.length} chars, policy=${policyTextForPrompt.length} chars, policyMatch=${policyMatch.confidence}/${policyMatch.score}/${policyMatch.referenceMode}, timeline=${timelineText.length} chars, files=${files.length}, carrierEstimateFiles=${carrierEstimateFiles.length}, fallback=${claimContextFallback.length}`);


    const prompt = buildDemandPrompt({
      claim,
      masterState,
      intelligence,
      inspectionText,
      estimateText,
      timelineText,
      priorPaymentsText,
      userNotes,
      carrierPositionText,
      declaredPositionText: resolvedDeclaredPosition,
      tone,
      carrierEstimateText: carrierEstimateBlock,
      mode,
      policyText: policyTextForPrompt,
      policyMatch,
    });

    const aiResult = await generate({
      task: 'copilot_reasoning',
      system: mode === "proven"
        ? "You generate carrier-ready property restoration assessment reports. Return ONLY valid JSON — no markdown, no code fences, no commentary. Use factual, technical language. Summary of Findings must be bullet points only."
        : "You generate carrier-ready property restoration reports with demand sections. Return ONLY valid JSON — no markdown, no code fences, no commentary. Use factual, technical language. Summary of Findings must be bullet points only.",
      user: prompt,
      claimId,
      forceStrong: true,
      searchMode: 'off',
      jsonMode: true,
    });

    console.log(`[generate-demand-package] model=${aiResult.model}, cached=${aiResult.cached}`);

    const rawContent = aiResult.text;
    console.log("AI response length:", rawContent.length, "chars");

    // Robust JSON extraction: try direct parse first, then regex fallback
    let demandPackage: Record<string, unknown>;
    try {
      demandPackage = JSON.parse(rawContent);
    } catch {
      // Strip markdown code fences if present
      const cleaned = rawContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON found in AI response");
      try {
        demandPackage = JSON.parse(match[0]);
      } catch {
        throw new Error("Model returned invalid JSON");
      }
    }

    demandPackage = sanitizeDemandPackageObject(demandPackage);

    // Enforce authoritative estimate total over any AI-hallucinated amount
    if (explicitEstimateTotal > 0) {
      demandPackage.demand_amount = money(explicitEstimateTotal);
      if (typeof demandPackage.full_demand_package === "string") {
        demandPackage.full_demand_package =
          `Demand Amount: ${money(explicitEstimateTotal)}\n\n` +
          (demandPackage.full_demand_package as string).replace(
            /Demand Amount:\s*\$[\d,]+\.\d{2}/i,
            `Demand Amount: ${money(explicitEstimateTotal)}`
          );
      }
    }

    demandPackage = sanitizeDemandPackageObject(demandPackage);
    const serializedDemandPackage = JSON.stringify(demandPackage);
    if (containsForbiddenInsuranceTerms(serializedDemandPackage)) {
      throw new Error("Demand package blocked: forbidden non-covered terminology detected (rot/decay).");
    }

    // Generate DOCX-ready HTML for export
    const docxHtml = buildDocxHtml(demandPackage);

    const responsePayload = {
      success: true,
      claimId,
      mode,
      tone,
      generatedAt: new Date().toISOString(),
      policyMatch: {
        confidence: policyMatch.confidence,
        score: policyMatch.score,
        referenceMode: policyMatch.referenceMode,
        matchedFiles: policyMatch.matchedFiles,
        rationale: policyMatch.rationale,
      },
      inputSummary: {
        inspectionChars: inspectionText.length,
        estimateChars: estimateText.length,
        estimateLineCount: estimateLines.length,
        inspectionFileCount: inspectionFiles.length,
        estimateFileCount: estimateFiles.length,
        policyFileCount: policyFiles.length,
        policyMatchScore: policyMatch.score,
        policyMatchConfidence: policyMatch.confidence,
        policyReferenceMode: policyMatch.referenceMode,
        hasDeclaredPosition: !!resolvedDeclaredPosition,
        usedContextFallback: !inspectionReportTextOverride && !inspectionTextFromFiles && !allFileText,
      },
      demandPackage,
      docxHtml,
    };

    if (saveToMasterState && masterState?.id) {
      try {
        const currentState = (masterState.state_json as Record<string, any> | null) || {};
        const nextState = {
          ...currentState,
          demand_package: {
            generated_at: new Date().toISOString(),
            mode,
            tone,
            policy_match: {
              confidence: policyMatch.confidence,
              score: policyMatch.score,
              reference_mode: policyMatch.referenceMode,
              matched_files: policyMatch.matchedFiles,
              rationale: policyMatch.rationale,
            },
            title: demandPackage?.title || "",
            subject_line: demandPackage?.subject_line || "",
            demand_amount: demandPackage?.demand_amount || "",
            executive_summary: demandPackage?.executive_summary || "",
            full_demand_package: demandPackage?.full_demand_package || "",
            strategic_notes: demandPackage?.strategic_notes || "",
            missing_evidence: demandPackage?.missing_evidence || [],
            confidence_score: demandPackage?.confidence_score || 0,
          },
        };
        await supabase.from("claim_master_state").update({ state_json: nextState, updated_at: new Date().toISOString() }).eq("id", masterState.id);
      } catch (saveError) {
        console.error("Failed saving demand package to master state", saveError);
      }
    }

    return json(responsePayload);
  } catch (error) {
    console.error("generate-demand-package error", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
