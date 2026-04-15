/**
 * Dismantler Action Layer — converts dismantler intelligence into usable outputs.
 *
 * Builds on top of the Universal Dismantler Engine to produce:
 * 1. Rebuttals
 * 2. Demand paragraphs
 * 3. Client explanations
 * 4. Evidence checklists
 * 5. Adjuster emails
 *
 * Usage:
 *   import { buildRebuttalFromDismantler } from "../_shared/ai/dismantlerActions.ts";
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "./generate.ts";
import { getClaimsContextBundle, formatContextBundle } from "./claimsKnowledgeEngine.ts";
import { formatDismantlerForPrompt, reconstructDismantlerFromRow, type DismantlerResult } from "./universalDismantler.ts";

// ── Types ────────────────────────────────────────────────────────────

export type DismantlerActionType =
  | "rebuttal"
  | "demand_paragraph"
  | "client_explanation"
  | "evidence_checklist"
  | "adjuster_email";

export interface DismantlerActionOptions {
  claimId: string;
  dismantlerResult?: DismantlerResult | null;
  userInstruction?: string;
  supabase: SupabaseClient;
}

export interface DismantlerActionOutput {
  actionType: DismantlerActionType;
  content: string;
  model: string;
  cached: boolean;
  sourceDocumentType: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

const FULL_DISMANTLER_SELECT =
  "document_type, source_file_name, report_summary, main_position, non_covered_theories, limitations, unsupported_assumptions, contradictions, omissions, repairability_overreach, coverage_weaknesses, strongest_rebuttal_points, evidence_to_gather_next, draft_rebuttal_language, chunk_count, successful_chunks, failed_chunks, model, cached, used_search";

async function resolveResult(
  opts: DismantlerActionOptions,
): Promise<DismantlerResult | null> {
  if (opts.dismantlerResult) return opts.dismantlerResult;

  const { data } = await opts.supabase
    .from("claim_document_dismantlers")
    .select(FULL_DISMANTLER_SELECT)
    .eq("claim_id", opts.claimId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length > 0) return reconstructDismantlerFromRow(data[0]);
  return null;
}

async function buildContext(
  claimId: string,
  taskLabel: string,
  dismantler: DismantlerResult,
  supabase: SupabaseClient,
): Promise<string> {
  let knowledgeCtx = "";
  try {
    const bundle = await getClaimsContextBundle({
      claimId,
      userQuery: taskLabel,
      taskType: "rebuttal",
      supabase,
    });
    knowledgeCtx = formatContextBundle(bundle);
  } catch (e) {
    console.error("[DismantlerActions] Knowledge Engine error (non-fatal):", e);
  }

  const dismantlerCtx = formatDismantlerForPrompt(dismantler);

  return [knowledgeCtx, dismantlerCtx].filter(Boolean).join("\n\n");
}

// ── Action builders ──────────────────────────────────────────────────

export async function buildRebuttalFromDismantler(
  opts: DismantlerActionOptions,
): Promise<DismantlerActionOutput> {
  const dismantler = await resolveResult(opts);
  if (!dismantler) throw new Error("No dismantler result available for this claim");

  const ctx = await buildContext(opts.claimId, "Build carrier rebuttal", dismantler, opts.supabase);

  const ai = await generate({
    task: "copilot_reasoning",
    system: ctx + `\n\nYou are a senior public adjuster writing a formal carrier-facing rebuttal. Use the dismantler intelligence above to craft a point-by-point rebuttal that:
- Addresses each carrier position with specific counter-evidence
- Cites contradictions and unsupported assumptions found in their document
- References applicable codes, standards, and regulations
- Maintains professional but assertive advocacy tone
- Structures arguments in order of strength

${opts.userInstruction ? `Additional instruction: ${opts.userInstruction}` : ""}

Write the full rebuttal text. Do NOT return JSON.`,
    user: "Generate the rebuttal now based on all dismantler findings.",
    claimId: opts.claimId,
    forceStrong: true,
    searchMode: "off",
  });

  return {
    actionType: "rebuttal",
    content: ai.text,
    model: ai.model || "",
    cached: ai.cached || false,
    sourceDocumentType: dismantler.documentType,
  };
}

export async function buildDemandParagraphFromDismantler(
  opts: DismantlerActionOptions,
): Promise<DismantlerActionOutput> {
  const dismantler = await resolveResult(opts);
  if (!dismantler) throw new Error("No dismantler result available for this claim");

  const ctx = await buildContext(opts.claimId, "Build demand package paragraph", dismantler, opts.supabase);

  const ai = await generate({
    task: "copilot_reasoning",
    system: ctx + `\n\nYou are a senior public adjuster writing a demand package section. Using the dismantler intelligence:
- Summarize the carrier's flawed position
- Present the strongest rebuttal points as demand justification
- Reference coverage weaknesses and contradictions
- Conclude with a clear demand statement
- Keep tone formal, assertive, and evidence-based
- Write 2-4 paragraphs suitable for insertion into a demand letter

${opts.userInstruction ? `Additional instruction: ${opts.userInstruction}` : ""}

Write the demand paragraph(s). Do NOT return JSON.`,
    user: "Generate the demand package paragraph(s) now.",
    claimId: opts.claimId,
    forceStrong: true,
    searchMode: "off",
  });

  return {
    actionType: "demand_paragraph",
    content: ai.text,
    model: ai.model || "",
    cached: ai.cached || false,
    sourceDocumentType: dismantler.documentType,
  };
}

export async function buildClientExplanationFromDismantler(
  opts: DismantlerActionOptions,
): Promise<DismantlerActionOutput> {
  const dismantler = await resolveResult(opts);
  if (!dismantler) throw new Error("No dismantler result available for this claim");

  const ctx = await buildContext(opts.claimId, "Explain document findings to client", dismantler, opts.supabase);

  const ai = await generate({
    task: "copilot_drafting",
    system: ctx + `\n\nYou are a public adjuster explaining a carrier document analysis to a homeowner client. Using the dismantler intelligence:
- Explain in plain, non-technical language what the carrier/engineer said
- Highlight the problems found with their position (without legal jargon)
- Reassure the client about the strength of their claim
- Explain what steps come next
- Keep it warm, clear, and professional — no insurance jargon
- 3-5 short paragraphs

${opts.userInstruction ? `Additional instruction: ${opts.userInstruction}` : ""}

Write the client explanation. Do NOT return JSON.`,
    user: "Generate the client-friendly explanation now.",
    claimId: opts.claimId,
    searchMode: "off",
  });

  return {
    actionType: "client_explanation",
    content: ai.text,
    model: ai.model || "",
    cached: ai.cached || false,
    sourceDocumentType: dismantler.documentType,
  };
}

export async function buildEvidenceChecklistFromDismantler(
  opts: DismantlerActionOptions,
): Promise<DismantlerActionOutput> {
  const dismantler = await resolveResult(opts);
  if (!dismantler) throw new Error("No dismantler result available for this claim");

  const ctx = await buildContext(opts.claimId, "Build evidence checklist", dismantler, opts.supabase);

  const ai = await generate({
    task: "copilot_reasoning",
    system: ctx + `\n\nYou are a claims strategist building an evidence gathering checklist. Using the dismantler intelligence:
- List every piece of evidence needed to counter the carrier's position
- Prioritize evidence that addresses the strongest carrier arguments
- Include: photos needed, tests to request, expert opinions, documents to obtain
- Mark each item as HIGH / MEDIUM / LOW priority
- For each item, explain WHY it counters a specific carrier point
- Format as a numbered checklist

${opts.userInstruction ? `Additional instruction: ${opts.userInstruction}` : ""}

Write the evidence checklist. Do NOT return JSON.`,
    user: "Generate the evidence gathering checklist now.",
    claimId: opts.claimId,
    searchMode: "off",
  });

  return {
    actionType: "evidence_checklist",
    content: ai.text,
    model: ai.model || "",
    cached: ai.cached || false,
    sourceDocumentType: dismantler.documentType,
  };
}

export async function buildAdjusterEmailFromDismantler(
  opts: DismantlerActionOptions,
): Promise<DismantlerActionOutput> {
  const dismantler = await resolveResult(opts);
  if (!dismantler) throw new Error("No dismantler result available for this claim");

  const ctx = await buildContext(opts.claimId, "Draft adjuster email response", dismantler, opts.supabase);

  const ai = await generate({
    task: "copilot_drafting",
    system: ctx + `\n\nYou are a senior public adjuster drafting a professional email to the insurance adjuster. Using the dismantler intelligence:
- Open with a reference to the document being addressed
- Present the key rebuttal points concisely
- Request specific actions (re-inspection, reconsideration, supplement review)
- Reference contradictions and unsupported assumptions diplomatically but firmly
- Close with a clear call to action and timeline expectation
- Professional tone — firm but not hostile
- Keep under 400 words

${opts.userInstruction ? `Additional instruction: ${opts.userInstruction}` : ""}

Write the email body only (no subject line). Do NOT return JSON.`,
    user: "Generate the adjuster email now.",
    claimId: opts.claimId,
    forceStrong: true,
    searchMode: "off",
  });

  return {
    actionType: "adjuster_email",
    content: ai.text,
    model: ai.model || "",
    cached: ai.cached || false,
    sourceDocumentType: dismantler.documentType,
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────

const ACTION_MAP: Record<DismantlerActionType, (opts: DismantlerActionOptions) => Promise<DismantlerActionOutput>> = {
  rebuttal: buildRebuttalFromDismantler,
  demand_paragraph: buildDemandParagraphFromDismantler,
  client_explanation: buildClientExplanationFromDismantler,
  evidence_checklist: buildEvidenceChecklistFromDismantler,
  adjuster_email: buildAdjusterEmailFromDismantler,
};

export async function executeDismantlerAction(
  actionType: DismantlerActionType,
  opts: DismantlerActionOptions,
): Promise<DismantlerActionOutput> {
  const handler = ACTION_MAP[actionType];
  if (!handler) throw new Error(`Unknown dismantler action type: ${actionType}`);
  return handler(opts);
}

/** Detect if user is requesting a dismantler action in copilot chat */
export function detectDismantlerAction(message: string): DismantlerActionType | null {
  const lower = message.toLowerCase();

  if (/\b(?:write|draft|build|create|generate)\b[\s\S]{0,40}\b(?:rebuttal|counter[\s-]?argument|point[\s-]?by[\s-]?point)\b/i.test(lower)) return "rebuttal";
  if (/\b(?:demand|demand[\s-]?package|demand[\s-]?letter|demand[\s-]?paragraph)\b/i.test(lower)) return "demand_paragraph";
  if (/\b(?:explain|client[\s-]?update|homeowner|client[\s-]?explanation|plain[\s-]?english)\b[\s\S]{0,40}\b(?:report|denial|findings|document|analysis|engineer)\b/i.test(lower)) return "client_explanation";
  if (/\b(?:evidence|checklist|what[\s-]?do[\s-]?we[\s-]?need|gather|documentation[\s-]?needed)\b/i.test(lower)) return "evidence_checklist";
  if (/\b(?:email|write[\s-]?to|respond[\s-]?to|reply[\s-]?to)\b[\s\S]{0,40}\b(?:adjuster|carrier|insurance|claims[\s-]?rep)\b/i.test(lower)) return "adjuster_email";

  return null;
}
