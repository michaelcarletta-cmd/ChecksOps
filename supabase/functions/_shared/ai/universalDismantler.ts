/**
 * Universal Dismantler Engine — analyzes and dismantles ANY carrier-facing document.
 *
 * Extracts positions, weaknesses, assumptions, contradictions, omissions,
 * and produces structured rebuttal intelligence. Integrates with the Claims
 * Knowledge Engine for claim-specific context.
 *
 * Usage:
 *   import { analyzeDocument } from "../_shared/ai/universalDismantler.ts";
 *   const result = await analyzeDocument({ claimId, documentText, fileId, fileName, supabase });
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "./generate.ts";
import { getClaimsContextBundle, formatContextBundle } from "./claimsKnowledgeEngine.ts";
import { analyzeDocumentWithRules, buildLightweightDismantler, augmentWithLearnedRules, describeLossType, type LossTypeDetection } from "./preDismantlerRules.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface DismantlerOptions {
  claimId: string;
  documentText: string;
  fileId?: string | null;
  fileName?: string | null;
  supabase: SupabaseClient;
}

export interface DismantlerResult {
  documentType: string;
  reportSummary: string;
  mainPosition: string;
  nonCoveredTheories: string[];
  limitations: string[];
  unsupportedAssumptions: string[];
  contradictions: string[];
  omissions: string[];
  repairabilityOverreach: string[];
  coverageWeaknesses: string[];
  strongestRebuttalPoints: string[];
  evidenceToGatherNext: string[];
  draftRebuttalLanguage: string;
  meta: DismantlerMeta;
}

export interface DismantlerMeta {
  chunkCount: number;
  successfulChunks: number;
  failedChunks: number;
  model: string;
  cached: boolean;
  usedSearch: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const DOCUMENT_TYPES = [
  "engineer_report",
  "carrier_denial",
  "adjuster_response",
  "independent_report",
  "expert_opinion",
  "scope_reduction",
  "coverage_position",
  "general_claim_correspondence",
] as const;

const CHUNK_SIZE = 10000;
const CHUNK_OVERLAP = 500;

const FULL_DISMANTLER_SELECT =
  "document_type, source_file_name, report_summary, main_position, non_covered_theories, limitations, unsupported_assumptions, contradictions, omissions, repairability_overreach, coverage_weaknesses, strongest_rebuttal_points, evidence_to_gather_next, draft_rebuttal_language, chunk_count, successful_chunks, failed_chunks, model, cached, used_search";

// ── Document type detection ──────────────────────────────────────────

async function classifyDocumentType(text: string): Promise<string[]> {
  const snippet = text.slice(0, 3000);

  // Rules-first: comprehensive keyword/regex detection.
  // AI is reserved for genuinely ambiguous cases.
  const lower = snippet.toLowerCase();
  const detected = new Set<string>();

  if (/\b(engineer|structural|professional engineer|p\.?e\.?\b|licensed engineer|forensic engineer|consulting engineer)\b/.test(lower)) detected.add("engineer_report");
  if (/\b(deni(al|ed)|coverage decision|not covered|we are unable to|we must respectfully decline|claim is closed|partial denial)\b/.test(lower)) detected.add("carrier_denial");
  if (/\b(adjuster|field report|inspection report|re-?inspection|loss notice|adjuster.?'?s report)\b/.test(lower)) detected.add("adjuster_response");
  if (/\b(independent|third.?party|forensic|consulting firm|hired expert)\b/.test(lower)) detected.add("independent_report");
  if (/\b(expert opinion|expert report|technical opinion|expert disclosure)\b/.test(lower)) detected.add("expert_opinion");
  if (/\b(scope reduction|reduced scope|scope.?change|line item remov|removed from scope|reduced estimate)\b/.test(lower)) detected.add("scope_reduction");
  if (/\b(coverage position|reservation of rights|policy exclusion|endorsement applicab|cited exclusion)\b/.test(lower)) detected.add("coverage_position");

  if (detected.size > 0) return Array.from(detected);

  // Only escalate to AI if rules produced nothing AND text is substantial.
  // Short / trivial documents fall through as general correspondence.
  if (snippet.length < 500) return ["general_claim_correspondence"];

  try {
    const result = await generate({
      task: "classification",
      system: `Classify the following document excerpt into ONE or MORE of these types: ${DOCUMENT_TYPES.join(", ")}. Return ONLY a JSON array of matching types.`,
      user: snippet,
      temperature: 0,
      maxTokens: 100,
      jsonMode: true,
      searchMode: "off",
    });
    const parsed = JSON.parse(result.text.replace(/```json?\s*|\s*```/g, "").trim());
    const types = Array.isArray(parsed) ? parsed : parsed.documentTypes || parsed.types || [];
    const valid = types.filter((t: string) => (DOCUMENT_TYPES as readonly string[]).includes(t));
    return valid.length > 0 ? valid : ["general_claim_correspondence"];
  } catch {
    return ["general_claim_correspondence"];
  }
}

// ── Chunking engine ──────────────────────────────────────────────────

function chunkDocument(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;
  let usedHardBreak = false;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    if (end >= text.length) {
      end = text.length;
    } else {
      // Try to break on paragraph or heading boundary
      const searchStart = Math.max(start + 1, end - 500);
      const searchRegion = text.slice(searchStart, end + 500);
      const breakMatch = searchRegion.match(/\n\n|\n(?=[A-Z0-9])/);
      if (breakMatch && breakMatch.index !== undefined) {
        const candidateEnd = searchStart + breakMatch.index + breakMatch[0].length;
        // Only use paragraph break if it's meaningfully past start
        if (candidateEnd > start + 500) {
          end = candidateEnd;
        } else {
          // Too close to start — use hard break at CHUNK_SIZE
          end = Math.min(start + CHUNK_SIZE, text.length);
          usedHardBreak = true;
        }
      }
    }

    // Guarantee end is always past start
    if (end <= start) {
      end = Math.min(start + CHUNK_SIZE, text.length);
      usedHardBreak = true;
    }

    chunks.push(text.slice(start, end));

    // Compute next start with overlap
    let nextStart = end - CHUNK_OVERLAP;
    // Guarantee forward progress: nextStart must exceed current start
    if (nextStart <= start) {
      nextStart = end;
    }

    start = nextStart;
    if (start >= text.length) break;
  }

  console.log(`[Dismantler Chunker] input=${text.length} chars, chunks=${chunks.length}, hardBreakUsed=${usedHardBreak}`);
  return chunks;
}

/** Reconstruct a full DismantlerResult from a DB row, normalizing nulls */
export function reconstructDismantlerFromRow(d: any): DismantlerResult {
  return {
    documentType: d.document_type || '',
    reportSummary: d.report_summary || '',
    mainPosition: d.main_position || '',
    nonCoveredTheories: d.non_covered_theories || [],
    limitations: d.limitations || [],
    unsupportedAssumptions: d.unsupported_assumptions || [],
    contradictions: d.contradictions || [],
    omissions: d.omissions || [],
    repairabilityOverreach: d.repairability_overreach || [],
    coverageWeaknesses: d.coverage_weaknesses || [],
    strongestRebuttalPoints: d.strongest_rebuttal_points || [],
    evidenceToGatherNext: d.evidence_to_gather_next || [],
    draftRebuttalLanguage: d.draft_rebuttal_language || '',
    meta: {
      chunkCount: d.chunk_count ?? 0,
      successfulChunks: d.successful_chunks ?? 0,
      failedChunks: d.failed_chunks ?? 0,
      model: d.model || '',
      cached: d.cached ?? false,
      usedSearch: d.used_search ?? false,
    },
  };
}

// ── Document-specific extraction rules ───────────────────────────────

function getDocumentSpecificRules(docTypes: string[]): string {
  const rules: string[] = [];

  if (docTypes.includes("engineer_report") || docTypes.includes("expert_opinion")) {
    rules.push(`ENGINEER/EXPERT REPORT FLAGS:
- Flag if NO destructive testing was performed
- Flag if NO moisture mapping was conducted
- Flag if NO lab testing was referenced
- Flag if inspection was visual-only
- Flag any overreach into repairability or scope (engineers should opine on causation, not repair methods)
- Flag causation certainty stated without supporting testing
- Separate OBSERVATIONS from CONCLUSIONS — identify where conclusions exceed what observations support`);
  }

  if (docTypes.includes("carrier_denial") || docTypes.includes("coverage_position")) {
    rules.push(`CARRIER DENIAL/COVERAGE FLAGS:
- Flag policy language misapplication or selective quoting
- Flag unsupported denial basis (conclusory statements without investigation evidence)
- Flag evidence the carrier ignored or failed to address
- Flag conclusory statements presented as findings
- Flag missing investigation steps that should have been performed
- Flag regulatory or timeline violations (prompt pay, acknowledgment deadlines)
- Flag where carrier burden of proof for exclusions is not met`);
  }

  if (docTypes.includes("adjuster_response") || docTypes.includes("scope_reduction")) {
    rules.push(`ADJUSTER/SCOPE REDUCTION FLAGS:
- Flag vague refusal language without specifics
- Flag unsupported repair vs replace conclusions
- Flag scope minimization without technical basis
- Flag pricing that is unsupported by market data or Xactimate
- Flag contradictions with prior carrier statements or earlier adjustments
- Flag where adjuster exceeded their expertise (e.g., making engineering conclusions)`);
  }

  if (docTypes.includes("independent_report")) {
    rules.push(`INDEPENDENT REPORT FLAGS:
- Flag bias indicators (hired by carrier, conclusions align with carrier position)
- Flag limited inspection scope (e.g., only inspected portion of roof)
- Flag narrative alignment with carrier denial language
- Flag unsupported technical conclusions
- Flag if inspection conditions limited findings (weather, access, time)
- Flag if report fails to address all claimed damages`);
  }

  return rules.join("\n\n");
}

// ── Core chunk extraction ────────────────────────────────────────────

interface ChunkExtraction {
  positions_asserted: string[];
  main_position: string;
  non_covered_theories: string[];
  limitations: string[];
  assumptions: string[];
  unsupported_conclusions: string[];
  contradictions: string[];
  omissions: string[];
  repairability_statements: string[];
  scope_limitations: string[];
  code_or_standard_references: string[];
  coverage_impact_points: string[];
  rebuttal_targets: string[];
}

async function extractFromChunk(
  chunk: string,
  chunkIndex: number,
  totalChunks: number,
  docTypes: string[],
  claimContext: string,
  docSpecificRules: string,
  lossTypeBlock: string,
): Promise<ChunkExtraction | null> {
  try {
    const result = await generate({
      task: "extraction",
      system: `${claimContext}

${lossTypeBlock}

You are a forensic document dismantler for insurance claim disputes. You work for the policyholder's public adjuster.

DOCUMENT TYPE(S): ${docTypes.join(", ")}
CHUNK: ${chunkIndex + 1} of ${totalChunks}

${docSpecificRules}

EXTRACTION RULES:
- Separate observation vs conclusion — identify where conclusions exceed observations
- Identify assumptions not backed by testing, data, or evidence
- Flag speculative language ("may have", "could be", "appears to", "likely")
- Flag unsupported certainty ("clearly", "obviously", "without question")
- Identify where the document unintentionally HELPS coverage (admissions against interest)
- Identify contradictions within the document AND against the claim facts provided above
- Extract ALL usable rebuttal angles — even minor ones

Return ONLY valid JSON with this exact structure:
{
  "positions_asserted": [],
  "main_position": "",
  "non_covered_theories": [],
  "limitations": [],
  "assumptions": [],
  "unsupported_conclusions": [],
  "contradictions": [],
  "omissions": [],
  "repairability_statements": [],
  "scope_limitations": [],
  "code_or_standard_references": [],
  "coverage_impact_points": [],
  "rebuttal_targets": []
}`,
      user: chunk,
      temperature: 0.1,
      maxTokens: 3000,
      jsonMode: true,
      searchMode: "off",
    });

    const cleaned = result.text.replace(/```json?\s*|\s*```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as ChunkExtraction;
  } catch (e) {
    console.error(`[UniversalDismantler] Chunk ${chunkIndex + 1} extraction failed:`, e);
    return null;
  }
}

// ── Aggregate chunks ─────────────────────────────────────────────────

function aggregateChunks(extractions: (ChunkExtraction | null)[]): ChunkExtraction {
  const merged: ChunkExtraction = {
    positions_asserted: [],
    main_position: "",
    non_covered_theories: [],
    limitations: [],
    assumptions: [],
    unsupported_conclusions: [],
    contradictions: [],
    omissions: [],
    repairability_statements: [],
    scope_limitations: [],
    code_or_standard_references: [],
    coverage_impact_points: [],
    rebuttal_targets: [],
  };

  const dedup = (arr: string[]): string[] => [...new Set(arr.filter(Boolean))];

  for (const ext of extractions) {
    if (!ext) continue;
    merged.positions_asserted.push(...(ext.positions_asserted || []));
    if (!merged.main_position && ext.main_position) merged.main_position = ext.main_position;
    merged.non_covered_theories.push(...(ext.non_covered_theories || []));
    merged.limitations.push(...(ext.limitations || []));
    merged.assumptions.push(...(ext.assumptions || []));
    merged.unsupported_conclusions.push(...(ext.unsupported_conclusions || []));
    merged.contradictions.push(...(ext.contradictions || []));
    merged.omissions.push(...(ext.omissions || []));
    merged.repairability_statements.push(...(ext.repairability_statements || []));
    merged.scope_limitations.push(...(ext.scope_limitations || []));
    merged.code_or_standard_references.push(...(ext.code_or_standard_references || []));
    merged.coverage_impact_points.push(...(ext.coverage_impact_points || []));
    merged.rebuttal_targets.push(...(ext.rebuttal_targets || []));
  }

  // Deduplicate all arrays
  merged.positions_asserted = dedup(merged.positions_asserted);
  merged.non_covered_theories = dedup(merged.non_covered_theories);
  merged.limitations = dedup(merged.limitations);
  merged.assumptions = dedup(merged.assumptions);
  merged.unsupported_conclusions = dedup(merged.unsupported_conclusions);
  merged.contradictions = dedup(merged.contradictions);
  merged.omissions = dedup(merged.omissions);
  merged.repairability_statements = dedup(merged.repairability_statements);
  merged.scope_limitations = dedup(merged.scope_limitations);
  merged.code_or_standard_references = dedup(merged.code_or_standard_references);
  merged.coverage_impact_points = dedup(merged.coverage_impact_points);
  merged.rebuttal_targets = dedup(merged.rebuttal_targets);

  return merged;
}

// ── Final synthesis ──────────────────────────────────────────────────

async function synthesize(
  aggregated: ChunkExtraction,
  docTypes: string[],
  claimContext: string,
  docSpecificRules: string,
): Promise<Omit<DismantlerResult, "meta">> {
  const findingsBlock = `=== EXTRACTED DOCUMENT FINDINGS ===
Main Position: ${aggregated.main_position || "Not identified"}
Positions Asserted: ${aggregated.positions_asserted.join("; ") || "None"}
Non-Covered Theories: ${aggregated.non_covered_theories.join("; ") || "None"}
Limitations: ${aggregated.limitations.join("; ") || "None"}
Assumptions: ${aggregated.assumptions.join("; ") || "None"}
Unsupported Conclusions: ${aggregated.unsupported_conclusions.join("; ") || "None"}
Contradictions: ${aggregated.contradictions.join("; ") || "None"}
Omissions: ${aggregated.omissions.join("; ") || "None"}
Repairability Statements: ${aggregated.repairability_statements.join("; ") || "None"}
Scope Limitations: ${aggregated.scope_limitations.join("; ") || "None"}
Code/Standard References: ${aggregated.code_or_standard_references.join("; ") || "None"}
Coverage Impact Points: ${aggregated.coverage_impact_points.join("; ") || "None"}
Rebuttal Targets: ${aggregated.rebuttal_targets.join("; ") || "None"}
=== END EXTRACTED DOCUMENT FINDINGS ===`;

  const result = await generate({
    task: "rebuttal",
    system: `${claimContext}

${findingsBlock}

${docSpecificRules}

You are producing the FINAL DISMANTLER SYNTHESIS for this document. Your job is to take all extracted findings and produce a structured rebuttal intelligence package.

RULES:
- reportSummary: 2-3 sentence overview of what this document says and its purpose
- mainPosition: The core position or conclusion the document asserts
- strongestRebuttalPoints: Ranked by strength — most devastating first
- draftRebuttalLanguage: 2-3 paragraphs of carrier-ready rebuttal language that a PA could use directly
- evidenceToGatherNext: Specific items that would strengthen the rebuttal (not generic)
- All arrays should contain concise, actionable strings

Return ONLY valid JSON:
{
  "reportSummary": "",
  "mainPosition": "",
  "nonCoveredTheories": [],
  "limitations": [],
  "unsupportedAssumptions": [],
  "contradictions": [],
  "omissions": [],
  "repairabilityOverreach": [],
  "coverageWeaknesses": [],
  "strongestRebuttalPoints": [],
  "evidenceToGatherNext": [],
  "draftRebuttalLanguage": ""
}`,
    user: "Synthesize all extracted findings into the final dismantler output.",
    forceStrong: true,
    searchMode: "off",
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 4000,
  });

  const cleaned = result.text.replace(/```json?\s*|\s*```/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse synthesis output");
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    documentType: docTypes.join(", "),
    reportSummary: parsed.reportSummary || aggregated.main_position || "",
    mainPosition: parsed.mainPosition || aggregated.main_position || "",
    nonCoveredTheories: parsed.nonCoveredTheories || aggregated.non_covered_theories,
    limitations: parsed.limitations || aggregated.limitations,
    unsupportedAssumptions: parsed.unsupportedAssumptions || aggregated.assumptions,
    contradictions: parsed.contradictions || aggregated.contradictions,
    omissions: parsed.omissions || aggregated.omissions,
    repairabilityOverreach: parsed.repairabilityOverreach || aggregated.repairability_statements,
    coverageWeaknesses: parsed.coverageWeaknesses || aggregated.coverage_impact_points,
    strongestRebuttalPoints: parsed.strongestRebuttalPoints || aggregated.rebuttal_targets,
    evidenceToGatherNext: parsed.evidenceToGatherNext || [],
    draftRebuttalLanguage: parsed.draftRebuttalLanguage || "",
  };
}

// ── Storage ──────────────────────────────────────────────────────────

async function storeDismantlerResult(
  supabase: SupabaseClient,
  claimId: string,
  result: DismantlerResult,
  fileId?: string | null,
  fileName?: string | null,
): Promise<void> {
  try {
    await supabase.from("claim_document_dismantlers").insert({
      claim_id: claimId,
      source_file_id: fileId || null,
      source_file_name: fileName || null,
      document_type: result.documentType,
      report_summary: result.reportSummary,
      main_position: result.mainPosition,
      non_covered_theories: result.nonCoveredTheories,
      limitations: result.limitations,
      unsupported_assumptions: result.unsupportedAssumptions,
      contradictions: result.contradictions,
      omissions: result.omissions,
      repairability_overreach: result.repairabilityOverreach,
      coverage_weaknesses: result.coverageWeaknesses,
      strongest_rebuttal_points: result.strongestRebuttalPoints,
      evidence_to_gather_next: result.evidenceToGatherNext,
      draft_rebuttal_language: result.draftRebuttalLanguage,
      chunk_count: result.meta.chunkCount,
      successful_chunks: result.meta.successfulChunks,
      failed_chunks: result.meta.failedChunks,
      model: result.meta.model,
      cached: result.meta.cached,
      used_search: result.meta.usedSearch,
    });
    console.log(`[UniversalDismantler] Stored result for claim ${claimId}`);
  } catch (e) {
    console.error("[UniversalDismantler] Storage error (non-fatal):", e);
  }
}

// ── Main entry point ─────────────────────────────────────────────────

export async function analyzeDocument(opts: DismantlerOptions): Promise<DismantlerResult> {
  const { claimId, documentText, fileId, fileName, supabase } = opts;

  if (!documentText || documentText.trim().length < 50) {
    throw new Error("Document text is too short for analysis");
  }

  console.log(`[UniversalDismantler] Starting analysis for claim ${claimId}, file=${fileName || "inline"}, textLen=${documentText.length}`);

  // ── Reuse stored dismantler if available for this file (cache-first) ──
  // Re-run only if no stored result OR caller bypasses via opts.forceRefresh.
  if (fileId && !(opts as any).forceRefresh) {
    try {
      const { data: existing } = await supabase
        .from("claim_document_dismantlers")
        .select(FULL_DISMANTLER_SELECT)
        .eq("claim_id", claimId)
        .eq("source_file_id", fileId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (existing && existing.length > 0) {
        console.log(`[UniversalDismantler] REUSING stored dismantler for file ${fileId} (no AI)`);
        return reconstructDismantlerFromRow(existing[0]);
      }
    } catch (e) {
      console.warn("[UniversalDismantler] stored-result lookup failed (non-fatal):", (e as Error).message);
    }
  }

  // ── Pre-AI rules pass (cheap, deterministic) ──────────────────────
  const baseRuleResult = analyzeDocumentWithRules(documentText);

  // Augment with active learned rules (additive, non-breaking)
  let claimCtx: { carrier?: string | null; state?: string | null; trade?: string | null; material?: string | null } = {};
  try {
    const { data: cl } = await supabase
      .from("claims")
      .select("insurance_company, state, construction_trade, roof_material")
      .eq("id", claimId)
      .maybeSingle();
    claimCtx = {
      carrier: cl?.insurance_company || null,
      state: cl?.state || null,
      trade: cl?.construction_trade || null,
      material: cl?.roof_material || null,
    };
  } catch { /* non-fatal */ }

  const ruleResult = await augmentWithLearnedRules(documentText, baseRuleResult, supabase, claimCtx);
  console.log(
    `[UniversalDismantler] Pre-AI rules: score=${ruleResult.weaknessScore} (base=${baseRuleResult.weaknessScore}, learned=+${ruleResult.learnedScoreBump}), flags=[${Object.entries(ruleResult.flags).filter(([, v]) => v).map(([k]) => k).join(",")}], learnedHits=${ruleResult.learnedRuleHits.length}, escalate=${ruleResult.shouldEscalateToAI}${ruleResult.escalationReason ? ` (${ruleResult.escalationReason})` : ""}`,
  );

  if (!ruleResult.shouldEscalateToAI) {
    console.log(`[UniversalDismantler] AI SKIPPED — using lightweight rule-based output (score=${ruleResult.weaknessScore}, learnedHits=${ruleResult.learnedRuleHits.length})`);
    const lite = buildLightweightDismantler(documentText, ruleResult, undefined, ruleResult.learnedRuleHits);
    const finalResult: DismantlerResult = {
      documentType: lite.documentType,
      reportSummary: lite.reportSummary,
      mainPosition: lite.mainPosition,
      nonCoveredTheories: lite.nonCoveredTheories,
      limitations: lite.limitations,
      unsupportedAssumptions: lite.unsupportedAssumptions,
      contradictions: lite.contradictions,
      omissions: lite.omissions,
      repairabilityOverreach: lite.repairabilityOverreach,
      coverageWeaknesses: lite.coverageWeaknesses,
      strongestRebuttalPoints: lite.strongestRebuttalPoints,
      evidenceToGatherNext: lite.evidenceToGatherNext,
      draftRebuttalLanguage: lite.draftRebuttalLanguage,
      meta: {
        chunkCount: 0,
        successfulChunks: 0,
        failedChunks: 0,
        model: "rules-only",
        cached: false,
        usedSearch: false,
      },
    };
    await storeDismantlerResult(supabase, claimId, finalResult, fileId, fileName);
    return finalResult;
  }

  console.log(`[UniversalDismantler] AI USED — escalating: ${ruleResult.escalationReason}`);

  // Step 1: Document type detection
  const docTypes = await classifyDocumentType(documentText);
  console.log(`[UniversalDismantler] Detected types: ${docTypes.join(", ")}`);

  // Step 2: Claim context via Knowledge Engine
  let claimContext = "";
  let bundleUsedSearch = false;
  try {
    const bundle = await getClaimsContextBundle({
      claimId,
      userQuery: "Dismantle this document",
      taskType: "rebuttal",
      supabase,
    });
    claimContext = formatContextBundle(bundle);
    bundleUsedSearch = bundle.retrievalMeta.usedSearch;
    console.log(`[UniversalDismantler] Knowledge Engine: dispute=${bundle.disputeType}, knowledge=${bundle.retrievalMeta.knowledgeCount}`);
  } catch (e) {
    console.error("[UniversalDismantler] Knowledge Engine error (non-fatal):", e);
  }

  // Step 3: Chunk document
  const chunks = chunkDocument(documentText);
  console.log(`[UniversalDismantler] Document split into ${chunks.length} chunks`);

  // Step 4: Document-specific rules
  const docSpecificRules = getDocumentSpecificRules(docTypes);

  // Step 5: Extract from all chunks (sequential to manage token budget)
  const extractions: (ChunkExtraction | null)[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const ext = await extractFromChunk(
      chunks[i],
      i,
      chunks.length,
      docTypes,
      claimContext,
      docSpecificRules,
    );
    extractions.push(ext);
  }

  const successfulChunks = extractions.filter(Boolean).length;
  const failedChunks = extractions.length - successfulChunks;
  console.log(`[UniversalDismantler] Extraction: ${successfulChunks}/${chunks.length} chunks succeeded`);

  if (successfulChunks === 0) {
    throw new Error("All chunk extractions failed — cannot produce dismantler output");
  }

  // Step 6: Aggregate
  const aggregated = aggregateChunks(extractions);

  // Step 7: Final synthesis
  const synthesized = await synthesize(aggregated, docTypes, claimContext, docSpecificRules);

  const finalResult: DismantlerResult = {
    ...synthesized,
    meta: {
      chunkCount: chunks.length,
      successfulChunks,
      failedChunks,
      model: "routed",
      cached: false,
      usedSearch: bundleUsedSearch,
    },
  };

  // Step 8: Store
  await storeDismantlerResult(supabase, claimId, finalResult, fileId, fileName);

  console.log(`[UniversalDismantler] Complete: type=${docTypes.join(",")}, rebuttals=${finalResult.strongestRebuttalPoints.length}, chunks=${chunks.length}`);

  return finalResult;
}

// ── Formatting helper for prompt injection ───────────────────────────

export function formatDismantlerForPrompt(result: DismantlerResult): string {
  const sections: string[] = [];

  sections.push(`=== DOCUMENT DISMANTLER INTELLIGENCE ===
Document Type: ${result.documentType}
Summary: ${result.reportSummary}
Main Position: ${result.mainPosition}`);

  if (result.strongestRebuttalPoints.length > 0) {
    sections.push(`Strongest Rebuttal Points:\n${result.strongestRebuttalPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
  }
  if (result.contradictions.length > 0) {
    sections.push(`Contradictions Found:\n${result.contradictions.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (result.unsupportedAssumptions.length > 0) {
    sections.push(`Unsupported Assumptions:\n${result.unsupportedAssumptions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  }
  if (result.limitations.length > 0) {
    sections.push(`Limitations:\n${result.limitations.map((l, i) => `${i + 1}. ${l}`).join("\n")}`);
  }
  if (result.coverageWeaknesses.length > 0) {
    sections.push(`Coverage Weaknesses:\n${result.coverageWeaknesses.map((w, i) => `${i + 1}. ${w}`).join("\n")}`);
  }
  if (result.omissions.length > 0) {
    sections.push(`Omissions:\n${result.omissions.map((o, i) => `${i + 1}. ${o}`).join("\n")}`);
  }
  if (result.draftRebuttalLanguage) {
    sections.push(`Draft Rebuttal Language:\n${result.draftRebuttalLanguage}`);
  }

  sections.push("=== END DOCUMENT DISMANTLER INTELLIGENCE ===");

  return sections.join("\n\n");
}
