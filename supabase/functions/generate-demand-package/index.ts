import { createClient } from "npm:@supabase/supabase-js@2.39.3";
// Using Lovable AI gateway instead of OpenAI Responses API for reliability

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Json = Record<string, unknown>;
type DemandMode = "standard" | "proven";

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

  return `
You are Darwin, an elite public adjuster demand-package engine.

Your task is to analyze:
1. A third-party inspection report / damage assessment
2. A repair estimate
3. Claim timeline context
4. Claim intelligence context

Then generate a ${isProven ? "TECHNICALLY SOUND, DOCUMENTATION-DRIVEN CLAIM PACKAGE" : "HIGH-PRESSURE, TECHNICALLY SOUND, COVERAGE-FOCUSED DEMAND PACKAGE"} that expands on the documents and presents the claim in a way that makes ${isProven ? "an efficient and accurate carrier determination" : "payment the reasonable next step for the carrier"}.

${isProven ? PROVEN_MODE_RULES : ""}

IMPORTANT WRITING RULES:
- Write as a professional public adjuster claim demand.
- No markdown bullets in the final body unless needed for a sectioned schedule.
- Do not mention AI.
- Do not say "based on the prompt" or "based on the documents provided."
- Do not merely summarize. Expand, connect, and persuade.
- Every major damage observation should connect to scope and payment necessity.
- Use counterfactual causation logic where helpful:
  "If not for the reported loss event, the observed condition would not be present."
- ${isProven
    ? "Address incomplete, piecemeal, cosmetic, or partial repairs using documentation-backed reasoning where the facts support full repair/replacement."
    : "Argue against incomplete, piecemeal, cosmetic, or partial repairs where the facts support full repair/replacement."}
- Emphasize repairability limits, interdependency, uniform appearance, access, disturbance, code, manufacturer requirements, and restoration sequencing where supported. NEVER use the word "matching" — PA and NJ are NOT matching states.
- If timeline facts support it, highlight claim-handling delay, inadequate investigation, under-scoping, or incomplete accounting of the full loss.
- ${isProven ? "Keep it professional, neutral-but-confident, and evidence-driven." : "Keep it assertive, evidence-driven, and carrier-facing."}
- Only analyze the selected insured-side documents provided for this demand package.
- Do not reference carrier estimates, carrier reports, or competing scopes unless they were explicitly provided.
- If no carrier estimate is provided, do not mention one.
- Do not invent code citations or policy language. If not provided, refer generally to applicable policy obligations and standards of good-faith claim handling.
- You MUST use the authoritative estimate total if one is provided.
- NEVER use "rot", "rotted", "rotting", "rotten", "decay", "decayed", or "decaying". These terms are not acceptable in demand packages. Use "compromised decking", "damaged sheathing", or "storm-damaged substrate" instead.
- Do not infer the demand amount from stray dollar values inside narrative text when an authoritative estimate total is present.
- If multiple dollar values appear in the estimate materials, treat the authoritative estimate total as controlling.
- Use the estimate total as the demand amount unless the materials support another specific figure.
- If the inspection report identifies room/component-specific damage, fold that into the narrative so the estimate reads inevitable and justified.
- If there are weak points or missing proof, identify them in the "strategic_notes" field only, not in the demand body.
${isProven ? PROVEN_MODE_POLICY_RULES : ""}

${isProven ? "DOCUMENTATION EXPANSION RULES (CRITICAL):" : "FORCE EXPANSION RULES (CRITICAL):"}
- You MUST expand every section beyond what is explicitly stated in the documents by applying professional construction, insurance, and claim-handling knowledge.
- If the estimate includes a scope item, you must explain WHY it is required, not just restate it.
- If the inspection identifies damage, you must connect it to:
  (a) repair necessity
  (b) replacement implications
  (c) system disturbance and access requirements
- ${isProven
    ? "Present each supported line item as technically justified and relevant to claim evaluation."
    : "Assume the carrier is looking for reasons to underpay — your job is to remove that ability."}
- Every line item in the estimate should feel inevitable and technically justified when read in context of the demand.

REGULATORY PRESSURE RULES:
- Where applicable, identify claim handling concerns such as:
  - delay in investigation
  - incomplete scope evaluation
  - failure to account for full damage
  - under-scoping or cosmetic-only repair recommendations
- Frame these as ${isProven ? "investigation and evaluation considerations" : "risks to the carrier"} without citing specific statutes unless provided.
- Reference the carrier's obligations under standards of good-faith claim handling.
${toneBlock}

DECLARED POSITION ALIGNMENT:
${args.declaredPositionText || "No declared position provided."}
- If a declared position is provided, align the entire demand with it and do not deviate.
- The demand must reinforce the declared loss mechanism, coverage trigger, and requested remedy.

RETURN STRICT JSON with this exact shape:
{
  "title": "string",
  "subject_line": "string",
  "demand_amount": "string",
  "executive_summary": "string",
  "cause_of_loss_analysis": "string",
  "detailed_damage_findings": "string",
  "scope_and_repair_justification": "string",
  "repair_vs_replacement_analysis": "string",
  "code_and_compliance_requirements": "string",
  "system_interdependency_analysis": "string",
  "carrier_risk_and_exposure": "string",
  "formal_demand": "string",
  "full_demand_package": "string",
  "strategic_notes": "string",
  "missing_evidence": ["string"],
  "confidence_score": 0
}

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

FINAL REQUIREMENT:
The "full_demand_package" field must be a polished, carrier-ready demand document with clear section headings:
${isProven
    ? `1. Summary of Findings
2. Cause of Loss
3. Damaged Components
4. Repairability Analysis
5. Code and Compliance Considerations
6. Financial Summary
7. Conclusion`
    : `1. Executive Summary
2. Cause of Loss Analysis
3. Detailed Damage Findings
4. Scope and Repair Justification
5. Repair vs. Replacement Analysis
6. Code and Compliance Requirements
7. System Interdependency Analysis
8. Carrier Risk and Exposure
9. Formal Demand`}

${isProven
    ? `Use this opening in substance for the demand package introduction:
${PROVEN_MODE_OPENING}

Use this process alignment language in substance before the conclusion:
${PROCESS_ALIGNMENT}

Use this conclusion language in substance:
${PROVEN_MODE_CLOSE}

If policy text is present, you must explicitly tie observed facts to specific policy language and section labels where available. If policy text is absent, note the limitation in "missing_evidence".

The document should read like a cooperative, documentation-led claim package intended to assist the carrier's investigation and determination.`
    : "The document should read like something a serious public adjuster would actually send to a carrier to push payment now."}
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

    console.log(`Demand package context: inspection=${inspectionText.length} chars, estimate=${estimateText.length} chars, timeline=${timelineText.length} chars, files=${files.length}, carrierEstimateFiles=${carrierEstimateFiles.length}, fallback=${claimContextFallback.length}`);


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
      policyText,
    });

    // Use centralized AI router with reasoning model — higher tokens for complete demands
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: mode === "proven"
              ? "You generate carrier-ready insurance claim documentation packages. Return ONLY valid JSON — no markdown, no code fences, no commentary. Every section must be thorough, expanded, and documentation-led."
              : "You generate carrier-ready insurance demand packages. Return ONLY valid JSON — no markdown, no code fences, no commentary. Every section must be thorough, expanded, and litigation-aware.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errBody = await aiResp.text();
      console.error("AI gateway error:", aiResp.status, errBody);
      throw new Error(`AI generation failed (${aiResp.status})`);
    }

    const aiData = await aiResp.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";
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
      inputSummary: {
        inspectionChars: inspectionText.length,
        estimateChars: estimateText.length,
        estimateLineCount: estimateLines.length,
        inspectionFileCount: inspectionFiles.length,
        estimateFileCount: estimateFiles.length,
        policyFileCount: policyFiles.length,
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
