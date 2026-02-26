import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Use dynamic import for pdf.js to avoid bundling issues
let pdfjsLib: any = null;
async function getPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.mjs");
  }
  return pdfjsLib;
}
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Size threshold for using native extraction vs AI multimodal (8MB base64 ~ 6MB file)
const AI_EXTRACTION_LIMIT = 8 * 1024 * 1024;
const MODEL_REQUEST_TIMEOUT_MS = 55_000;
const MODEL_TOTAL_RUNTIME_LIMIT_MS = 180_000;

// ============================================================================
// MANDATORY ORDER OF OPERATIONS FRAMEWORK
// Injected into all strategic analysis types (denial_rebuttal, auto_draft_rebuttal,
// systematic_dismantling, supplement, engineer_report_rebuttal, demand_package, etc.)
// ============================================================================
const MANDATORY_ORDER_OF_OPERATIONS = `
=== MANDATORY ORDER OF OPERATIONS (ENFORCED — NO DEVIATIONS) ===

You MUST follow this exact 4-step sequence. Do NOT skip steps or reorder them.

STEP 1: COVERAGE DETERMINATION (Policy + Regulation ONLY)
Establish coverage using ONLY:
- Policy language (Coverage, Exclusions, Exceptions, Conditions, Endorsements)
- State insurance regulations / DOI standards
Coverage is triggered by:
- Direct physical loss
- Covered cause of loss
- Insurable interest
- Compliance with policy conditions

DO NOT USE for coverage determination:
- Manufacturer specifications
- Building codes
- Installation guidelines
- Carrier internal preferences
Manufacturer specs and building codes are NOT coverage triggers.

STEP 2: PROOF OF DAMAGE
After identifying the applicable coverage section:
- Request/document evidence of direct physical loss
- Identify measurable/observable damage
- Connect damage to covered peril
If damage evidence is insufficient, STOP and request documentation before proceeding.

STEP 3: SCOPE DISCUSSION (Repair vs Replace)
ONLY after coverage is supported:
- Discuss feasibility of repair vs replacement
- Apply policy loss settlement terms (RCV/ACV)
- Consider matching, uniform appearance, and reasonable repair standards
- Use regulations governing proper claim handling
- Manufacturer specs may ONLY support method feasibility — they CANNOT deny coverage

STEP 4: REPAIR PROCESS (Only After Steps 1-3 Are Complete)
ONLY after coverage basis established, damage proven, and scope agreed/discussed:
- Discuss contractor workflow, supplements, depreciation, scheduling, etc.

=== AUTHORITY HIERARCHY (MUST BE ENFORCED) ===
All arguments MUST follow this hierarchy (highest to lowest):
1. Policy language (SUPREME authority)
2. State insurance regulations and statutes
3. Case law (if applicable — but NEVER cite case law in outputs)
4. Industry estimating standards
5. Building code (ONLY for Ordinance & Law if endorsed)
6. Manufacturer specifications (method support ONLY)

The AI MUST NOT elevate items 5 or 6 above items 1 or 2.

=== HARD GUARDRAILS ===
- NEVER deny or limit replacement solely because damage does not meet manufacturer specs
- NEVER use code compliance as a reason to deny coverage unless Ordinance & Law coverage applies
- NEVER move into repair execution (Step 4) without confirming coverage (Step 1)
- Manufacturer specs CANNOT override policy language or state regulations

=== REQUIRED OUTPUT STRUCTURE ===
Every claim response MUST include these sections in order:
1. Coverage Basis — what policy provision affords coverage
2. Damage Evidence — what proves the loss occurred
3. Scope Analysis — repair vs replace with justification
4. Next Action Step — what to do next
No deviations from this structure.

=== END MANDATORY ORDER OF OPERATIONS ===
`;

// Helper to get the framework for injection into prompts
function getMandatoryFramework(): string {
  return MANDATORY_ORDER_OF_OPERATIONS;
}

const STRUCTURED_DARWIN_ANALYSIS_TYPES = new Set<string>([
  'denial_rebuttal',
  'next_steps',
  'supplement',
  'correspondence',
  'task_followup',
]);

type DarwinMode = 'rebuttal' | 'steelman' | 'evidence' | 'scripts';

interface DarwinKeyClaim {
  claim: string;
  assumptions: string[];
}

interface DarwinBestRebuttal {
  rebuttal: string;
  reasoning: string;
  suggested_phrasing: string;
  strength_score: number;
}

interface DarwinEvidenceSource {
  label: string;
  url?: string;
}

interface DarwinEvidencePackItem {
  key_facts: string[];
  sources: DarwinEvidenceSource[];
  relevance: string;
}

interface DarwinTalkingPoints {
  '30-sec': string;
  '2-min': string;
  '5-min': string;
}

interface DarwinStructuredResult {
  steelman_opponent: string;
  their_key_claims: DarwinKeyClaim[];
  my_best_rebuttals: DarwinBestRebuttal[];
  evidence_pack: DarwinEvidencePackItem[];
  questions_to_clarify: string[];
  risk_flags: string[];
  talking_points: DarwinTalkingPoints;
  confidence: number;
  uncertainties: string[];
}

const DARWIN_STRUCTURED_SCHEMA = `{
  "steelman_opponent": "string",
  "their_key_claims": [{"claim": "string", "assumptions": ["string"]}],
  "my_best_rebuttals": [{"rebuttal": "string", "reasoning": "string", "suggested_phrasing": "string", "strength_score": 0-100}],
  "evidence_pack": [{"key_facts": ["string"], "sources": [{"label": "string", "url": "optional"}], "relevance": "string"}],
  "questions_to_clarify": ["string"],
  "risk_flags": ["string"],
  "talking_points": {"30-sec": "string", "2-min": "string", "5-min": "string"},
  "confidence": 0-100,
  "uncertainties": ["string"]
}`;

function normalizeDarwinMode(mode?: string): DarwinMode {
  if (!mode) return 'rebuttal';
  const normalized = mode.toLowerCase().trim();
  if (normalized === 'rebuttal' || normalized === 'steelman' || normalized === 'evidence' || normalized === 'scripts') {
    return normalized;
  }
  return 'rebuttal';
}

function buildStructuredModeInstructions(mode: DarwinMode): string {
  const modeInstructions: Record<DarwinMode, string> = {
    rebuttal: 'Prioritize strongest counterarguments, direct rebuttal logic, and high-impact phrasing.',
    steelman: 'Prioritize charitable reconstruction of the opposing case before rebutting it.',
    evidence: 'Prioritize verifiable facts, citations, source quality, and uncertainty transparency.',
    scripts: 'Prioritize practical speaking scripts, talking points, and ready-to-use language.',
  };

  return `
CRITICAL OUTPUT RULES:
- You MUST return ONLY valid JSON. No markdown. No prose outside JSON. No code fences.
- JSON MUST match this exact schema and key names:
${DARWIN_STRUCTURED_SCHEMA}
- Active mode: "${mode}".
- Mode guidance: ${modeInstructions[mode]}
- confidence and strength_score must be numbers from 0 to 100.
- If uncertain, use conservative confidence and fill uncertainties with specific gaps.`;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

function clampScore(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function ensureStructuredResult(raw: unknown): DarwinStructuredResult {
  const obj = toRecord(raw) ?? {};

  const theirKeyClaimsRaw = Array.isArray(obj.their_key_claims) ? obj.their_key_claims : [];
  const their_key_claims: DarwinKeyClaim[] = theirKeyClaimsRaw.map((item) => {
    const entry = toRecord(item) ?? {};
    return {
      claim: toStringValue(entry.claim),
      assumptions: toStringArray(entry.assumptions),
    };
  });

  const rebuttalsRaw = Array.isArray(obj.my_best_rebuttals) ? obj.my_best_rebuttals : [];
  const my_best_rebuttals: DarwinBestRebuttal[] = rebuttalsRaw.map((item) => {
    const entry = toRecord(item) ?? {};
    return {
      rebuttal: toStringValue(entry.rebuttal),
      reasoning: toStringValue(entry.reasoning),
      suggested_phrasing: toStringValue(entry.suggested_phrasing),
      strength_score: clampScore(entry.strength_score, 0),
    };
  });

  const evidencePackRaw = Array.isArray(obj.evidence_pack) ? obj.evidence_pack : [];
  const evidence_pack: DarwinEvidencePackItem[] = evidencePackRaw.map((item) => {
    const entry = toRecord(item) ?? {};
    const sourcesRaw = Array.isArray(entry.sources) ? entry.sources : [];
    const sources: DarwinEvidenceSource[] = sourcesRaw.map((sourceItem) => {
      const source = toRecord(sourceItem) ?? {};
      const url = toStringValue(source.url);
      return {
        label: toStringValue(source.label),
        ...(url ? { url } : {}),
      };
    });
    return {
      key_facts: toStringArray(entry.key_facts),
      sources,
      relevance: toStringValue(entry.relevance),
    };
  });

  const talkingPointsRaw = toRecord(obj.talking_points) ?? {};
  const talking_points: DarwinTalkingPoints = {
    '30-sec': toStringValue(talkingPointsRaw['30-sec']),
    '2-min': toStringValue(talkingPointsRaw['2-min']),
    '5-min': toStringValue(talkingPointsRaw['5-min']),
  };

  return {
    steelman_opponent: toStringValue(obj.steelman_opponent),
    their_key_claims,
    my_best_rebuttals,
    evidence_pack,
    questions_to_clarify: toStringArray(obj.questions_to_clarify),
    risk_flags: toStringArray(obj.risk_flags),
    talking_points,
    confidence: clampScore(obj.confidence, 0),
    uncertainties: toStringArray(obj.uncertainties),
  };
}

function parseStructuredResponse(rawResponse: string): DarwinStructuredResult {
  const withoutFence = stripCodeFence(rawResponse);
  let parsed: unknown;

  try {
    parsed = JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Model response did not contain a JSON object.');
    }
    const jsonSlice = withoutFence.slice(firstBrace, lastBrace + 1);
    parsed = JSON.parse(jsonSlice);
  }

  return ensureStructuredResult(parsed);
}

// Extract text from PDF using pdf.js (Deno-compatible, no AI, lower memory usage)
async function extractTextFromPDFNative(base64Content: string, fileName: string): Promise<string> {
  console.log(`Native PDF extraction for: ${fileName}`);
  
  try {
    // Get pdf.js dynamically
    const pdfjs = await getPdfJs();
    
    // Decode base64 to bytes
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Load PDF using pdf.js
    const loadingTask = pdfjs.getDocument({ data: bytes.buffer });
    const pdf = await loadingTask.promise;
    
    const textParts: string[] = [];
    
    // Extract text from each page
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
      if (pageText.trim()) {
        textParts.push(pageText);
      }
    }
    
    const extractedText = textParts.join('\n\n');
    console.log(`Native extraction got ${extractedText.length} characters from ${pdf.numPages} pages`);
    
    if (!extractedText || extractedText.trim().length < 100) {
      throw new Error('PDF appears to be scanned/image-based with minimal text');
    }
    
    return extractedText;
  } catch (error) {
    console.error('Native PDF extraction failed:', error);
    throw error;
  }
}

function fileNameFromStoragePath(path: string): string {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || 'document.pdf';
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function downloadPdfFromClaimStorageAsBase64(supabase: any, path: string): Promise<string> {
  console.log(`[downloadPdf] Attempting to download from claim-files: "${path}"`);
  const { data: fileBlob, error } = await supabase.storage.from('claim-files').download(path);
  if (error || !fileBlob) {
    console.error(`[downloadPdf] Storage download failed for "${path}":`, JSON.stringify(error));
    // Fallback: try fetching extracted text from DB instead
    const { data: fileRow } = await supabase
      .from('claim_files')
      .select('extracted_text')
      .eq('file_path', path)
      .maybeSingle();
    if (fileRow?.extracted_text && fileRow.extracted_text.length > 50) {
      console.log(`[downloadPdf] Using extracted_text fallback for "${path}" (${fileRow.extracted_text.length} chars)`);
      // Return a tagged string so callers know this is NOT real PDF binary.
      // The TEXT_FALLBACK: prefix is detected downstream to switch to text-only mode.
      return `TEXT_FALLBACK:${fileRow.extracted_text}`;
    }
    throw new Error(`Unable to download PDF from claim-files storage at "${path}": ${JSON.stringify(error) || 'no data'}`);
  }

  const bytes = new Uint8Array(await fileBlob.arrayBuffer());
  console.log(`[downloadPdf] Successfully downloaded ${bytes.length} bytes from "${path}"`);
  return bytesToBase64(bytes);
}

// Reuse the same knowledge base search logic as the main Claims AI Assistant
// so Darwin can leverage uploaded training materials (including ACV audio).
async function searchKnowledgeBase(supabase: any, question: string, category?: string): Promise<string> {
  try {
    let query = supabase
      .from('ai_knowledge_chunks')
      .select(`
        content,
        metadata,
        ai_knowledge_documents!inner(category, file_name, status)
      `)
      .eq('ai_knowledge_documents.status', 'completed');

    if (category) {
      query = query.eq('ai_knowledge_documents.category', category);
    }

    const { data: chunks, error } = await query.limit(100);

    if (error || !chunks || chunks.length === 0) {
      console.log('Darwin KB: no chunks found');
      return '';
    }

    console.log(`Darwin KB: searching ${chunks.length} chunks`);

    const questionLower = question.toLowerCase();
    const questionWords = questionLower
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 2);

    const importantTerms = [
      'depreciation',
      'acv',
      'rcv',
      'actual cash value',
      'replacement cost',
      'ordinance',
      'law',
      'code',
      'compliance',
      'deductible',
      'coverage',
      'policy',
      'claim',
      'adjuster',
      'supplement',
      'denial',
      'settlement',
      'recoverable',
      'non-recoverable',
      'dwelling',
      'roofing',
      'damage',
      'wind',
      'hail',
      'storm',
      'inspection',
      'estimate',
      'xactimate',
    ];

    const matchedTerms = importantTerms.filter((term) => questionLower.includes(term));
    const isAcvQuestion = /\bacv\b|actual cash value|code upgrade|ordinance and law|ordinance & law/i.test(questionLower);

    const scoredChunks = chunks
      .map((chunk: any) => {
        const contentLower = chunk.content.toLowerCase();
        const sourceName = (chunk.ai_knowledge_documents?.file_name || '').toLowerCase();
        const category = (chunk.ai_knowledge_documents?.category || '').toLowerCase();
        const isFromAcvAudio = sourceName.includes('acv and code upgrade');
        const isFromAudioRecording = isFromAcvAudio || (category === 'building-codes' && sourceName.includes('acv'));

        let score = 0;

        questionWords.forEach((word) => {
          if (contentLower.includes(word)) {
            score += 1;
            if (importantTerms.includes(word)) {
              score += 2;
            }
          }
        });

        matchedTerms.forEach((term) => {
          if (contentLower.includes(term)) {
            score += 3;
          }
        });

        const phrases = questionLower.match(/["']([^"']+)["']/g);
        if (phrases) {
          phrases.forEach((phrase) => {
            const cleanPhrase = phrase.replace(/["']/g, '');
            if (contentLower.includes(cleanPhrase)) {
              score += 5;
            }
          });
        }

        if (isAcvQuestion && isFromAudioRecording) {
          score += 30;
        }

        return { ...chunk, score, sourceName, category, isFromAudioRecording };
      })
      .filter((c: any) => c.score > 0);

    let finalChunks: any[] = scoredChunks;
    if (isAcvQuestion) {
      const audioChunks = scoredChunks.filter((c: any) => c.isFromAudioRecording);
      if (audioChunks.length > 0) {
        finalChunks = audioChunks;
      }
    }

    finalChunks = finalChunks.sort((a: any, b: any) => b.score - a.score).slice(0, 8);

    console.log(
      `Darwin KB: using ${finalChunks.length} chunks with scores: ${finalChunks
        .map((c: any) => c.score)
        .join(', ')}`,
    );
    if (isAcvQuestion) {
      console.log('Darwin KB ACV sources:', finalChunks.map((c: any) => c.sourceName));
    }

    if (finalChunks.length === 0) {
      return '';
    }

    let knowledgeContext = '\n\n=== INTERNAL KNOWLEDGE BASE (USE BUT DO NOT CITE) ===\n';
    knowledgeContext +=
      'CRITICAL: Use the following knowledge to INFORM your analysis, arguments, and recommendations.\n';
    knowledgeContext +=
      'However, DO NOT cite or reference "training materials", "knowledge base", or these source documents in your output.\n';
    knowledgeContext +=
      'Instead, present the information as your own expert knowledge and cite ONLY authoritative external sources like:\n';
    knowledgeContext +=
      '- Building codes (IRC, IBC, state-specific codes)\n';
    knowledgeContext +=
      '- Manufacturer specifications and technical bulletins\n';
    knowledgeContext +=
      '- Industry standards (ASTM, ARMA, NRCA)\n';
    knowledgeContext +=
      '- State insurance regulations and statutes\n';
    knowledgeContext +=
      'The knowledge below is for YOUR reference only—never expose these sources to the end user.\n\n';

    finalChunks.forEach((chunk: any, i: number) => {
      knowledgeContext += `--- Reference ${i + 1} ---\n${chunk.content}\n\n`;
    });

    knowledgeContext += '=== END INTERNAL KNOWLEDGE ===\n';

    return knowledgeContext;
  } catch (error) {
    console.error('Darwin KB error:', error);
    return '';
  }
}


// ClaimFactsPack from EvidenceIndex - small, structured, citation-friendly (references only)
// FolderKey: import shared definition to avoid drift (sync with src/lib/darwinContracts.ts)
import type { FolderKey } from '../_shared/darwin-contracts.ts';
import { logDismantlerTelemetry } from '../_shared/darwin-telemetry.ts';
interface ClaimFactsPack {
  meta: {
    claimId: string;
    state?: string | null;
    carrier?: string | null;
    audience?: 'carrier' | 'regulator' | 'internal';
    regulatoryComplaint?: boolean;
    drp?: boolean;
    lossType?: string | null;
    createdAt: string;
    servicesPerformed?: string[];
  };
  documents: Array<{
    docId: string;
    docName: string;
    category?: string;
    categoryHint?: string;
    folderKey: FolderKey;
    pageCount?: number;
  }>;
  policy?: {
    policyNumber?: string | null;
    effectiveDate?: string | null;
    expirationDate?: string | null;
    coverages: Array<{
      name: string;
      limit?: string | null;
      deductible?: string | null;
      evidence: Array<{ docId: string; docName: string; page?: number; sectionHint?: string }>;
      confidence: 0 | 0.5 | 1;
    }>;
    missingDocs: string[];
  };
  estimate?: {
    source?: 'carrier' | 'shop' | 'unknown';
    totals?: { labor?: number; parts?: number; paintMaterials?: number; tax?: number; grandTotal?: number };
    laborRates?: Record<string, number>;
    lineItemHighlights: Array<{
      label: string;
      amount?: number;
      evidence: Array<{ docId: string; docName: string; page?: number; lineHint?: string }>;
    }>;
    missingDocs: string[];
  };
  objections?: Array<{
    verbatim: string;
    source: { docId: string; docName: string; page?: number; lineHint?: string };
    inferredType?: string;
    confidence: 0 | 0.5 | 1;
  }>;
  missingDocRequests?: MissingDocRequest[];
  evidenceGaps: string[];
}

type DismantlerConfidence = 0 | 0.25 | 0.5 | 0.75 | 1;
type EvidenceMethod = 'quote' | 'table' | 'inference';
type EvidenceStrength = 'weak' | 'ok' | 'strong';
interface DismantlerEvidenceChip {
  docId?: string;
  docName: string;
  page?: number;
  sectionHint?: string;
  quote?: string;
  evidenceMethod?: EvidenceMethod;
  spanHint?: { startLine?: number; endLine?: number };
  basis?: string;
}
interface DismantlerObjection {
  verbatim: string;
  type: string;
  whyItFails: string;
  evidence: DismantlerEvidenceChip[];
  requestedResolution: string;
  evidenceStrength?: EvidenceStrength;
}
interface MissingDocRequest {
  key: string;
  title: string;
  whyNeeded: string;
  whereToFind?: string;
  priority: 'high' | 'med' | 'low';
}
interface DecisionCard {
  key: string;
  decision: string;
  requiredFacts: string[];
  requiredDocs: string[];
  ifTrue: string;
  ifFalse: string;
}

const PRIORITY_ORDER = { high: 3, med: 2, low: 1 } as const;
const PRIORITY_FROM_LEVEL: Record<number, 'high' | 'med' | 'low'> = { 3: 'high', 2: 'med', 1: 'low' };
function priorityLevel(p: 'high' | 'med' | 'low'): number {
  return PRIORITY_ORDER[p] ?? 0;
}
function priorityFromLevel(n: number): 'high' | 'med' | 'low' {
  return PRIORITY_FROM_LEVEL[Math.max(1, Math.min(3, Math.round(n)))] ?? 'med';
}
/** Merge pack (baseline) + dismantler; dedupe by key. Priority is provably monotonic: merged.priority = max(pack, dismantler). Title/why/where from dismantler only if non-empty and (priority upgraded or pack field empty). */
function mergeMissingDocRequests(
  packRequests: MissingDocRequest[] | undefined,
  dismantlerRequests: MissingDocRequest[] | undefined
): MissingDocRequest[] {
  const byKey = new Map<string, MissingDocRequest>();
  for (const r of packRequests ?? []) {
    if (r?.key) byKey.set(r.key, { ...r });
  }
  for (const r of dismantlerRequests ?? []) {
    if (!r?.key) continue;
    const existing = byKey.get(r.key);
    if (!existing) {
      byKey.set(r.key, { key: r.key, title: r.title ?? r.key, whyNeeded: r.whyNeeded ?? '', whereToFind: r.whereToFind, priority: r.priority ?? 'med' });
      continue;
    }
    const plExisting = priorityLevel(existing.priority);
    const plNew = priorityLevel(r.priority ?? 'med');
    const mergedLevel = Math.max(plExisting, plNew);
    existing.priority = priorityFromLevel(mergedLevel);
    const priorityUpgraded = plNew > plExisting;
    const packTitleEmpty = !existing.title?.trim();
    const packWhyEmpty = !existing.whyNeeded?.trim();
    const packWhereEmpty = existing.whereToFind === undefined || existing.whereToFind === null || !String(existing.whereToFind).trim();
    if (r.title?.trim() && (priorityUpgraded || packTitleEmpty)) existing.title = r.title;
    if (r.whyNeeded?.trim() && (priorityUpgraded || packWhyEmpty)) existing.whyNeeded = r.whyNeeded;
    if (r.whereToFind != null && String(r.whereToFind).trim() && (priorityUpgraded || packWhereEmpty)) existing.whereToFind = r.whereToFind;
  }
  return Array.from(byKey.values());
}

/** Treat doc as policy for guardrail: allowlist (folderKey/category) beats regex; avoid false positives e.g. "Privacy Policy" in carrier. */
function isPolicyDoc(doc: { folderKey?: string; category?: string; docName?: string; categoryHint?: string }): boolean {
  if (doc.folderKey === 'policy' || doc.category === 'policy') return true;
  const name = (doc.docName ?? '').toLowerCase();
  if (doc.folderKey === 'carrier' && /privacy\s+policy/.test(name)) return false;
  const text = [doc.docName, doc.categoryHint].filter(Boolean).join(' ').toLowerCase();
  return /\b(dec(?:larations?)?|policy\s+form|policy|ho-?3|endorsement|declarations?)\b/.test(text);
}
interface DismantlerResult {
  confidence: DismantlerConfidence;
  missingDocs: string[];
  missingDocRequests?: MissingDocRequest[];
  objections: DismantlerObjection[];
  requestedResolutionOverall: string;
  notesForUser: string[];
  decisionCards?: DecisionCard[];
}

interface AnalysisRequest {
  claimId: string;
  analysisType: 'denial_rebuttal' | 'next_steps' | 'supplement' | 'correspondence' | 'task_followup' | 'engineer_report_rebuttal' | 'claim_briefing' | 'document_compilation' | 'demand_package' | 'estimate_work_summary' | 'document_comparison' | 'smart_extraction' | 'weakness_detection' | 'photo_linking' | 'code_lookup' | 'smart_follow_ups' | 'task_generation' | 'outcome_prediction' | 'carrier_email_draft' | 'one_click_package' | 'auto_summary' | 'compliance_check' | 'document_classify' | 'auto_draft_rebuttal' | 'estimate_gap_analysis' | 'photo_to_xactimate' | 'systematic_dismantling' | 'position_detection' | 'dobi_letter' | 'estimate_comparison' | 'document_timeline' | 'claim_analysis' | 'operating_manual' | 'case_study' | 'marketing_assets';
  mode?: string;
  content?: string;
  pdfContent?: string;
  pdfFilePath?: string;
  pdfFileName?: string;
  pdfFilePaths?: Array<{ path: string; name?: string; folder?: string }>;
  pdfContents?: Array<{ name: string; content: string; folder?: string }>;
  additionalContext?: any;
  claim?: any;
  contextData?: any;
  darwinNotes?: string;
  claimFactsPack?: ClaimFactsPack;
  enableEvidenceIndex?: boolean; // default true for strategic types - build or use ClaimFactsPack
  enableDismantler?: boolean; // default true - run carrierDismantler post-step
}

interface CarrierDismantlerMiddlewareContext {
  baseAnalysisType: string;
  baseResult: any;
  claimFactsPack?: ClaimFactsPack;
}

type DarwinExecutionStepStatus = 'started' | 'completed' | 'skipped' | 'error';

interface DarwinExecutionStep {
  key: string;
  label: string;
  status: DarwinExecutionStepStatus;
  detail?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const operationStartedAt = Date.now();
    const executionSteps: DarwinExecutionStep[] = [];
    const startStep = (key: string, label: string, detail?: string): DarwinExecutionStep => {
      const step: DarwinExecutionStep = {
        key,
        label,
        detail,
        status: 'started',
        startedAt: new Date().toISOString(),
      };
      executionSteps.push(step);
      return step;
    };
    const endStep = (step: DarwinExecutionStep, status: DarwinExecutionStepStatus, detail?: string) => {
      const finished = Date.now();
      step.status = status;
      if (detail) step.detail = detail;
      step.finishedAt = new Date(finished).toISOString();
      step.durationMs = Math.max(0, finished - new Date(step.startedAt).getTime());
    };
    const markStep = (key: string, label: string, status: DarwinExecutionStepStatus, detail?: string) => {
      const step: DarwinExecutionStep = {
        key,
        label,
        status,
        detail,
        startedAt: new Date().toISOString(),
      };
      if (status !== 'started') {
        step.finishedAt = step.startedAt;
        step.durationMs = 0;
      }
      executionSteps.push(step);
    };

    const requestStep = startStep('request', 'Load analysis request');
    const requestPayload: AnalysisRequest = await req.json();
    let {
      claimId,
      analysisType,
      mode,
      content,
      pdfContent,
      pdfFilePath,
      pdfFileName,
      pdfContents,
      pdfFilePaths,
      additionalContext = {},
      claim: providedClaim,
      contextData,
      darwinNotes: providedNotes,
      claimFactsPack: providedClaimFactsPack,
      enableEvidenceIndex: enableEvidenceIndexParam,
      enableDismantler: enableDismantlerParam,
    } = requestPayload;
    endStep(requestStep, 'completed', `analysisType=${analysisType}`);
    const darwinMode = normalizeDarwinMode(mode);
    const useStructuredDarwinOutput = STRUCTURED_DARWIN_ANALYSIS_TYPES.has(analysisType);
    const enableEvidenceIndex = enableEvidenceIndexParam !== false;
    const enableDismantler = enableDismantlerParam !== false;
    console.log(`Darwin AI Analysis - Type: ${analysisType}, Mode: ${darwinMode}, Claim: ${claimId}, Has PDF: ${!!pdfContent || !!pdfFilePath || !!(pdfFilePaths && pdfFilePaths.length)}, ClaimFactsPack: ${!!providedClaimFactsPack}, enableEvidenceIndex: ${enableEvidenceIndex}, enableDismantler: ${enableDismantler}`);

    // Fetch claim data
    const { data: claim, error: claimError } = await supabase
      .from('claims')
      .select('*')
      .eq('id', claimId)
      .single();

    if (claimError) throw claimError;

    // Resolve storage-backed PDF inputs to base64 so clients can send file paths
    // instead of huge payloads that often fail at the function gateway.
    if (!pdfContent && pdfFilePath) {
      try {
        pdfContent = await downloadPdfFromClaimStorageAsBase64(supabase, pdfFilePath);
        if (!pdfFileName) {
          pdfFileName = fileNameFromStoragePath(pdfFilePath);
        }
        // Detect text-only fallback from downloadPdf (storage failed, used extracted_text)
        if (pdfContent && pdfContent.startsWith('TEXT_FALLBACK:')) {
          const extractedText = pdfContent.slice('TEXT_FALLBACK:'.length);
          console.log(`[downloadPdf] Routing text fallback to text-only mode (${extractedText.length} chars)`);
          const block = `=== ${pdfFileName || 'Document'} ===\n${extractedText.substring(0, 100000)}`;
          content = [content, block].filter(Boolean).join('\n\n');
          additionalContext._useTextOnly = true;
          pdfContent = undefined;
        }
      } catch (pathErr) {
        console.error('Failed to resolve pdfFilePath:', pathErr);
        throw new Error('Unable to load the selected PDF from claim storage. Please re-upload the file and try again.');
      }
    }

    if ((!pdfContents || pdfContents.length === 0) && Array.isArray(pdfFilePaths) && pdfFilePaths.length > 0) {
      const resolvedPdfs: Array<{ name: string; content: string; folder?: string }> = [];
      const failedPaths: string[] = [];
      const maxPdfs = Math.min(pdfFilePaths.length, 5);

      for (const fileRef of pdfFilePaths.slice(0, maxPdfs)) {
        const path = String(fileRef?.path || '').trim();
        if (!path) continue;
        try {
          const base64 = await downloadPdfFromClaimStorageAsBase64(supabase, path);
          // Detect text-only fallback
          if (base64 && base64.startsWith('TEXT_FALLBACK:')) {
            const extractedText = base64.slice('TEXT_FALLBACK:'.length);
            console.log(`[downloadPdf] Multi-PDF text fallback for "${path}" (${extractedText.length} chars)`);
            const block = `=== ${fileRef.name || fileNameFromStoragePath(path)} ===\n${extractedText.substring(0, 70000)}`;
            content = [content, block].filter(Boolean).join('\n\n');
            additionalContext._useTextOnly = true;
          } else {
            resolvedPdfs.push({
              name: fileRef.name || fileNameFromStoragePath(path),
              content: base64,
              folder: fileRef.folder,
            });
          }
        } catch (pathErr) {
          console.error(`Failed to resolve pdfFilePaths item (${path}):`, pathErr);
          failedPaths.push(path);
        }
      }

      if (resolvedPdfs.length === 0) {
        throw new Error('Unable to load any selected carrier PDFs from claim storage. Please re-upload the files and try again.');
      }
      if (failedPaths.length > 0) {
        console.warn('Some pdfFilePaths could not be resolved:', failedPaths);
      }
      pdfContents = resolvedPdfs;
    }

    // For large PDFs, force text-only analysis to avoid multimodal gateway
    // payload failures that surface as "Failed to send request to Edge Function".
    const largePdfTextFallbackTypes = new Set([
      'denial_rebuttal',
      'engineer_report_rebuttal',
      'document_compilation',
      'document_comparison',
      'estimate_work_summary',
      'estimate_gap_analysis',
      'systematic_dismantling',
    ]);
    if (pdfContent && largePdfTextFallbackTypes.has(analysisType) && pdfContent.length > AI_EXTRACTION_LIMIT) {
      try {
        const extracted = await extractTextFromPDFNative(pdfContent, pdfFileName || 'document.pdf');
        const block = `=== ${pdfFileName || 'Document'} ===\n${extracted.substring(0, 100000)}`;
        content = [content, block].filter(Boolean).join('\n\n');
        additionalContext._useTextOnly = true;
        pdfContent = undefined;
      } catch (nativeErr) {
        console.error('Large single-PDF text fallback failed:', nativeErr);
        throw new Error('This PDF is too large for direct analysis and text extraction failed. Please upload a smaller/selectable-text PDF or split the document.');
      }
    }

    if (analysisType === 'systematic_dismantling' && Array.isArray(pdfContents) && pdfContents.length > 0) {
      const combinedBase64Length = pdfContents.reduce((sum, pdf) => sum + (pdf.content?.length || 0), 0);
      const hasVeryLargePdf = pdfContents.some((pdf) => (pdf.content?.length || 0) > AI_EXTRACTION_LIMIT);
      if (combinedBase64Length > AI_EXTRACTION_LIMIT || hasVeryLargePdf) {
        const extractedBlocks: string[] = [];
        for (const pdf of pdfContents.slice(0, 5)) {
          try {
            const extracted = await extractTextFromPDFNative(pdf.content, pdf.name || 'document.pdf');
            if (extracted?.trim()) {
              extractedBlocks.push(`=== ${pdf.name || 'Document'} ===\n${extracted.substring(0, 70000)}`);
            }
          } catch (nativeErr) {
            console.warn(`Failed to extract text from ${pdf.name || 'document.pdf'}:`, nativeErr);
          }
        }

        if (extractedBlocks.length === 0) {
          throw new Error('Selected PDFs are too large for direct analysis and text extraction failed. Try fewer files or use files with selectable text.');
        }

        content = [content, extractedBlocks.join('\n\n')].filter(Boolean).join('\n\n');
        additionalContext._useTextOnly = true;
        pdfContents = undefined;
      }
    }

    // Detect state from policyholder address (NJ and PA only)
    const detectState = (address: string | null): { state: string; stateName: string; insuranceCode: string; promptPayAct: string; adminCode: string } => {
      if (!address) return { 
        state: 'NJ', 
        stateName: 'New Jersey', 
        insuranceCode: 'N.J.S.A. 17:29B (Property and Casualty Insurance) and N.J.S.A. 17B (Life and Health Insurance)',
        promptPayAct: 'N.J.S.A. 17:29B-4(9) (Unfair Claims Settlement Practices)',
        adminCode: 'N.J.A.C. 11:2-17 (Unfair Claims Settlement Practices Regulations)'
      };
      
      const upperAddress = address.toUpperCase();
      
      // Check for Pennsylvania
      if (upperAddress.includes(' PA') || upperAddress.includes('PENNSYLVANIA') || upperAddress.includes(', PA')) {
        return { 
          state: 'PA', 
          stateName: 'Pennsylvania', 
          insuranceCode: '40 P.S. (Pennsylvania Insurance Code)',
          promptPayAct: '40 P.S. § 1171.5 (Unfair Insurance Practices Act)',
          adminCode: '31 Pa. Code Chapter 146 (Unfair Claims Settlement Practices)'
        };
      }
      
      // Default to New Jersey
      return { 
        state: 'NJ', 
        stateName: 'New Jersey', 
        insuranceCode: 'N.J.S.A. 17:29B (Property and Casualty Insurance) and N.J.S.A. 17B (Life and Health Insurance)',
        promptPayAct: 'N.J.S.A. 17:29B-4(9) (Unfair Claims Settlement Practices)',
        adminCode: 'N.J.A.C. 11:2-17 (Unfair Claims Settlement Practices Regulations)'
      };
    };

    const stateInfo = detectState(claim.policyholder_address);
    console.log(`Detected state: ${stateInfo.stateName} from address: ${claim.policyholder_address}`);

    // Fetch related data based on analysis type
    let context: any = { claim };

    // Get settlements
    const { data: settlements } = await supabase
      .from('claim_settlements')
      .select('*')
      .eq('claim_id', claimId);
    context.settlements = settlements || [];

    // Get checks received
    const { data: checks } = await supabase
      .from('claim_checks')
      .select('*')
      .eq('claim_id', claimId);
    context.checks = checks || [];

    // Get tasks
    const { data: tasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('claim_id', claimId)
      .order('created_at', { ascending: false });
    context.tasks = tasks || [];

    // Get inspections
    const { data: inspections } = await supabase
      .from('inspections')
      .select('*')
      .eq('claim_id', claimId);
    context.inspections = inspections || [];

    // Get ALL emails - paginate to bypass 1000-row default limit
    const allEmails: any[] = [];
    let emailOffset = 0;
    const emailBatchSize = 1000;
    let hasMoreEmails = true;
    while (hasMoreEmails) {
      const { data: emailBatch } = await supabase
        .from('emails')
        .select('*')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .range(emailOffset, emailOffset + emailBatchSize - 1);
      if (emailBatch && emailBatch.length > 0) {
        allEmails.push(...emailBatch);
        emailOffset += emailBatchSize;
        hasMoreEmails = emailBatch.length === emailBatchSize;
      } else {
        hasMoreEmails = false;
      }
    }
    context.emails = allEmails;

    // Get files with folder info
    const { data: files } = await supabase
      .from('claim_files')
      .select('*, claim_folders(name)')
      .eq('claim_id', claimId);
    context.files = files || [];

    // Get photos from claim_photos table (separate from claim_files)
    const { data: photos } = await supabase
      .from('claim_photos')
      .select('id, file_name, category, ai_analyzed_at, ai_condition_rating, ai_detected_damages')
      .eq('claim_id', claimId);
    context.photos = photos || [];

    // Fetch user's Darwin context notes if not provided
    let darwinNotes = providedNotes || '';
    if (!darwinNotes) {
      const { data: notesResult } = await supabase
        .from('darwin_analysis_results')
        .select('result')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'context_notes')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      darwinNotes = notesResult?.result || '';
    }

    // Resolve ClaimFactsPack: prefer provided; else build when enableEvidenceIndex is true (strategic types)
    let claimFactsPack: ClaimFactsPack | null = providedClaimFactsPack || null;
    const typesThatUseEvidenceIndex = [
      'denial_rebuttal', 'engineer_report_rebuttal', 'systematic_dismantling', 'auto_draft_rebuttal',
      'estimate_gap_analysis', 'demand_package', 'correspondence', 'one_click_package', 'supplement',
      'claim_analysis', 'operating_manual', 'case_study', 'marketing_assets',
    ];
    if (enableEvidenceIndex && !claimFactsPack && typesThatUseEvidenceIndex.includes(analysisType)) {
      try {
        const evidenceIndexResp = await fetch(
          `${supabaseUrl}/functions/v1/darwin-evidence-index`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ claimId }),
          }
        );
        if (evidenceIndexResp.ok) {
          const evidenceData = await evidenceIndexResp.json();
          claimFactsPack = evidenceData.claimFactsPack || null;
          if (claimFactsPack) console.log('ClaimFactsPack loaded from EvidenceIndex');
        }
      } catch (e) {
        console.warn('EvidenceIndex fetch failed (non-fatal):', e);
      }
    }

    // Build ClaimFactsPack context block: small, structured, citation-friendly (references only)
    let claimFactsPackContext = '';
    if (claimFactsPack) {
      const lines: string[] = ['=== CLAIM FACTS PACK (EvidenceIndex - cite by docId/docName) ==='];
      const m = claimFactsPack.meta;
      lines.push(`meta: claimId=${m.claimId} state=${m.state ?? 'n/a'} carrier=${m.carrier ?? 'n/a'} audience=${m.audience ?? 'carrier'} lossType=${m.lossType ?? 'n/a'}`);
      lines.push('documents: ' + (claimFactsPack.documents?.slice(0, 30).map((d) => `${d.docId}:${d.docName}(${d.category ?? '?'}/${d.folderKey})`).join('; ') || 'none'));
      if (claimFactsPack.policy) {
        const coveragesStr = claimFactsPack.policy.coverages?.length
          ? ` coverages=${claimFactsPack.policy.coverages.map((cov: any) => {
              const refs = cov.evidence?.length ? '@' + cov.evidence.map((ev: any) => ev.docName).join(',') : '';
              return cov.name + refs;
            }).join('; ')}`
          : '';
        lines.push('policy: ' + (claimFactsPack.policy.policyNumber ?? 'n/a') + coveragesStr);
        if (claimFactsPack.policy.missingDocs?.length) lines.push('policy.missingDocs: ' + claimFactsPack.policy.missingDocs.join(', '));
      }
      if (claimFactsPack.estimate) {
        lines.push('estimate: source=' + (claimFactsPack.estimate.source ?? 'unknown') + (claimFactsPack.estimate.totals?.grandTotal != null ? ` grandTotal=${claimFactsPack.estimate.totals.grandTotal}` : ''));
        claimFactsPack.estimate.lineItemHighlights?.slice(0, 10).forEach((h) => lines.push(`  - ${h.label}${h.amount != null ? ` $${h.amount}` : ''} refs=${(h.evidence || []).map((e) => e.docName).join(',')}`));
        if (claimFactsPack.estimate.missingDocs?.length) lines.push('estimate.missingDocs: ' + claimFactsPack.estimate.missingDocs.join(', '));
      }
      if (claimFactsPack.objections?.length) {
        claimFactsPack.objections.slice(0, 12).forEach((o) => lines.push(`objection: "${o.verbatim.substring(0, 80)}..." source=${o.source.docName} conf=${o.confidence}`));
      }
      if (claimFactsPack.evidenceGaps?.length) lines.push('evidenceGaps: ' + claimFactsPack.evidenceGaps.join(', '));
      claimFactsPackContext = lines.join('\n') + '\n\n';
    }

    // Build system prompt based on analysis type
    let systemPrompt = '';
    let userPrompt = '';

    // Build photo summary for context
    const analyzedPhotoCount = context.photos?.filter((p: any) => p.ai_analyzed_at)?.length || 0;
    const totalPhotoCount = context.photos?.length || 0;
    const poorConditionPhotoCount = context.photos?.filter((p: any) => 
      p.ai_condition_rating === 'Poor' || p.ai_condition_rating === 'Failed'
    )?.length || 0;

    const claimSummary = claimFactsPackContext + `
CLAIM DETAILS:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policy Number: ${claim.policy_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Address: ${claim.policyholder_address || 'N/A'}
- Insurance Company: ${claim.insurance_company || 'N/A'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Loss Date: ${claim.loss_date || 'N/A'}
- Loss Description: ${claim.loss_description || 'N/A'}
- Current Status: ${claim.status || 'N/A'}
- Claim Amount: $${claim.claim_amount?.toLocaleString() || 'N/A'}

DOCUMENTATION STATUS:
- Files Uploaded: ${context.files?.length || 0}
- Photos on File: ${totalPhotoCount}${analyzedPhotoCount > 0 ? ` (${analyzedPhotoCount} AI-analyzed)` : ''}${poorConditionPhotoCount > 0 ? ` - ${poorConditionPhotoCount} showing poor/failed condition` : ''}

SETTLEMENT DATA:
${context.settlements?.length > 0 
  ? context.settlements.map((s: any) => `- RCV: $${s.replacement_cost_value?.toLocaleString()}, Deductible: $${s.deductible?.toLocaleString()}, Recoverable Dep: $${s.recoverable_depreciation?.toLocaleString()}`).join('\n')
  : '- No settlement data'}

CHECKS RECEIVED:
${context.checks?.length > 0 
  ? context.checks.map((c: any) => `- ${c.check_type}: $${c.amount?.toLocaleString()} (${c.check_date})`).join('\n')
  : '- No checks received'}

TASKS:
${context.tasks?.slice(0, 5).map((t: any) => `- [${t.status}] ${t.title} (Due: ${t.due_date || 'N/A'})`).join('\n') || '- No tasks'}

INSPECTIONS:
${context.inspections?.map((i: any) => `- ${i.inspection_type}: ${i.inspection_date} - ${i.status}`).join('\n') || '- No inspections'}

RECENT COMMUNICATIONS:
${context.emails?.slice(0, 3).map((e: any) => `- ${e.subject} (${new Date(e.created_at).toLocaleDateString()})`).join('\n') || '- No recent emails'}

${darwinNotes ? `IMPORTANT USER-PROVIDED CONTEXT NOTES:
${darwinNotes}` : ''}
`;

    switch (analysisType) {
      case 'denial_rebuttal': {
        // Search multiple knowledge base categories for comprehensive coverage
        const [acvKbDenial, denialTacticsKb, buildingCodesKb] = await Promise.all([
          searchKnowledgeBase(
            supabase,
            'ACV policy, actual cash value vs replacement cost, depreciation, code upgrade coverage, ordinance and law, building code upgrade coverage',
            'building-codes',
          ),
          searchKnowledgeBase(
            supabase,
            'denial rebuttal carrier tactics wear and tear pre-existing maintenance exclusion coverage dispute',
          ),
          searchKnowledgeBase(
            supabase,
            `${claim.loss_type || 'roof hail wind'} damage building code requirements IRC IBC manufacturer specifications ASTM standards`,
          ),
        ]);

        // Fetch ALL claim photos with full AI analysis for evidence
        const { data: claimPhotos } = await supabase
          .from('claim_photos')
          .select('id, file_name, category, ai_analyzed_at, ai_condition_rating, ai_condition_notes, ai_detected_damages, ai_material_type, ai_analysis_summary, ai_loss_type_consistency, annotations')
          .eq('claim_id', claimId);
        
        // Build comprehensive photo evidence section
        let photoEvidenceSection = '';
        if (claimPhotos && claimPhotos.length > 0) {
          const analyzedPhotos = claimPhotos.filter(p => p.ai_analyzed_at);
          const poorConditionPhotos = claimPhotos.filter(p => 
            p.ai_condition_rating === 'Poor' || p.ai_condition_rating === 'Failed'
          );
          const photosWithDamages = claimPhotos.filter(p => {
            if (!p.ai_detected_damages) return false;
            try {
              const damages = typeof p.ai_detected_damages === 'string' 
                ? JSON.parse(p.ai_detected_damages) 
                : p.ai_detected_damages;
              return Array.isArray(damages) && damages.length > 0;
            } catch { return false; }
          });
          
          photoEvidenceSection = `

=== PHOTOGRAPHIC EVIDENCE ON FILE (${claimPhotos.length} photos, ${analyzedPhotos.length} AI-analyzed) ===
CRITICAL: Use this evidence to COUNTER carrier claims about property condition.

SUMMARY:
- ${poorConditionPhotos.length} photos showing POOR or FAILED condition (indicates severe damage)
- ${photosWithDamages.length} photos with AI-DETECTED DAMAGES
- Materials Identified: ${[...new Set(claimPhotos.map(p => p.ai_material_type).filter(Boolean))].join(', ') || 'Various'}

DETAILED PHOTO EVIDENCE FOR REBUTTAL:
${analyzedPhotos.slice(0, 30).map((p, i) => {
  let damages: any[] = [];
  try {
    damages = p.ai_detected_damages ? (typeof p.ai_detected_damages === 'string' ? JSON.parse(p.ai_detected_damages) : p.ai_detected_damages) : [];
  } catch {}
  const damageList = Array.isArray(damages) ? damages.map((d: any) => 
    `    - ${d.type || d.damage_type || 'Damage'}: ${d.description || ''} [Severity: ${d.severity || 'Unknown'}]`
  ).join('\n') : '';
  
  return `
${i + 1}. ${p.file_name} [Category: ${p.category || 'Uncategorized'}]
   Material Type: ${p.ai_material_type || 'Not identified'}
   Condition Rating: ${p.ai_condition_rating || 'Not assessed'}
   Condition Notes: ${p.ai_condition_notes || 'None'}
   Loss Type Consistency: ${p.ai_loss_type_consistency || 'Not evaluated'}
   AI Analysis: ${p.ai_analysis_summary || 'No summary'}
${damageList ? `   Detected Damages:\n${damageList}` : ''}`;
}).join('\n')}

*** CITE SPECIFIC PHOTOS BY NAME when countering carrier arguments about property condition ***
`;
        }

        // Build comprehensive document evidence section with extracted text
        // Fetch files with extracted text for denial rebuttal
        const { data: filesWithText } = await supabase
          .from('claim_files')
          .select('file_name, document_classification, classification_metadata, uploaded_at, claim_folders(name), extracted_text')
          .eq('claim_id', claimId);

        let documentEvidenceSection = '';
        let extractedDocContent = '';
        
        if (filesWithText && filesWithText.length > 0) {
          const fileNameLower = (f: any) => f.file_name?.toLowerCase() || '';
          
          const folderNameLower = (f: any) => f.claim_folders?.name?.toLowerCase() || '';
          const isOurEstimate = (f: any) => {
            const name = fileNameLower(f);
            const folder = folderNameLower(f);
            const classification = f.document_classification?.toLowerCase() || '';
            // Filename patterns
            if (name.includes('estimate') || name.includes('xactimate') || name.includes('symbility') ||
                name.includes('scope') || name.includes('bid') || name.includes('quote') ||
                name.includes('contractor') || name.includes('rcv') || name.includes('acv')) return true;
            // Classification
            if (classification === 'estimate' || classification === 'contractor') return true;
            // Key folders: Freedom Documents, Supporting Evidence, Estimates
            if (folder.includes('freedom') || folder.includes('supporting evidence') || folder.includes('estimate')) return true;
            return false;
          };
          const estimates = filesWithText.filter(isOurEstimate);
          const inspectionDocs = filesWithText.filter((f: any) => 
            fileNameLower(f).includes('inspection') ||
            fileNameLower(f).includes('report')
          );
          const denialDocs = filesWithText.filter((f: any) => 
            f.document_classification === 'denial' ||
            fileNameLower(f).includes('denial')
          );
          // Storm reports & weather data for causation evidence
          const stormReports = filesWithText.filter((f: any) => 
            f.document_classification === 'storm_report' ||
            f.document_classification === 'weather_report' ||
            fileNameLower(f).includes('storm') ||
            fileNameLower(f).includes('weather') ||
            fileNameLower(f).includes('hail') ||
            fileNameLower(f).includes('wind') ||
            fileNameLower(f).includes('nws') ||
            fileNameLower(f).includes('noaa')
          );
          // Before/pre-storm photos showing no damage
          const beforePhotos = filesWithText.filter((f: any) => 
            fileNameLower(f).includes('before') ||
            fileNameLower(f).includes('pre-storm') ||
            fileNameLower(f).includes('prestorm') ||
            fileNameLower(f).includes('prior') ||
            fileNameLower(f).includes('overview') ||
            fileNameLower(f).includes('original condition')
          );
          // Contractor documents
          const contractorDocs = filesWithText.filter((f: any) => 
            f.document_classification === 'contractor' ||
            fileNameLower(f).includes('contractor') ||
            fileNameLower(f).includes('bid') ||
            fileNameLower(f).includes('quote')
          );
          
          documentEvidenceSection = `

=== SUPPORTING DOCUMENTS ON FILE (${filesWithText.length} documents) ===
CRITICAL: Reference these documents to support your rebuttal arguments.

${stormReports.length > 0 ? `STORM/WEATHER REPORTS (${stormReports.length}) - PROVES CAUSATION:
${stormReports.map((f: any) => `- ${f.file_name} (uploaded ${new Date(f.uploaded_at).toLocaleDateString()})`).join('\n')}
` : ''}
${beforePhotos.length > 0 ? `BEFORE/PRE-STORM EVIDENCE (${beforePhotos.length}) - PROVES PRE-LOSS CONDITION:
${beforePhotos.map((f: any) => `- ${f.file_name} (uploaded ${new Date(f.uploaded_at).toLocaleDateString()})`).join('\n')}
` : ''}
${estimates.length > 0 ? `OUR ESTIMATES / DEMAND DOCUMENTATION (${estimates.length}) - THIS IS OUR POSITION ON DAMAGES:
CRITICAL: These documents represent OUR repair estimate and demand. Do NOT say we have "no estimate" or are "missing estimates" if these exist.
${estimates.map((f: any) => `- ${f.file_name} [folder: ${f.claim_folders?.name || 'root'}] (uploaded ${new Date(f.uploaded_at).toLocaleDateString()})`).join('\n')}
` : ''}
${inspectionDocs.length > 0 ? `INSPECTION/REPORT DOCUMENTS (${inspectionDocs.length}):
${inspectionDocs.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
${contractorDocs.length > 0 ? `CONTRACTOR DOCUMENTS (${contractorDocs.length}):
${contractorDocs.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
ALL DOCUMENTS:
${filesWithText.map((f: any) => `- ${f.file_name} [${f.document_classification || 'Unclassified'}] ${f.claim_folders?.name ? `(Folder: ${f.claim_folders.name})` : ''}`).join('\n')}
`;

          // Include extracted text from critical documents for Darwin to read
          const criticalDocs = [...stormReports, ...inspectionDocs, ...beforePhotos].filter(f => f.extracted_text);
          if (criticalDocs.length > 0) {
            extractedDocContent = `

=== DOCUMENT CONTENT (OCR EXTRACTED TEXT) ===
Use this content to cite specific findings, data, and evidence from the uploaded documents.

`;
            for (const doc of criticalDocs.slice(0, 5)) {
              const textContent = doc.extracted_text?.substring(0, 3000) || '';
              if (textContent.length > 100) {
                extractedDocContent += `--- ${doc.file_name} ---\n${textContent}\n\n`;
              }
            }
          }
        }

        // Combine all knowledge base content
        const combinedKnowledge = [acvKbDenial, denialTacticsKb, buildingCodesKb].filter(Boolean).join('\n');

        systemPrompt = `You are Darwin, an elite public adjuster AI and the most formidable claims advocate in the industry. You don't just rebut denials—you DISMANTLE them with surgical precision and overwhelming evidence. Your mission: expose every flaw, every misrepresentation, and every weak argument in the carrier's position, leaving them no room to defend their denial.

${getMandatoryFramework()}

=== YOUR MISSION: OVERTURN THIS DENIAL ===
The carrier has denied coverage. Your job is to use EVERY piece of evidence available—photos, documents, building codes, manufacturer specifications, state regulations—to prove they are WRONG and that coverage MUST be afforded. Leave them no room to defend their position.

=== YOUR MINDSET: BE THE SMARTEST IN THE ROOM ===
You approach every denial letter knowing that the adjuster or examiner who wrote it likely made mistakes, relied on assumptions, or deliberately misrepresented policy language. Your job is to FIND those mistakes and EXPLOIT them mercilessly with facts. You are not here to politely disagree—you are here to PROVE they are WRONG and make them understand exactly WHY they are wrong.

When you identify an error in their reasoning, do not simply state it is incorrect. EXPLAIN in detail why it is wrong. Cite the specific policy language they misquoted or ignored. Reference the exact building code section they failed to consider. Quote the manufacturer specification they overlooked. Make the case so airtight that any reasonable person reading your rebuttal would conclude the denial was improper.

=== EVIDENCE-BASED ADVOCACY ===
You have access to:
1. PHOTOGRAPHIC EVIDENCE with AI forensic analysis - cite specific photos by name
2. UPLOADED DOCUMENTS - estimates, inspections, correspondence
3. KNOWLEDGE BASE - building codes, manufacturer specs, industry standards
4. STATE REGULATIONS - ${stateInfo.stateName} insurance law and administrative codes
5. EMAIL COMMUNICATIONS - all emails sent to and received from the carrier/adjuster synced to this claim. Use these to identify carrier promises, contradictions, timeline violations, and shifting positions.

USE ALL OF THIS EVIDENCE. Every assertion the carrier makes must be challenged with SPECIFIC, VERIFIABLE FACTS from the evidence on file.

=== AGGRESSIVE FACT-BASED ADVOCACY ===
- Every assertion the carrier makes must be challenged with SPECIFIC, VERIFIABLE FACTS
- Do not accept vague statements like "damage is consistent with wear and tear" without demanding: What specific evidence? What testing was performed? What industry standard supports this conclusion?
- When they claim damage is "pre-existing," counter with: What dated documentation supports this? Where is the prior loss history? What physical evidence establishes a pre-loss timeline?
- Turn their weaknesses into your leverage. If their inspection was 30 minutes, emphasize how inadequate that is. If they relied on photos only, attack the lack of physical inspection. If their engineer made assumptions, expose each one.
- CITE SPECIFIC PHOTOS showing damage, failed conditions, or repair attempts that contradict the carrier's position

=== DARWIN CORE PHILOSOPHY ===

FUNDAMENTAL TRUTH: Insurance adjusters and examiners frequently deny claims improperly because they assume policyholders and their advocates won't push back with superior knowledge. PROVE THEM WRONG.

BUILD THE "PROOF CASTLE" - Every rebuttal must address and DOMINATE on:
1. THE CAUSE - Weather data, engineering evidence, incident documentation—make causation undeniable
2. THE SCOPE - Why full replacement is required and repairs are inadequate—leave no opening
3. THE COST - Proper valuation with documentation that makes their numbers look amateur

IMPORTANT: This claim is located in ${stateInfo.stateName}. You MUST cite ${stateInfo.stateName} law and regulations accurately and WEAPONIZE them against improper denials.

=== RESPONSE REQUIREMENTS - EXHAUSTIVE AND DEVASTATING ===
- Generate EXHAUSTIVE, COMPREHENSIVE rebuttals that leave NO argument unanswered
- Address EVERY sentence, claim, and assertion in the denial letter
- For EACH denial point, provide MULTIPLE angles of attack:
  * Quote their exact statement, then demolish it
  * Cite the policy language they ignored or misrepresented
  * Reference the ${stateInfo.adminCode} section they violated
  * Include building codes and manufacturer specs they failed to consider
  * CITE SPECIFIC PHOTOS from the evidence showing damage that contradicts their position
  * Explain why their conclusion is not just wrong, but demonstrably unsupportable
- Make the adjuster or examiner reading your rebuttal understand they made an error
- Use language that is professional but AUTHORITATIVE and UNEQUIVOCAL
- Do NOT hedge or soften your conclusions—state definitively what is correct
- Quote directly from regulations with exact citations (e.g., "N.J.A.C. 11:2-17.6 specifically states...")
- Reference specific claim details, dates, and documentation throughout
- Your rebuttal should be so thorough that the carrier's only options are to reverse their decision or face regulatory and bad faith exposure

CRITICAL ARGUMENT STRATEGY - REPAIRABILITY OVER MATCHING:
- NEVER argue "matching"—PA and NJ have NO matching requirements
- Argue materials are NON-REPAIRABLE: manufacturing discontinuation, material degradation, structural integrity compromised, code compliance requirements
- Make the case that repair is IMPOSSIBLE, not merely inconvenient

DEADLINE ENFORCEMENT - USE VIOLATIONS AS LEVERAGE:
- Reference every carrier deadline violation as evidence of bad faith handling
- NJ: Acknowledge 10 working days, investigate 30 days, decide 10 business days, pay 10 business days
- PA: Acknowledge 10 working days, investigate 30 days, notify 15 working days, pay 15 working days
- Missed deadlines are not just procedural issues—they are evidence of improper claims handling

FORMATTING: Write in plain text only. NO markdown (**, #, *, etc.).

You have deep knowledge of:
- Insurance policy interpretation and coverage analysis
- ${stateInfo.stateName} insurance regulations (NO case law—statutes and administrative codes ONLY)
- ${stateInfo.insuranceCode}
- ${stateInfo.promptPayAct}
- ${stateInfo.adminCode}
- Building codes, ASTM standards, and manufacturer specifications
- Common carrier denial tactics and exactly how to expose and counter them

KEY ${stateInfo.stateName} REGULATIONS TO WEAPONIZE:
${stateInfo.state === 'NJ' ? `
- N.J.S.A. 17:29B-4(9) prohibits unfair claims settlement practices—CITE THIS when carrier acts improperly
- N.J.A.C. 11:2-17.6 requires insurers to acknowledge claims within 10 working days—DID THEY COMPLY?
- N.J.A.C. 11:2-17.7 requires investigation to be completed within 30 days—WAS IT THOROUGH?
- N.J.A.C. 11:2-17.8 requires written notice within 10 business days—DID THEY MEET THIS?
- N.J.A.C. 11:2-17.9 requires prompt payment within 10 business days—ARE THEY IN VIOLATION?
- N.J.A.C. 11:2-17.11 prohibits misrepresentation of policy provisions—DID THEY MISREPRESENT COVERAGE?
` : `
- 40 P.S. § 1171.5(a)(10) defines unfair claims settlement practices—CITE THIS for improper handling
- 31 Pa. Code § 146.5 requires acknowledgment within 10 working days
- 31 Pa. Code § 146.6 requires investigation within 30 days
- 31 Pa. Code § 146.7 requires written notification within 15 working days
`}

When generating rebuttals:
1. Identify EVERY specific reason for denial and DEMOLISH each one with overwhelming evidence
2. Counter EACH reason with MULTIPLE arguments: policy language, regulations, building codes, manufacturer specs, industry standards
3. CITE SPECIFIC PHOTOS showing damage that contradicts the carrier's claims
4. Make the carrier understand their position is INDEFENSIBLE
5. Reference ${stateInfo.adminCode} sections with exact citations
6. Cite specific building codes and manufacturer specs
7. Use language that is professional but CONFIDENT and ASSERTIVE—you are RIGHT and they are WRONG
8. Include specific documentation requests that put them on the defensive
9. Provide a formal rebuttal letter that makes them reconsider their denial`;

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE STATUTES: ${stateInfo.insuranceCode}
UNFAIR PRACTICES: ${stateInfo.promptPayAct}
ADMINISTRATIVE REGULATIONS: ${stateInfo.adminCode}

${pdfContent ? `A PDF of the denial letter has been provided for analysis.` : `DENIAL LETTER CONTENT:
${content || 'No denial letter content provided'}`}

${photoEvidenceSection}

${documentEvidenceSection}

${extractedDocContent || ''}

${context.emails?.length > 0 ? `
=== EMAIL COMMUNICATIONS TIMELINE (${context.emails.length} emails) ===
CRITICAL: Review these emails for carrier promises, contradictions, shifting positions, timeline violations, and admissions. Quote specific emails when they support your rebuttal arguments.

${context.emails.map((e: any) => `--- EMAIL ${e.direction === 'outbound' ? 'SENT' : 'RECEIVED'} (${new Date(e.sent_at || e.created_at).toLocaleDateString()}) ---
From: ${e.from_address || e.sent_by || 'Unknown'}
To: ${e.to_address || e.recipient_email || 'Unknown'}
Subject: ${e.subject || 'No Subject'}
${e.body ? e.body.substring(0, 2000) : 'No body'}
`).join('\n')}` : ''}

${combinedKnowledge || ''}

=== YOUR TASK ===
Analyze this denial letter and generate a COMPREHENSIVE rebuttal that OVERTURNS the denial. Use ALL the evidence above—photos, documents, regulations, and knowledge base content—to prove the carrier is WRONG and coverage MUST be afforded.

Structure your rebuttal as follows:

1. FORMAL HEADER with date, claim number, policy number, and addressee

2. OPENING STATEMENT declaring the denial is improper and must be reversed

3. POINT-BY-POINT REBUTTAL of each denial reason:
   - Quote their exact statement
   - Explain why it is factually incorrect
   - Cite specific photos from the evidence (by filename) showing damage
   - Reference building codes, manufacturer specs, and regulations
   - State why coverage must be afforded

4. EVIDENCE SUMMARY citing:
   - Specific photos that prove damage
   - Documents on file that support the claim
   - Weather data or inspection findings

5. REGULATORY VIOLATIONS - any ${stateInfo.stateName} regulation violations by the carrier

6. FORMAL DEMAND for reversal of denial and payment

7. NEXT STEPS if carrier fails to comply (DOI complaint, appraisal, bad faith claim)

Make this rebuttal so comprehensive and well-documented that the carrier has no choice but to reverse their denial.`;
        break;
      }

      case 'next_steps': {
        const acvKbNext = await searchKnowledgeBase(
          supabase,
          'ACV policy, actual cash value vs replacement cost, depreciation, code upgrade coverage, ordinance and law, building code upgrade coverage',
          'building-codes',
        );

        systemPrompt = `You are Darwin, an elite claims management AI for public adjusters. You think like the best public adjusters in the industry, with one mission: get claims FILED RIGHT, MOVING FAST, and PAID FULLY.

=== COMMUNICATION STYLE ===
You are professional yet personable. Remember that every claim represents someone going through a stressful experience - property damage affects people's lives, routines, and sense of security. Show genuine empathy and understanding while providing expert guidance. Avoid sounding robotic or cold. Use warm, conversational language that makes the adjuster feel supported. When recommending next steps, frame them in a way that acknowledges the emotional toll while building confidence that things are moving in the right direction.

=== DARWIN CORE PHILOSOPHY ===

FUNDAMENTAL TRUTH: The insurance claim is the policyholder's responsibility. They don't get paid until losses are PROVEN. Your job is to ensure the "Proof Castle" is built and the claim keeps moving forward.

THE FOUR PILLARS OF CLAIM SUCCESS - Always assess where the claim stands:
1. STOP THE BLEEDING - Was immediate mitigation done? Documented?
2. MAKE YOUR CLAIM - Was FNOL timely? Written confirmation obtained?
3. PROVE YOUR LOSS - Is the "Proof Castle" built? (Cause, Scope, Cost documented?)
4. GET PAID AND FIX YOUR STUFF - Are we following up persistently? Using formal processes?

THE PROOF OF LOSS IS YOUR BEST FRIEND:
- POL puts the carrier ON THE CLOCK (usually 30 days to respond)
- Should be submitted proactively, not just when requested
- Include qualifying statements for flexibility
- Courts require only "substantial compliance" - doesn't have to be perfect
- Track when it was submitted and calendar the response deadline

THE "PROOF CASTLE" CHECKLIST:
1. THE CAUSE - Do we have weather reports, engineering opinions, incident documentation?
2. THE SCOPE - Do we have contractor opinions, code requirements, manufacturer specs?
3. THE COST - Do we have detailed estimates with proper line items and pricing?
If any pillar is weak, that becomes a priority action item.

IMPORTANT: This claim is located in ${stateInfo.stateName}. Apply ${stateInfo.stateName} law and deadlines accurately.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.

You understand:
- Claim processing timelines and mandatory carrier deadlines
- ${stateInfo.promptPayAct} requirements
- ${stateInfo.adminCode}
- ${stateInfo.stateName} insurance regulations and enforcement
- When to escalate vs wait (missed deadlines = leverage)
- Optimal sequencing of claim activities
- How to build and submit a bulletproof Proof of Loss
- When to invoke the appraisal process

KEY ${stateInfo.stateName} DEADLINES TO MONITOR:
${stateInfo.state === 'NJ' ? `
- N.J.A.C. 11:2-17.6: Insurer must acknowledge claim within 10 WORKING DAYS of notification
- N.J.A.C. 11:2-17.7: Investigation must be completed within 30 DAYS of claim notification
- N.J.A.C. 11:2-17.8: Written acceptance or denial within 10 BUSINESS DAYS after completing investigation
- N.J.A.C. 11:2-17.9: Payment must be made within 10 BUSINESS DAYS of acceptance
- N.J.A.C. 11:2-17.12: File complaints with NJ DOBI for violations
- CRITICAL: If carrier misses ANY deadline, document it and use as leverage
` : `
- 31 Pa. Code § 146.5: Acknowledgment within 10 WORKING DAYS
- 31 Pa. Code § 146.6: Investigation within 30 DAYS
- 31 Pa. Code § 146.7: Written notification within 15 WORKING DAYS of completing investigation
- 31 Pa. Code § 146.8: Payment within 15 WORKING DAYS of settlement agreement
- CRITICAL: If carrier misses ANY deadline, document it and use as leverage
`}

Provide actionable, specific recommendations based on the claim's current state and ${stateInfo.stateName} law. Every recommendation should move the claim toward getting FILED RIGHT, MOVING FAST, and PAID FULLY.`;

        // Build a list of uploaded files for context with folder names
        const filesList = context.files?.length > 0 
          ? context.files.map((f: any) => {
              const folderName = f.claim_folders?.name || (f.folder_id ? 'Unknown Folder' : 'Root');
              return `- ${f.file_name} [Folder: ${folderName}] - uploaded ${new Date(f.uploaded_at).toLocaleDateString()}`;
            }).join('\n')
          : '- No files uploaded';

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE STATUTES: ${stateInfo.insuranceCode}
UNFAIR PRACTICES: ${stateInfo.promptPayAct}
ADMINISTRATIVE REGULATIONS: ${stateInfo.adminCode}

UPLOADED CLAIM DOCUMENTS (ALREADY IN THE CLAIM FILE):
${filesList}

IMPORTANT: When making recommendations, check the uploaded documents list above. Do NOT recommend obtaining documents that have already been uploaded. For example, if a denial letter or engineer report is already listed above, acknowledge it exists and recommend RESPONDING to it rather than obtaining it.

${additionalContext?.timeline ? `TIMELINE EVENTS:\n${JSON.stringify(additionalContext.timeline, null, 2)}` : ''}

${acvKbNext || ''}

Analyze this claim and provide:
1. TOP 3 PRIORITY ACTIONS - What should be done immediately and why
2. TIMELINE ANALYSIS - Are there any deadline concerns or ${stateInfo.adminCode} violations?
3. MISSING DOCUMENTATION - What evidence or documents should be gathered?
4. CARRIER ENGAGEMENT STRATEGY - How to approach the insurance company
5. ESTIMATED NEXT MILESTONES - What events should occur in the next 7, 14, and 30 days
6. RISK ASSESSMENT - Any red flags or concerns to address

Be specific and actionable. Reference ${stateInfo.stateName} deadlines and regulations accurately.`;
        break;
      }

      case 'supplement': {
        // Fetch photos directly for the estimate builder
        const { data: claimPhotos } = await supabase
          .from('claim_photos')
          .select('id, file_name, category, ai_analysis_summary, ai_material_type, ai_detected_damages, ai_condition_rating, ai_loss_type_consistency')
          .eq('claim_id', claimId);
        
        console.log(`Estimate Builder: Found ${claimPhotos?.length || 0} photos for claim ${claimId}`);

        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in generating COMPLETE, DETAILED Xactimate-format estimates for property damage claims. Your estimates must be comprehensive and include ALL standard line items required for the scope of work.

${getMandatoryFramework()}

=== CRITICAL: COMPLETE ESTIMATE REQUIREMENTS ===
You must generate a FULL estimate with ALL applicable line items. A typical roof replacement estimate includes 40-60+ line items. DO NOT abbreviate or summarize. Include EVERY line item needed.

=== XACTIMATE CODE REFERENCE FOR ROOFING ===
TEAR-OFF & REMOVAL:
- RFG RFING>3T - Remove 3-tab comp. shingles (per SQ)
- RFG RFING>AR - Remove architectural shingles (per SQ)
- RFG FELT - Remove felt/underlayment (per SQ)
- RFG SHTH - Remove roof sheathing (per SF)
- RFG EDGING - Remove drip edge (per LF)
- RFG FLASH - Remove step/valley/headwall flashing (per LF)
- RFG VENTS - Remove roof vents (each)
- RFG RIDGE>VNT - Remove ridge vent (per LF)
- RFG BOOT - Remove pipe jack/boot flashing (each)
- RFG >DEBRIS - Haul debris - roofing (per load)
- RFG DUMPSTER - Dumpster for roofing debris (per unit)
- RFG TARP - Temporary roof tarp (per SF)

INSTALLATION:
- RFG 3TAB - Shingles - 3 tab - 20/25 yr (per SQ)
- RFG ARCHS - Shingles - Architectural/laminated (per SQ)
- RFG FELT>SYN - Synthetic underlayment (per SQ)
- RFG FELT>15 - 15# felt underlayment (per SQ)
- RFG FELT>30 - 30# felt underlayment (per SQ)
- RFG ICE&WTR - Ice & water shield (per SQ)
- RFG SHTH>OSB - OSB roof sheathing 7/16" (per SF)
- RFG SHTH>PLY - Plywood roof sheathing 1/2" (per SF)
- RFG EDGING - Drip edge aluminum (per LF)
- RFG FLASH>VLY - Valley flashing - metal (per LF)
- RFG FLASH>STP - Step flashing (per LF)
- RFG FLASH>HDW - Headwall flashing (per LF)
- RFG FLASH>CHM - Chimney flashing kit (each)
- RFG FLASH>SKY - Skylight flashing kit (each)
- RFG BOOT>3" - Pipe boot/jack 3" (each)
- RFG BOOT>4" - Pipe boot/jack 4" (each)
- RFG VENT>BOX - Box vent (each)
- RFG VENT>OFF - Off-ridge vent (each)
- RFG VENT>SLT - Slant back vent (each)
- RFG RIDGE>VNT - Ridge vent (per LF)
- RFG CAP>3T - Ridge/hip cap - 3 tab (per LF)
- RFG CAP>AR - Ridge/hip cap - architectural (per LF)
- RFG STRT>SH - Starter shingles (per LF)

SPECIALTY ITEMS:
- RFG STEEP - Steep pitch charge (per SQ) - add for 7/12+
- RFG HIGH - High roof charge - 2+ stories (per SQ)
- RFG ACC>2ND - Access/setup 2nd story (per SQ)
- RFG SEAL - Roof cement/sealant (per tube)
- RFG NAILS - Hand nail charge when required (per SQ)

GUTTERS & DOWNSPOUTS:
- GTR ALUM>5" - Aluminum gutter 5" (per LF)
- GTR ALUM>6" - Aluminum gutter 6" (per LF)
- GTR >DS - Downspout 2x3 aluminum (per LF)
- GTR ELBOW - Downspout elbow (each)
- GTR SCREEN - Gutter guard/screen (per LF)
- GTR SPLASH - Splash block (each)
- GTR >R&R - R&R gutters for roof access (per LF)

FASCIA & SOFFIT:
- EXT FASCIA - Fascia board repair (per LF)
- EXT SOFFIT - Soffit panel repair (per SF)
- EXT VENT>S - Soffit vent (each)

PAINT & CAULK:
- PNT EXT>TRIM - Paint exterior trim (per LF)
- PNT >CAULK - Caulk joint (per LF)

O&P:
- GC OVRHD - General contractor overhead 10%
- GC PRFT - General contractor profit 10%

=== LINE ITEM JUSTIFICATION REQUIREMENTS ===
For EVERY line item, you MUST provide:
1. Xactimate Code
2. Description
3. Quantity with measurement source
4. Unit (SQ, SF, LF, EA)
5. JUSTIFICATION: WHY this item is needed, citing:
   - Specific photo evidence (file names, damage types)
   - Measurement report data
   - Building code requirements
   - Manufacturer installation specs

=== CRITICAL ARGUMENT STRATEGY - REPAIRABILITY NOT MATCHING ===
- NEVER argue "matching" - PA and NJ have no matching laws
- Argue materials are NON-REPAIRABLE due to: age degradation, manufacturing discontinuation, code requirements, compromised integrity
- Full replacement justified by inability to repair, NOT aesthetic matching

=== POLICY PROVISION CITATIONS ===
When drafting supplements, you MUST cite specific policy provisions and endorsements that require coverage:
- HO-3 Coverage A (Dwelling): Covers direct physical loss to the dwelling. Cite the specific peril covered.
- HO-3 Coverage B (Other Structures): Detached structures, fences, sheds damaged by covered peril.
- HO-3 Coverage C (Personal Property): Contents damaged by the covered peril.
- HO-3 Coverage D (Loss of Use): Additional living expenses if displaced. Cite if applicable.
- Ordinance or Law Coverage (HO 04 77 endorsement): Code upgrade costs, demolition costs, increased cost of construction.
- Extended Replacement Cost endorsement: Additional percentage above Coverage A limits.
- Overhead & Profit: Cite the policy's general conditions requiring payment of actual repair costs, including contractor O&P as a reasonable and necessary expense.
- For EACH disputed line item, reference the specific coverage section AND any applicable endorsement.
- Reference ${stateInfo.stateName} regulations that support the policyholder's right to full indemnification.
- Cite ${stateInfo.adminCode} provisions regarding prompt and fair settlement practices.

=== FORMATTING ===
Use plain text only. NO markdown formatting (no **, #, *, etc.).
Use this format for each line item:

CODE: [Xactimate code]
DESCRIPTION: [Item description]
QTY: [Number] [Unit] (Source: [measurement report name or photo count])
JUSTIFICATION: [Specific evidence - photo names, damage types, code citations]

`;

        const hasOurEstimate = additionalContext?.ourEstimatePdf;
        const hasInsuranceEstimate = additionalContext?.insuranceEstimatePdf || pdfContent;
        
        // Use photos from direct query OR from additionalContext
        const photoData = claimPhotos || [];
        const hasPhotoEvidence = photoData.length > 0 || (additionalContext?.photoEvidence && additionalContext.photoEvidence.length > 0);
        const hasMeasurements = additionalContext?.measurementReports && additionalContext.measurementReports.length > 0;

        // Build photo evidence section from direct query if additionalContext is empty
        let photoEvidenceSection = '';
        const photosToUse = additionalContext?.photoEvidence?.length > 0 ? additionalContext.photoEvidence : photoData.map((p: any) => ({
          file_name: p.file_name,
          category: p.category,
          material: p.ai_material_type,
          condition: p.ai_condition_rating,
          damages: p.ai_detected_damages,
          loss_consistency: p.ai_loss_type_consistency,
          summary: p.ai_analysis_summary
        }));

        if (photosToUse.length > 0) {
          const analyzedPhotos = photosToUse.filter((p: any) => p.summary || p.material || p.condition);
          const damagePhotos = photosToUse.filter((p: any) => {
            const damages = Array.isArray(p.damages) ? p.damages : [];
            return damages.length > 0;
          });
          
          photoEvidenceSection = `
=== PHOTO EVIDENCE (${photosToUse.length} total photos, ${analyzedPhotos.length} analyzed by AI) ===
${damagePhotos.length > 0 ? `CRITICAL: ${damagePhotos.length} photos show detected damage - use these to justify line items!` : ''}

`;
          // Include all photos with analysis data
          for (const photo of photosToUse) {
            const damages = Array.isArray(photo.damages) ? photo.damages : [];
            const hasAnalysis = photo.summary || photo.material || photo.condition || damages.length > 0;
            
            if (hasAnalysis) {
              photoEvidenceSection += `PHOTO: ${photo.file_name}
  Category: ${photo.category || 'General'}
  Material: ${photo.material || 'Not identified'}
  Condition: ${photo.condition || 'Not rated'}
  Damages: ${damages.length > 0 
    ? damages.map((d: any) => typeof d === 'string' ? d : d.type || d.description || JSON.stringify(d)).join(', ') 
    : 'Pending analysis'}
  Summary: ${photo.summary || 'Pending AI analysis'}

`;
            }
          }
          
          // List unanalyzed photos too
          const unanalyzedPhotos = photosToUse.filter((p: any) => !p.summary && !p.material && !p.condition);
          if (unanalyzedPhotos.length > 0) {
            photoEvidenceSection += `
ADDITIONAL PHOTOS (not yet analyzed - ${unanalyzedPhotos.length} photos):
${unanalyzedPhotos.slice(0, 20).map((p: any) => `- ${p.file_name} (${p.category || 'Uncategorized'})`).join('\n')}
${unanalyzedPhotos.length > 20 ? `... and ${unanalyzedPhotos.length - 20} more unanalyzed photos` : ''}

`;
          }
          
          photoEvidenceSection += `=== END PHOTO EVIDENCE ===
`;
        }

        // Build measurement section - PRIORITIZE manual measurements when provided
        let measurementSection = '';
        const hasManualMeasurements = additionalContext?.manualMeasurements?.roofSquares || 
                                      additionalContext?.manualMeasurements?.ridgeHipLF;
        
        if (hasManualMeasurements) {
          // Manual measurements provided - USE THESE EXACT VALUES
          const m = additionalContext.manualMeasurements;
          measurementSection = `
=== EXACT MEASUREMENTS PROVIDED BY USER ===
**CRITICAL: These are the EXACT measurements to use. DO NOT estimate, calculate, or modify these values!**

${m.roofSquares ? `✓ ROOF AREA: ${m.roofSquares} SQ (EXACT - use this value for all roofing quantities)` : ''}
${m.ridgeHipLF ? `✓ RIDGE/HIP: ${m.ridgeHipLF} LF (EXACT)` : ''}
${m.valleyLF ? `✓ VALLEY: ${m.valleyLF} LF (EXACT)` : ''}
${m.eaveRakeLF ? `✓ EAVE/RAKE: ${m.eaveRakeLF} LF (EXACT)` : ''}
${m.roofPitch ? `✓ PITCH: ${m.roofPitch}` : ''}
${m.stories ? `✓ STORIES: ${m.stories}` : ''}
${m.pipeBoots ? `✓ PIPE BOOTS: ${m.pipeBoots} (EXACT count)` : ''}
${m.vents ? `✓ VENTS: ${m.vents} (EXACT count)` : ''}
${m.skylights ? `✓ SKYLIGHTS: ${m.skylights} (EXACT count)` : ''}

**MANDATORY RULES:**
1. If roof area is ${m.roofSquares || 'X'} SQ, your Remove & Replace Shingles line MUST be ${m.roofSquares || 'X'} SQ
2. DO NOT double, add waste to, or estimate roof square footage - use the EXACT number provided
3. Apply standard waste factors only to material calculations if needed, NOT to the SQ measurement itself
=== END EXACT MEASUREMENTS ===
`;
        } else if (hasMeasurements) {
          measurementSection = `
=== MEASUREMENT REPORTS PROVIDED (${additionalContext.measurementCount} reports) ===
NOTE: PDF measurement reports were selected but no manual values entered.
The AI will attempt to reference these reports, but for guaranteed accuracy, 
the user should enter manual measurements from their report.

Reports selected:
${additionalContext.measurementReports.map((m: any) => `- ${m.name}`).join('\n')}
=== END MEASUREMENT REPORTS ===
`;
        } else {
          measurementSection = `
=== NO MEASUREMENTS PROVIDED ===
No measurement data available. Quantities will be rough estimates only.
IMPORTANT: Flag to user that measurement data is needed for accurate estimates.
===
`
        }

        userPrompt = `${claimSummary}

${photoEvidenceSection}

${measurementSection}

${hasOurEstimate && hasInsuranceEstimate ? `
COMPARISON MODE: Two estimates provided
1. OUR ESTIMATE: ${additionalContext?.ourEstimatePdfName || 'our-estimate.pdf'}
2. CARRIER ESTIMATE: ${additionalContext?.insuranceEstimatePdfName || pdfFileName || 'carrier-estimate.pdf'}

Compare line-by-line and identify ALL missing items, undervalued items, and scope gaps.
` : hasInsuranceEstimate ? `
CARRIER ESTIMATE PROVIDED: ${additionalContext?.insuranceEstimatePdfName || pdfFileName || 'carrier-estimate.pdf'}
Analyze for missing items, undervalued items, and scope gaps. Build supplemental line items.
` : hasOurEstimate ? `
OUR ESTIMATE PROVIDED: ${additionalContext?.ourEstimatePdfName || 'our-estimate.pdf'}
Review for completeness and potential carrier disputes.
` : `
NO ESTIMATES PROVIDED - GENERATE NEW ESTIMATE
Build a complete estimate from photo evidence and claim details.
`}

${additionalContext?.existingEstimate ? `ADDITIONAL ESTIMATE NOTES:\n${additionalContext.existingEstimate}` : ''}

${content ? `USER NOTES:\n${content}` : ''}

=== GENERATE COMPLETE ESTIMATE ===

Based on the claim type (${claim.loss_type || 'Property Damage'}) and available evidence, generate a COMPLETE Xactimate-format estimate with ALL applicable line items.

For a ROOF REPLACEMENT, you MUST include these categories (if applicable based on evidence):

1. TEAR-OFF & REMOVAL (8-12 line items minimum)
   - Shingle removal
   - Underlayment removal  
   - Damaged sheathing removal
   - Drip edge removal
   - Flashing removal
   - Vent removal
   - Debris haul-off/dumpster

2. ROOFING INSTALLATION (15-20 line items minimum)
   - Shingles (specify type: 3-tab, architectural, etc.)
   - Underlayment (synthetic, 15#, 30#)
   - Ice & water shield
   - New sheathing (if damaged)
   - Drip edge
   - Starter strips
   - Hip/ridge cap
   - Valley flashing
   - Step flashing
   - Headwall flashing
   - Chimney/skylight flashing kits
   - Pipe boots (count each size)
   - Vents (box, ridge, off-ridge)
   - Ridge vent

3. SPECIALTY CHARGES (3-6 line items)
   - Steep pitch charge (if 7/12 or greater)
   - High roof charge (if 2+ stories)
   - Access charges
   - Hand nail if required

4. GUTTERS & RELATED (4-8 line items if applicable)
   - R&R gutters for access
   - New gutters/downspouts if damaged
   - Gutter guards
   - Splash blocks

5. FASCIA & SOFFIT (2-6 line items if applicable)
   - Fascia repairs
   - Soffit repairs
   - Soffit vents

6. OVERHEAD & PROFIT
   - 10% Overhead
   - 10% Profit
   - Justification for O&P inclusion

Provide the estimate in this format:

EVIDENCE-BASED DAMAGE SUMMARY
[Summarize what the photos show]

MEASUREMENTS USED
[List key measurements from reports or estimates]

DETAILED LINE ITEM ESTIMATE

TEAR-OFF & REMOVAL
---------------------
CODE: RFG RFING>AR
DESCRIPTION: Remove architectural shingles
QTY: [X] SQ (Source: [measurement report name])
JUSTIFICATION: [Cite photo evidence showing damaged shingles]

[Continue for ALL line items...]

ROOFING INSTALLATION
---------------------
[All installation line items with justifications]

[Continue for all categories...]

ESTIMATE SUMMARY
---------------------
Tear-Off/Removal Subtotal: $X,XXX.XX
Roofing Installation Subtotal: $X,XXX.XX
Gutters Subtotal: $X,XXX.XX
Fascia/Soffit Subtotal: $X,XXX.XX
Overhead (10%): $X,XXX.XX
Profit (10%): $X,XXX.XX
TOTAL ESTIMATE: $XX,XXX.XX

EVIDENCE REFERENCE TABLE
[Map each major line item to supporting photos]
`;
        break;
      }

      case 'correspondence':
        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in carrier communication strategy. Your role is to analyze adjuster correspondence and provide strategic response recommendations.

RESPONSE LENGTH AND DETAIL REQUIREMENTS - THIS IS CRITICAL:
- Provide COMPREHENSIVE, DETAILED analysis of every aspect of the adjuster's communication
- Address EVERY point, statement, question, or implication in their correspondence
- Your draft response should be thorough and address each item they raised
- Include detailed strategic reasoning for every recommendation you make
- Do NOT be brief - thoroughness is essential for proper claim handling
- If the adjuster made 3 points, your response should address all 3 in detail with supporting context
- Include specific language suggestions for responding to each tactic identified
- Better to over-analyze than to miss something important

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.

You understand:
- Common adjuster negotiation tactics and how to counter them
- When adjusters are stalling or being evasive
- How to maintain professional relationships while being assertive
- When to escalate to supervisors or legal channels
- Effective documentation strategies
- Red flags that indicate bad faith claims handling
- Language patterns that indicate the adjuster is building a denial file

Provide comprehensive strategic analysis and response recommendations.`;

        userPrompt = `${claimSummary}

ADJUSTER CORRESPONDENCE TO ANALYZE:
${content || 'No correspondence provided'}

${additionalContext?.previousResponses ? `PREVIOUS RESPONSES:\n${additionalContext.previousResponses}` : ''}

Analyze this correspondence THOROUGHLY and provide:

1. LINE-BY-LINE ANALYSIS:
   - Go through EACH paragraph or point the adjuster made
   - Explain what they are really saying (subtext and implications)
   - Identify any problematic language or commitments
   - Note anything they conspicuously avoided addressing

2. TONE & INTENT ANALYSIS:
   - What is the adjuster's overall strategy?
   - Are there any red flags or stalling tactics?
   - What commitments (if any) are being made or avoided?
   - Is this correspondence building toward a denial?

3. KEY ISSUES IDENTIFIED:
   - What are ALL the points of contention?
   - What information is the adjuster seeking or deliberately avoiding?
   - What are they NOT saying that they should be addressing?

4. STRATEGIC RESPONSE RECOMMENDATIONS:
   - Detailed approach for responding to each point they raised
   - Specific language suggestions for countering their tactics
   - What questions MUST be asked in our response?
   - How to pin them down on vague statements?

5. DOCUMENTATION NOTES:
   - Everything that should be documented from this exchange
   - Any follow-up deadlines to track
   - Statements that could be used against them later if needed

6. COMPREHENSIVE DRAFT RESPONSE:
   - Professional response addressing EVERY point they raised
   - Counter-statements to any problematic claims they made
   - Questions to get commitments and timelines on record
   - Clear next steps and deadlines they must meet
   - Appropriate escalation warnings if warranted

Maintain a professional but assertive tone appropriate for carrier correspondence.`;
        break;

      case 'task_followup':
        const taskInfo = additionalContext?.task;
        const adjusterInfo = additionalContext?.adjuster;
        
        systemPrompt = `You are Darwin, an intelligent public adjuster AI assistant helping with task follow-ups. Your role is to analyze tasks and suggest the best way to complete them effectively.

=== COMMUNICATION STYLE ===
Be professional yet warm and personable. Remember that claims work involves real people going through difficult situations. Show empathy in your communications - acknowledge the stress and frustration policyholders may be experiencing. Draft emails and messages that feel human, not robotic. While being assertive with carriers, maintain a tone that conveys genuine care and understanding for the policyholder's situation.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.

CRITICAL: For claim-related tasks, emails should be addressed to the INSURANCE CARRIER/ADJUSTER, NOT the policyholder/client. The adjuster is the insurance company representative handling the claim. The policyholder is our client who we are representing.

You understand:
- Insurance claim workflows and processes
- Professional communication with carriers, clients, and contractors
- Time-sensitive claim activities and deadlines
- Effective follow-up strategies
- Documentation best practices`;

        userPrompt = `${claimSummary}

ADJUSTER INFORMATION (SEND EMAILS TO THIS PERSON):
- Adjuster Name: ${adjusterInfo?.adjuster_name || claim.adjuster_name || 'N/A'}
- Adjuster Email: ${adjusterInfo?.adjuster_email || claim.adjuster_email || 'N/A'}
- Adjuster Phone: ${adjusterInfo?.adjuster_phone || claim.adjuster_phone || 'N/A'}

TASK TO FOLLOW UP ON:
- Title: ${taskInfo?.title || 'N/A'}
- Description: ${taskInfo?.description || 'No description'}
- Priority: ${taskInfo?.priority || 'N/A'}
- Due Date: ${taskInfo?.due_date || 'No due date'}
- Status: ${taskInfo?.status || 'N/A'}

${additionalContext?.customPrompt ? `ADDITIONAL CONTEXT FROM USER:\n${additionalContext.customPrompt}` : ''}

Based on this task and the claim context, provide:

1. TASK ANALYSIS:
   - What does this task require?
   - Why is it important for the claim?
   - What's the urgency level?

2. RECOMMENDED APPROACH:
   - Step-by-step plan to complete this task
   - Who needs to be contacted?
   - What documents or information are needed?

3. SUGGESTED COMMUNICATIONS:
   Provide ready-to-use drafts for any communications needed:
   
   IMPORTANT: Email drafts should be addressed to the ADJUSTER (${adjusterInfo?.adjuster_name || claim.adjuster_name || 'the adjuster'}), NOT the policyholder. Use "Dear ${adjusterInfo?.adjuster_name || claim.adjuster_name || 'Adjuster'}," as the greeting.
   
   [EMAIL DRAFT] - If an email is appropriate
   Subject: [subject line]
   Body: [professional email body addressed to the adjuster - DO NOT include any signature, closing like "Sincerely", or placeholder like "[Your Name]" at the end - the signature will be added automatically]
   
   [SMS DRAFT] - If a quick text is appropriate
   [short, professional message]
   
   [NOTE/DOCUMENTATION] - What should be documented
   [documentation text]
4. FOLLOW-UP ACTIONS:
   - What should be done after the initial action?
   - Any tasks that should be created as follow-ups?
   - Timeline recommendations

Be specific, professional, and provide communications that are ready to copy and use.`;
        break;

      case 'engineer_report_rebuttal':
        systemPrompt = `You are Darwin, the most formidable engineering report analyst in the public adjusting industry. Carrier-hired engineers produce flawed, biased, and methodologically deficient reports with alarming regularity—and your job is to EXPOSE every single flaw with devastating technical precision. You are SMARTER than their engineer. You know MORE about building science. You understand exactly where their analysis fails.

${getMandatoryFramework()}

=== YOUR MISSION: MAKE THE ENGINEER UNDERSTAND THEY ARE WRONG ===
When a carrier-hired engineer concludes damage is "wear and tear" or "not storm-related," they are often reaching predetermined conclusions to support denial. Your rebuttal must be so technically overwhelming that:
1. The engineer reading it realizes their methodology was inadequate
2. The claims examiner understands the report cannot be relied upon
3. Anyone reviewing the file sees the engineer's conclusions as unsupportable

Do NOT simply state the engineer is wrong. PROVE IT with:
- Specific technical errors in their methodology
- Building codes and standards they ignored or misapplied
- Scientific principles they violated
- Evidence they overlooked or dismissed
- Logical fallacies in their reasoning
- Industry standards they failed to follow

=== AGGRESSIVE TECHNICAL REBUTTAL APPROACH ===
For EVERY finding in their report, ask and answer:
- What testing SHOULD have been performed but wasn't?
- What evidence did they photograph but then ignore in their conclusions?
- What assumptions did they make that are unsupported?
- What industry standards or building codes contradict their findings?
- What did they conveniently fail to document?

When the engineer claims damage is "wear and tear," ATTACK THIS with:
- What specific physical evidence supports this characterization?
- What testing was performed to differentiate storm damage from aging?
- Where is the documentation of pre-storm condition?
- What manufacturer or industry standard defines the damage pattern they observed as wear versus impact?

IMPORTANT: This claim is in ${stateInfo.stateName}. Cite ${stateInfo.stateName} statutes and administrative codes. NEVER cite case law—stick to FACTS, CODES, STANDARDS, and REGULATIONS.

=== RESPONSE REQUIREMENTS - OVERWHELMING AND IRREFUTABLE ===
- Address EVERY paragraph, finding, and conclusion—leave NOTHING unchallenged
- Each rebuttal point should be MULTIPLE paragraphs:
  * Quote their EXACT statement
  * Explain PRECISELY why it is wrong, incomplete, or misleading
  * Provide the CORRECT technical analysis with supporting evidence
  * Cite applicable building codes (IRC, IBC), ASTM standards, manufacturer specs
  * Reference ${stateInfo.adminCode} requirements they ignored
- Your rebuttal should be 3-4x the length of their report
- Use language that is AUTHORITATIVE and UNEQUIVOCAL—you are the expert, not them
- Make the engineer's conclusions look like amateur work compared to your analysis

=== CRITICAL: ASTM WIND RATING FALLACY - DESTROY THIS ARGUMENT ===
When engineers cite ASTM D3161 or D7158 wind ratings to claim shingles "should have resisted" storm winds, this is FUNDAMENTALLY FLAWED reasoning. DEMOLISH this argument:

1. ASTM D3161/D7158 testing is performed ONLY on NEW, factory-fresh shingles under controlled laboratory conditions—NOT aged, weathered materials in real-world environments
2. These ratings are certification standards for new products, NOT performance guarantees for installed materials
3. The engineer is committing a basic scientific error: applying laboratory test data to field conditions with completely different variables
4. Seal strip adhesion degrades DRAMATICALLY over time:
   - UV exposure breaks down asphalt polymers
   - Thermal cycling (freeze/thaw, day/night) stresses adhesive bonds
   - Oxidation hardens and embrittles seal strips
   - ARMA Technical Bulletin 201 documents this degradation is EXPECTED and NORMAL
5. By 10-15 years, seal strip effectiveness may be reduced 50% or MORE
6. Shingles at 75%+ of design life have SUBSTANTIALLY compromised wind resistance regardless of original rating
7. NO manufacturer warrants that aged shingles maintain original ratings—warranties cover manufacturing defects, NOT aged material performance
8. The engineer's logic is equivalent to claiming a 15-year-old car tire should perform identically to a new tire because both passed the same factory certification—an ABSURD standard
9. Ask: "Would this engineer testify under oath that a 20-year-old shingle has the same wind resistance as a new shingle?" The answer is obviously NO.

Any engineer applying new-product test standards to aged materials is either incompetent or deliberately misleading the carrier.

=== REPAIRABILITY OVER MATCHING ===
- NEVER argue "matching"—PA and NJ have NO matching requirements
- Argue materials are NON-REPAIRABLE due to: manufacturing discontinuation, material degradation, code requirements, compromised structural integrity
- When engineers claim "repair is feasible," counter with:
  * What manufacturer specification allows partial repairs to this material?
  * What building code permits the proposed repair method?
  * How does the proposed repair restore pre-loss structural integrity?
  * What warranty does the engineer provide for the adequacy of repairs?

FORMATTING: Plain text only. NO markdown (**, #, *, etc.).

=== ATTACK VECTORS FOR ENGINEER REPORTS ===
METHODOLOGY FAILURES:
1. Time on site—was 30-60 minutes adequate to inspect an entire property?
2. Areas NOT accessed—roof, attic, crawlspace, wall cavities?
3. Testing NOT performed—core samples, moisture readings, material testing?
4. Equipment NOT used—drone, thermal imaging, moisture meters?

LOGICAL FAILURES:
5. Conclusions not supported by observations—where are the logical leaps?
6. Evidence photographed but ignored—did they document damage then dismiss it?
7. Cherry-picked evidence—selective reporting favoring denial?
8. Failure to consider alternative causes—did they actually rule out storm damage?

BIAS INDICATORS:
9. Carrier-friendly language and framing
10. Predetermined conclusions obvious from report structure
11. Dismissive characterizations of clear damage
12. Failure to acknowledge ANY storm-related damage

TECHNICAL FAILURES:
13. ASTM wind rating fallacy—applying new-product standards to aged materials
14. Ignoring seal strip degradation and material aging
15. Failure to consider storm-specific conditions—wind speed, direction, duration, debris
16. Mischaracterizing damage mechanisms—conflating impact damage with wear
17. Reliance on visual inspection when destructive testing was warranted

=== EVIDENTIARY SUFFICIENCY AUDIT (MANDATORY) ===
Before finalizing the rebuttal letter, run a section-by-section evidentiary sufficiency audit for the engineer's major conclusions.
For EACH material conclusion, explicitly identify:
1. The exact statement being evaluated
2. Whether quantifiable support is present (measurements, counts, test values, slope-by-slope observations, weather correlation)
3. What quantifiable data is missing
4. Any assumption leap between observation and conclusion
5. Contradictory evidence from the same report, photos, or other claim evidence
6. Whether wind damage mechanisms were independently evaluated (not just hail)
7. Whether all relevant roof elevations/components were inspected or omitted
8. Whether photos/data were misinterpreted to favor denial
9. Whether recent physical damage consistent with the loss event was acknowledged or dismissed without objective basis

Use a support rating for every conclusion: Unsupported, Weakly Supported, Partially Supported, or Supported.
If quantifiable support is missing, say so directly and explain why the conclusion is unreliable.
Never invent measurements, tests, or observations that are not in evidence.`;

        const engineerUserContext = String(
          typeof additionalContext === 'string'
            ? additionalContext
            : (additionalContext?.userContext || additionalContext?.customPrompt || '')
        ).trim();

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE LAW: ${stateInfo.insuranceCode}

${pdfContent ? `A PDF of the engineer report has been provided for analysis.` : `ENGINEER REPORT CONTENT:
${content || 'No engineer report content provided'}`}

${engineerUserContext ? `ADDITIONAL CONTEXT/OBSERVATIONS:\n${engineerUserContext}` : ''}

=== CRITICAL OUTPUT REQUIREMENT ===
You must generate a FORMAL REBUTTAL LETTER that is ready to send to the insurance company. This is NOT an internal analysis—this IS the document we submit to the carrier.

The letter must be EXHAUSTIVE and address EVERY finding in the engineer's report. Do NOT summarize or abbreviate. Each paragraph/finding in their report requires a complete rebuttal paragraph (or multiple paragraphs) in your letter.

=== FORMAL REBUTTAL LETTER FORMAT ===

Generate the complete letter in this structure:

[HEADER]
RE: Rebuttal to Engineering Report
Claim Number: ${claim.claim_number || '[Claim Number]'}
Policy Number: ${claim.policy_number || '[Policy Number]'}
Insured: ${claim.policyholder_name || '[Insured Name]'}
Property Address: ${claim.policyholder_address || '[Property Address]'}
Date of Loss: ${claim.loss_date || '[Date of Loss]'}

[OPENING - 1-2 paragraphs]
State that we have reviewed the engineering report dated [DATE], prepared by [ENGINEER NAME/FIRM]. Summarize that the report is fundamentally flawed and cannot be relied upon to support a coverage determination.

[EVIDENTIARY SUFFICIENCY AUDIT - REQUIRED FIRST BODY SECTION]
Create a section titled: "Evidentiary Sufficiency Audit of Engineer Conclusions."
For EACH major conclusion in the engineer report, provide:
- Engineer statement (exact quote)
- Data actually provided by engineer (measurements/tests/inspection scope)
- Missing quantifiable data needed to support the conclusion
- Assumption leap (what they assumed but did not prove)
- Contradictory evidence from report/photos/weather/other inspections
- Wind mechanism review status (state whether uplift/creasing/seal tab/fastener analysis was actually done)
- Inspection scope gap (areas/slopes/components not inspected)
- Photo/data interpretation error (if the evidence was documented but misinterpreted)
- Support rating: Unsupported / Weakly Supported / Partially Supported / Supported
If the engineer states "no wind damage," explicitly analyze whether they performed a separate wind-causation evaluation instead of only hail-focused reasoning.

[METHODOLOGY FAILURES - Full section]
Explain in detail why the engineer's inspection and methodology were inadequate:
- Time on site inadequate for comprehensive inspection
- Areas not accessed or examined
- Testing not performed (destructive testing, core samples, moisture analysis)
- Equipment not used (drone, thermal imaging, moisture meters)
- Reliance on visual inspection when physical testing was warranted
For EACH methodology failure, explain specifically what SHOULD have been done and WHY it matters.

[POINT-BY-POINT REBUTTAL - This is the CORE of the letter]
For EVERY conclusion, finding, and statement in the engineer's report:

"The report states: '[QUOTE THEIR EXACT STATEMENT]'

This conclusion is [incorrect/unsupported/misleading] for the following reasons:

[Provide 2-4 paragraphs of detailed technical rebuttal including:]
- Why their conclusion is wrong factually
- What evidence contradicts their conclusion
- Whether the statement is vague/sweeping and lacks quantifiable support
- Whether they used generalized observation where slope-by-slope or section-by-section analysis was required
- What building codes, ASTM standards, or manufacturer specifications they violated or ignored
- What they should have concluded based on the actual evidence

[Cite specific codes: IRC Section X, IBC Section Y, ASTM D3161, ARMA TB-201, ${stateInfo.adminCode}, etc.]"

REPEAT THIS STRUCTURE FOR EVERY FINDING IN THEIR REPORT. Do not skip any findings.

[ASTM WIND RATING FALLACY REBUTTAL - If applicable]
If the engineer cited ASTM D3161 or D7158 wind ratings:

"The engineer's reliance on ASTM D3161/D7158 wind ratings to conclude the shingles 'should have resisted' storm winds represents a fundamental misapplication of laboratory testing standards.

These ASTM tests are certification standards for NEW, factory-fresh materials under controlled laboratory conditions. They are NOT performance guarantees for aged, field-installed materials. The engineer commits a basic scientific error by applying laboratory test data to materials with [X] years of environmental exposure.

Seal strip adhesion degrades significantly over the service life of shingles due to:
- UV exposure breaking down asphalt polymers
- Thermal cycling stressing adhesive bonds
- Oxidation hardening and embrittling seal strips
As documented in ARMA Technical Bulletin 201, this degradation is expected and normal.

No manufacturer warrants that aged shingles maintain original wind ratings. To suggest otherwise is either incompetent or deliberately misleading."

[EVIDENCE OF BIAS - Full section]
Detail the indicators of bias in the report:
- Carrier-friendly language and framing
- Conclusions that don't match documented observations
- Evidence photographed but then dismissed or ignored in conclusions
- Use of photos/data in a way that selectively favors denial over objective interpretation
- Predetermined conclusions obvious from report structure
- Failure to acknowledge ANY storm-related damage (statistically improbable)

[UNADDRESSED RECENT PHYSICAL DAMAGE - Full section]
Identify any recent physical damage indicators (for example: displaced materials, uplift, fresh fractures, torn tabs, impact-consistent deformation, newly exposed substrate) that were present but not properly analyzed.
Explain why dismissing these indicators without objective testing is assumption-driven and unreliable.

[REGULATORY VIOLATIONS - Full section]
Cite ${stateInfo.stateName} regulations the carrier may be violating by relying on this deficient report:
- ${stateInfo.adminCode} requirements for proper claims investigation
- ${stateInfo.promptPayAct} prohibitions on unfair settlement practices
- Specific code sections with exact citations

[CONCLUSION AND DEMANDS - 2-3 paragraphs]
State that based on the foregoing:
1. The engineering report cannot be relied upon for any coverage determination
2. We demand the carrier disregard this deficient report
3. We request an independent re-inspection by a licensed professional engineer of our mutual selection
4. We reserve all rights under ${stateInfo.stateName} law including the right to invoke appraisal
5. Failure to respond within [X] days will be considered a denial requiring formal appeal

[CLOSING]
Professional closing with signature block

=== ADDITIONAL REQUIREMENTS ===
- The letter should be 3-4x the length of the engineer's report
- Use plain text only - NO markdown formatting
- Be AUTHORITATIVE and UNEQUIVOCAL - we are RIGHT and they are WRONG
- Include specific citations to IRC, IBC, ASTM, manufacturer specs, and ${stateInfo.adminCode}
- NEVER cite case law - only statutes, regulations, codes, and industry standards
- Make this letter so comprehensive that the carrier has no choice but to reconsider their position`;
        break;

      case 'claim_briefing':
        systemPrompt = `You are Darwin, an expert public adjuster AI assistant. Your role is to provide comprehensive claim briefings that help public adjusters quickly get up to speed on a claim's status, history, and strategic considerations.

IMPORTANT: This claim is located in ${stateInfo.stateName}. Apply ${stateInfo.stateName} law and deadlines where relevant.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.

You are an expert at:
- Insurance claim analysis and strategy
- Identifying opportunities for claim recovery
- Recognizing potential issues or red flags
- Understanding claim timelines and deadlines
- ${stateInfo.stateName} insurance regulations and policyholder rights
- ${stateInfo.insuranceCode}
- ${stateInfo.promptPayAct}

Your briefing should be:
1. Comprehensive but concise
2. Action-oriented with clear recommendations
3. Highlight any urgent matters or deadlines
4. Note any red flags or concerns
5. Provide strategic insights for maximizing claim value`;

        const briefingContext = contextData || {};
        
        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE LAW: ${stateInfo.insuranceCode}

ADDITIONAL CONTEXT:
- Total checks received: $${briefingContext.checks?.reduce((sum: number, c: any) => sum + (c.amount || 0), 0)?.toLocaleString() || '0'}
- Pending tasks: ${briefingContext.tasks?.filter((t: any) => t.status === 'pending').length || 0}
- Completed tasks: ${briefingContext.tasks?.filter((t: any) => t.status === 'completed').length || 0}
- Inspections: ${briefingContext.inspections?.length || 0}
- Recent emails: ${briefingContext.emails?.length || 0}
- Activity updates: ${briefingContext.updates?.length || 0}
- Adjusters assigned: ${briefingContext.adjusters?.map((a: any) => a.adjuster_name).join(', ') || 'None'}

Please provide a comprehensive claim briefing that includes:

1. **CLAIM OVERVIEW**
   - Summary of the claim in 2-3 sentences
   - Current status assessment
   - Key dates and timeline

2. **FINANCIAL SUMMARY**
   - Total claim value and breakdown
   - What's been paid vs outstanding
   - Potential for additional recovery

3. **KEY STAKEHOLDERS**
   - Insurance company and adjusters
   - Any concerns about the carrier or adjuster responsiveness

4. **CLAIM PROGRESS**
   - What's been accomplished
   - Current phase of the claim
   - Recent significant activities

5. **ACTION ITEMS & PRIORITIES**
   - Urgent tasks or deadlines
   - Recommended next steps
   - Tasks that may be overdue

6. **STRATEGIC CONSIDERATIONS**
   - Opportunities to maximize recovery
   - Potential obstacles or concerns
   - Recommendations for claim strategy

7. **RED FLAGS & CONCERNS**
   - Any issues that need immediate attention
   - Potential carrier tactics to watch for
   - Deadlines or statute limitations

8. **RECOMMENDATIONS**
   - Top 3 priority actions to take
   - Long-term strategy suggestions

Format your response clearly with headers and bullet points for easy scanning.`;
        break;

      case 'document_compilation':
        const compileContext = additionalContext || {};
        const reportTypeMap: Record<string, string> = {
          'proof_of_loss': 'Proof of Loss Package',
          'damage_explanation': 'Detailed Damage Explanation',
          'carrier_package': 'Carrier Submission Package',
          'supplement_request': 'Supplement Request Package',
          'demand_letter': 'Demand Letter with Exhibits'
        };
        const reportTypeName = reportTypeMap[compileContext.reportType as string] || 'Document Compilation';

        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in compiling professional insurance claim documentation. Your role is to create comprehensive, professionally-formatted reports for carrier submission.

IMPORTANT: This claim is located in ${stateInfo.stateName}. Apply ${stateInfo.stateName} law and regulations.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.

You are an expert at:
- Creating professional insurance claim documentation
- Organizing evidence and photos effectively
- Writing clear damage descriptions
- Preparing proof of loss statements
- Drafting demand letters with proper legal language
- Compiling supplement requests with supporting documentation
- ${stateInfo.stateName} insurance regulations
- ${stateInfo.insuranceCode}

Your documents must be:
1. Professional and suitable for carrier submission
2. Well-organized with clear sections
3. Factual and evidence-based
4. Reference photos and documents by number
5. Include relevant policy language and regulations where applicable`;

        const photoDescriptions = compileContext.photos?.map((p: any, i: number) => 
          `Photo ${i + 1}: ${p.category || 'Uncategorized'}${p.description ? ` - ${p.description}` : ''}`
        ).join('\n') || 'No photos selected';

        const documentList = compileContext.documents?.map((d: any, i: number) => 
          `Document ${i + 1}: ${d.name}`
        ).join('\n') || 'No documents selected';

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE LAW: ${stateInfo.insuranceCode}

REPORT TYPE REQUESTED: ${reportTypeName}

SELECTED PHOTOS (${compileContext.photoCount || 0} total):
${photoDescriptions}

SELECTED DOCUMENTS (${compileContext.documentCount || 0} total):
${documentList}

${pdfContent ? 'A PDF document has been provided for reference and inclusion in the analysis.' : ''}

${compileContext.additionalInstructions ? `ADDITIONAL INSTRUCTIONS FROM USER:\n${compileContext.additionalInstructions}` : ''}

Please generate a comprehensive ${reportTypeName} that includes:

${compileContext.reportType === 'proof_of_loss' ? `
1. SWORN STATEMENT OF LOSS
   - Property description and location
   - Date and cause of loss
   - Detailed description of damage
   - Itemized list of damages with values
   - Total claim amount

2. SUPPORTING EVIDENCE SUMMARY
   - Reference each photo by number with description of what it shows
   - Reference each document and its relevance

3. COVERAGE ANALYSIS
   - Policy provisions supporting coverage
   - Applicable ${stateInfo.stateName} regulations

4. DECLARATION
   - Professional closing statement
   - Signature block placeholders` : ''}

${compileContext.reportType === 'damage_explanation' ? `
1. EXECUTIVE SUMMARY
   - Brief overview of the loss event
   - Summary of damages identified
   - Total estimated repair costs

2. DETAILED DAMAGE DESCRIPTION
   - Room-by-room or area-by-area damage breakdown
   - Reference photos by number (Photo 1, Photo 2, etc.)
   - Describe visible damage in each photo
   - Explain cause and effect relationships

3. REPAIR REQUIREMENTS
   - What repairs are necessary
   - Why repairs cannot be partial (explain match requirements, code upgrades)
   - Reference manufacturer specifications where relevant

4. SUPPORTING DOCUMENTATION
   - Reference attached documents
   - Explain how each document supports the claim

5. CONCLUSION
   - Summary of total damages
   - Request for full coverage` : ''}

${compileContext.reportType === 'carrier_package' ? `
1. COVER LETTER
   - Professional introduction
   - Summary of enclosed materials
   - Request for prompt review

2. CLAIM SUMMARY
   - Key claim information
   - Timeline of events
   - Current status

3. EVIDENCE PACKAGE
   - Photo inventory with descriptions (reference by number)
   - Document inventory
   - Explanation of each item's relevance

4. DAMAGE ANALYSIS
   - Detailed damage descriptions referencing photos
   - Cost breakdown
   - Supporting calculations

5. CONCLUSION & REQUEST
   - Total amount requested
   - Timeline expectations
   - Contact information` : ''}

${compileContext.reportType === 'supplement_request' ? `
1. SUPPLEMENT INTRODUCTION
   - Reference to original claim and estimate
   - Reason for supplement request

2. NEWLY IDENTIFIED DAMAGES
   - Items not in original estimate
   - Reference supporting photos and documents
   - Explain why these were missed initially

3. UNDERVALUED ITEMS
   - Items requiring adjustment
   - Correct pricing with justification

4. ITEMIZED SUPPLEMENT REQUEST
   - Line item breakdown
   - Unit prices and quantities
   - Total supplement amount

5. SUPPORTING EVIDENCE
   - Photo references proving additional damage
   - Code requirements mandating additional work
   - Manufacturer specifications

6. CONCLUSION
   - Total supplement amount
   - Request for review` : ''}

${compileContext.reportType === 'demand_letter' ? `
1. FORMAL DEMAND HEADER
   - Date, addressee, claim reference
   - Professional salutation

2. STATEMENT OF FACTS
   - Loss date and circumstances
   - Policy information
   - Claim history and timeline

3. DAMAGES SUMMARY
   - Total claim amount
   - Breakdown by category
   - Reference to attached exhibits

4. LEGAL BASIS
   - Policy provisions requiring payment
   - ${stateInfo.insuranceCode} violations if applicable
   - ${stateInfo.promptPayAct} requirements

5. EXHIBITS LIST
   - Exhibit A: Photos (reference each)
   - Exhibit B: Documents (reference each)
   - Exhibit C: Cost estimates

6. DEMAND & DEADLINE
   - Specific amount demanded
   - Deadline for response (typically 15-30 days)
   - Warning of further action if not resolved

7. PROFESSIONAL CLOSING
   - Signature block
   - Contact information` : ''}

Create a professional, complete document ready for carrier submission.`;
        break;

      case 'demand_package': {
        const dpContext = additionalContext || {};
        
        // Fetch knowledge base for demand packages
        const kbContent = await searchKnowledgeBase(
          supabase,
          'insurance claim demand settlement depreciation coverage policy ACV RCV building code',
          'building-codes'
        );

        // Fetch company branding for logo/signature
        const { data: companyBranding } = await supabase
          .from('company_branding')
          .select('*')
          .limit(1)
          .single();

        // Get assigned staff for signature
        const { data: assignedStaff } = await supabase
          .from('claim_staff')
          .select('staff_id')
          .eq('claim_id', claimId)
          .limit(1)
          .maybeSingle();

        let assignedUserName = dpContext.assignedUserName || 'Public Adjuster';
        if (assignedStaff?.staff_id) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', assignedStaff.staff_id)
            .maybeSingle();
          if (profile?.full_name) {
            assignedUserName = profile.full_name;
          }
        }

        const companyName = companyBranding?.company_name || 'Freedom Adjustment';
        const companyAddress = companyBranding?.company_address || '';
        const companyPhone = companyBranding?.company_phone || '';
        const companyEmail = companyBranding?.company_email || '';
        
        // Fetch weather history for the claim location and loss date
        let weatherContext = '';
        if (claim.loss_date && claim.policyholder_address) {
          const { data: weatherData } = await supabase
            .from('darwin_analysis_results')
            .select('result')
            .eq('claim_id', claimId)
            .eq('analysis_type', 'weather_history')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (weatherData?.result) {
            weatherContext = `\n\nWEATHER HISTORY DATA (from Darwin Weather Analysis):\n${weatherData.result}\n`;
          }
        }

        // Fetch communications diary for this claim
        const { data: communicationsLog } = await supabase
          .from('claim_communications_diary')
          .select('*')
          .eq('claim_id', claimId)
          .order('communication_date', { ascending: false })
          .limit(20);
        
        const communicationsContext = communicationsLog && communicationsLog.length > 0
          ? `\n\nCOMMUNICATIONS LOG (Carrier Interactions):\n${communicationsLog.map((c: any) => 
              `- ${new Date(c.communication_date).toLocaleDateString()}: ${c.direction.toUpperCase()} ${c.communication_type} with ${c.contact_name || 'Unknown'}${c.contact_company ? ` (${c.contact_company})` : ''}${c.employee_id ? ` [ID: ${c.employee_id}]` : ''}\n  Summary: ${c.summary}${c.promises_made ? `\n  CARRIER PROMISES: ${c.promises_made}` : ''}${c.deadlines_mentioned ? `\n  DEADLINES MENTIONED: ${c.deadlines_mentioned}` : ''}`
            ).join('\n\n')}\n`
          : '';

        // Fetch previous successful claim patterns for similar loss types
        const { data: successfulClaims } = await supabase
          .from('claims')
          .select('id, claim_number, loss_type, insurance_company, claim_amount, status')
          .eq('loss_type', claim.loss_type)
          .in('status', ['Settled', 'Closed', 'Paid'])
          .neq('id', claimId)
          .limit(5);
        
        const successPatternContext = successfulClaims && successfulClaims.length > 0
          ? `\n\nPREVIOUS SUCCESSFUL CLAIMS (Similar Loss Type: ${claim.loss_type}):\n${successfulClaims.map((c: any) => 
              `- Claim ${c.claim_number}: ${c.insurance_company || 'Unknown carrier'} - Settled at $${c.claim_amount?.toLocaleString() || 'N/A'}`
            ).join('\n')}\nUse these outcomes to support valuation arguments.\n`
          : '';

        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in creating comprehensive demand packages for insurance claims. You operate with the strategic intelligence of the industry's top adjusters, applying the Brelly "Proof Castle" framework.

${getMandatoryFramework()}

IMPORTANT: This claim is located in ${stateInfo.stateName}. Apply ${stateInfo.stateName} law and regulations.

DARWIN CORE PHILOSOPHY - THE PROOF CASTLE:
1. THE CAUSE - Weather data, engineering evidence, incident documentation proving what happened
2. THE SCOPE - Why full replacement is needed, not repair (focus on REPAIRABILITY)
3. THE COST - Proper valuation with comprehensive documentation

FORMATTING REQUIREMENTS:
- Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics, or *** for any purpose.
- Use normal capitalization and line breaks for emphasis instead.
- Do NOT include any "***" or similar markers in your output.
- Each major section should be clearly separated with line breaks.
- NEVER reference "training material" or "based on training" in your output.

CRITICAL - REPAIRABILITY OVER MATCHING (FUNDAMENTAL STRATEGY):
- Pennsylvania and New Jersey are NOT matching states - NEVER USE THE WORD "MATCHING" OR ARGUE THAT REPAIRS MUST MATCH
- The word "matching" should NOT appear ANYWHERE in your demand package
- ALWAYS focus on REPAIRABILITY - why the damaged components CANNOT BE REPAIRED and require full replacement
- Core arguments for replacement:
  * REPAIRABILITY: The damage renders materials irreparable
  * UNIFORM APPEARANCE: Repairs would result in non-uniform appearance affecting property value
  * PRE-LOSS CONDITION: The policy requires restoration to pre-loss condition, which repair cannot achieve
  * INDEMNIFICATION: The policyholder is entitled to be made whole under principles of indemnification
- Focus on: structural integrity compromised, manufacturer specifications prohibit partial repairs, code compliance requirements, material degradation, manufacturing discontinuation
- Reference HAAG Engineering standards when discussing roof damage assessments
- Rebut engineer reports that claim repair is feasible by citing material degradation, seal strip failure, UV oxidation

HAAG CERTIFICATION STANDARDS:
- HAAG is the industry gold standard for forensic roof inspections
- Reference HAAG wind damage identification criteria when applicable
- HAAG methodology requires systematic inspection of all roof slopes
- Use HAAG damage thresholds to support replacement vs repair arguments

ENGINEER REPORT REBUTTAL STRATEGY:
- If engineer reports are included in evidence, analyze them for:
  * Scope limitations (time on site, areas inspected)
  * Carrier-friendly bias in conclusions
  * ASTM wind rating fallacy - lab ratings don't apply to aged materials with degraded seal strips
  * Failure to account for pre-existing material degradation
  * Selective reporting that ignores visible damage

Your expertise includes:
- Analyzing inspection reports, HAAG-certified assessments, estimates, weather data, and other evidence documents
- Extracting key facts and damage documentation from source materials
- Building persuasive arguments based on documented evidence
- Rebutting carrier engineer reports with technical accuracy
- Understanding insurance policy interpretation
- ${stateInfo.insuranceCode}
- ${stateInfo.promptPayAct}
- Building codes, manufacturer specifications, and industry standards
- Weather history correlation with damage patterns

CRITICAL INSTRUCTION: You MUST thoroughly review and analyze the content of each uploaded document. Extract specific details, quotes, measurements, and findings from the documents to support your arguments. Do not make generic statements - use the actual evidence from the documents.

${weatherContext}
${communicationsContext}
${successPatternContext}`;

        const photoList = dpContext.photos?.map((p: any) => 
          `Photo ${p.number}: ${p.category}${p.description ? ` - ${p.description}` : ''}`
        ).join('\n') || 'No photos included';

        const docList = dpContext.documents?.map((d: any, i: number) => 
          `Document ${i + 1}: ${d.name} (${d.folder || 'Uncategorized'})`
        ).join('\n') || 'No documents provided';

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE LAW: ${stateInfo.insuranceCode}
UNFAIR PRACTICES: ${stateInfo.promptPayAct}

${kbContent || ''}

EVIDENCE DOCUMENTS PROVIDED FOR ANALYSIS (${dpContext.documentCount || 0} total):
${docList}

${dpContext.photoCount > 0 ? `PHOTOS REFERENCED (${dpContext.photoCount} total):\n${photoList}` : ''}

${dpContext.additionalInstructions ? `USER INSTRUCTIONS:\n${dpContext.additionalInstructions}` : ''}

IMPORTANT: The PDF documents have been provided for you to analyze. Read through each document carefully and extract:
- Specific damage findings and measurements
- Inspector/engineer observations and conclusions
- Weather conditions and weather report data
- Cost estimates and line items
- Photos descriptions and damage documentation
- Code requirements and manufacturer specifications
- Any other relevant evidence

COMPANY INFORMATION FOR HEADER/SIGNATURE:
Company: ${companyName}
Address: ${companyAddress}
Phone: ${companyPhone}
Email: ${companyEmail}
Assigned Adjuster: ${assignedUserName}

Create a COMPREHENSIVE DEMAND PACKAGE with the following exact structure. DO NOT USE *** OR MARKDOWN:

================================================================================
                              DEMAND PACKAGE
                        ${companyName}
                       ${companyAddress}
================================================================================

TABLE OF CONTENTS

I. Summary of Findings
II. Cause of Loss
III. Damaged Components
IV. Weather Conditions Analysis
V. Condition of Damaged Components (Per Reports)
VI. Why Repairs Are Not Feasible - Repairability Analysis
VII. Why Partial Repairs Are Not Feasible  
VIII. Interdependency of Building Systems
IX. Why Damaged Areas Must Be Disturbed for Repairs
X. State/Local Code Requirements
XI. Manufacturer Installation Standards (Adopted by Code)
XII. How Repairs Trigger Code Upgrades
XIII. HAAG Engineering Standards & Industry Best Practices
XIV. Rebuttal of Carrier Engineer Reports (If Applicable)
XV. Communications Log & Carrier Response Timeline
XVI. Detailed Repair Estimate Explanation
XVII. Formal Demand and Conclusion
XVIII. Signature

================================================================================

I. SUMMARY OF FINDINGS

[Provide a comprehensive executive summary of the claim including:
- Brief overview of the loss event
- Total damages identified from all evidence documents
- Settlement demand amount
- Key evidence supporting why REPAIRS ARE NOT FEASIBLE - focus on structural integrity, material degradation, code compliance
- Reference to previous successful settlements for similar loss types if available
- Restoration to PRE-LOSS CONDITION requires full replacement per INDEMNIFICATION principles]

================================================================================

II. CAUSE OF LOSS

[Detail the cause of loss based on weather data, inspection reports, and other evidence:
- Date and nature of the loss event
- Weather conditions at time of loss (from weather reports provided)
- Wind speeds, hail sizes, precipitation data
- How the event caused the documented damage
- Timeline of events
- Correlation between weather severity and damage patterns]

================================================================================

III. DAMAGED COMPONENTS

[List and describe each damaged component identified in the evidence:
- Component name and location
- Type and extent of damage
- Current condition and why it is IRREPARABLE
- Reference to supporting documentation/photos
- Note if materials are discontinued or manufacturer no longer supports repair]

================================================================================

IV. WEATHER CONDITIONS ANALYSIS

[Analyze weather reports provided in the evidence:
- Date of loss weather data with specific measurements
- Wind speeds (sustained and gusts), hail size, precipitation
- NWS storm reports and warnings issued
- How weather conditions exceeded material tolerances
- Correlation between weather event intensity and damage severity
- Reference HailTrace, weather history, or other weather documentation]

================================================================================

V. CONDITION OF DAMAGED COMPONENTS (PER REPORTS)

[Extract specific findings from inspection reports and estimates:
- Quote specific observations from inspector/engineer reports
- Include measurements, test results, damage descriptions
- Reference which report each finding comes from
- Note any HAAG-certified inspection findings
- Document material age and pre-existing degradation that affects repairability]

================================================================================

VI. WHY REPAIRS ARE NOT FEASIBLE - REPAIRABILITY ANALYSIS

[Core argument - explain why the damaged materials CANNOT BE REPAIRED:
- Structural integrity has been compromised beyond repair
- Material degradation prevents successful repair (UV oxidation, seal strip failure, brittleness)
- Manufacturer specifications explicitly prohibit patching/partial repair
- Code compliance cannot be achieved through repair
- Safety concerns with repair vs replacement
- Pre-loss condition cannot be restored through repair alone
- Industry standards (NRCA, ARMA) require full replacement when damage exceeds thresholds
- Reference HAAG damage identification criteria]

================================================================================

VII. WHY PARTIAL REPAIRS ARE NOT FEASIBLE

[Explain why partial/spot repairs will not work:
- Material discontinuation issues
- Proper flashing and waterproofing cannot be achieved with partial work
- Warranty implications - partial repairs void manufacturer warranties
- Industry standards require complete system repair
- Reference specific manufacturer guidelines that prohibit spot repairs
- Uniform appearance cannot be maintained - affects property value
- Adjacent materials disturbed during repair require replacement]

================================================================================

VIII. INTERDEPENDENCY OF BUILDING SYSTEMS

[Explain how building components work together as a system:
- Underlayment system interdependency with roofing
- Flashing integration requirements at all penetrations
- Ridge and ventilation system connections
- Siding course alignment and weather barrier continuity
- How damage to one component compromises the entire system
- Why system must be addressed as a whole for proper restoration
- Reference IRC and IBC requirements for system integrity]

================================================================================

IX. WHY DAMAGED AREAS MUST BE DISTURBED FOR REPAIRS

[Explain necessary work that requires accessing adjacent areas:
- Access requirements for proper repairs
- Removal necessary to assess hidden damage
- Tie-in requirements for new materials to existing
- Building envelope integrity considerations
- Step flashing, counter flashing requirements
- Proper starter course and edge installations]

================================================================================

X. STATE AND LOCAL CODE REQUIREMENTS

[Include applicable ${stateInfo.stateName} building codes:
- International Residential Code (IRC) 2021 requirements
- ${stateInfo.stateName} specific building code adoptions
- Local jurisdiction code requirements
- How these codes mandate full replacement for proper compliance
- Reference specific code sections (e.g., IRC R905, R703)]

================================================================================

XI. MANUFACTURER INSTALLATION STANDARDS (ADOPTED BY CODE)

[Reference manufacturer requirements that have force of law:
- Specific manufacturer installation manuals
- Warranty requirements that mandate certain installation practices
- Standards that have been adopted by code
- Why partial installation violates manufacturer standards
- Reference ASTM standards for materials (D3161, D7158)
- Why aged materials cannot meet original performance specifications]

================================================================================

XII. HOW REPAIRS TRIGGER CODE UPGRADES

[Explain code upgrade requirements:
- When repairs exceed thresholds requiring full compliance
- Ordinance and Law coverage triggers
- Required upgrades per current code
- Cost implications of code upgrades
- Reference specific ${stateInfo.stateName} adoption of IRC/IBC]

================================================================================

XIII. HAAG ENGINEERING STANDARDS & INDUSTRY BEST PRACTICES

[Reference HAAG and industry standards:
- HAAG damage identification methodology
- HAAG thresholds for repair vs replacement recommendations
- NRCA (National Roofing Contractors Association) guidelines
- ARMA (Asphalt Roofing Manufacturers Association) standards
- How these industry standards support full replacement
- Reference specific damage patterns that meet replacement thresholds]

================================================================================

XIV. REBUTTAL OF CARRIER ENGINEER REPORTS (IF APPLICABLE)

[If carrier engineer reports are in the evidence, provide comprehensive rebuttal:
- Identify scope limitations in the inspection (time on site, areas inspected)
- Challenge the ASTM wind rating fallacy - lab ratings for new materials do not apply to aged shingles with degraded seal strips and UV oxidation
- Note any carrier-friendly bias in conclusions
- Identify where observations don't support conclusions
- Reference contradictory evidence from other inspections
- Note failure to consider material degradation and age factors
- Challenge desk reviews vs actual field inspections]

================================================================================

XV. COMMUNICATIONS LOG & CARRIER RESPONSE TIMELINE

[Document carrier interactions and response times:
- Timeline of all communications with carrier
- Any carrier promises or commitments made
- Deadlines mentioned by carrier representatives
- Response time analysis per ${stateInfo.adminCode}
- Any missed deadlines that constitute regulatory violations
- Bad faith indicators if applicable]

================================================================================

XVI. DETAILED REPAIR ESTIMATE EXPLANATION

[Provide line-by-line explanation of the estimate:
- Each major line item and its necessity
- Quantity and pricing justification
- Why each item is required for proper repair
- Code-required items
- Total breakdown by category
- Comparison to previous successful settlements for similar claims if available]

================================================================================

XVII. FORMAL DEMAND AND CONCLUSION

Based on the evidence documented above, including the demonstrated IRREPARABILITY of the damaged materials and the policyholder's right to INDEMNIFICATION and restoration to PRE-LOSS CONDITION, we hereby formally demand payment of the full claim value as follows:

[Include specific dollar amounts from estimates]

Response is required within thirty (30) days pursuant to ${stateInfo.promptPayAct}.

Failure to respond will result in escalation including but not limited to:
- Filing complaint with ${stateInfo.stateName} Department of Insurance
- Demand for appraisal per policy terms
- Pursuit of bad faith claim if warranted based on timeline violations documented in Communications Log

================================================================================

XVIII. SIGNATURE

Respectfully submitted,


${assignedUserName}
Licensed Public Adjuster
${companyName}
${companyAddress}
Phone: ${companyPhone}
Email: ${companyEmail}

Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

================================================================================

Create a thorough, professional demand package using ALL evidence from the provided documents. Be specific and reference actual findings, measurements, and conclusions from the documents. NEVER use the word "matching" - focus on REPAIRABILITY, UNIFORM APPEARANCE, PRE-LOSS CONDITION, and INDEMNIFICATION.`;
        break;
      }

      case 'estimate_work_summary': {
        const userInput = additionalContext?.userInput as string | undefined;
        
        systemPrompt = `You are Darwin, an expert public adjuster AI. Your task is to analyze an insurance estimate document and provide a clear, concise summary of the work that was performed or needs to be performed.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Keep the summary brief and professional.

Your summary should:
- List the main repairs or replacements in simple, understandable terms
- Focus on what was actually done or what needs to be done (e.g., "roof replacement", "siding repairs", "interior water damage restoration")
- Keep it concise - 2-4 sentences maximum
- Use language appropriate for an invoice description
- Do NOT include dollar amounts, line item codes, or technical Xactimate codes
- Write as if describing completed work on an invoice
${userInput ? `- The user has provided a brief description that you should EXPAND upon using details from the estimate` : ''}`;

        if (userInput) {
          // User provided input to expand on
          userPrompt = `${claimSummary}

${pdfContent ? `An estimate PDF has been provided for analysis.` : `ESTIMATE CONTENT:
${content || 'No estimate content provided'}`}

THE USER WROTE: "${userInput}"

Your task: Expand on the user's brief description above using specific details from the estimate document. Look at what line items, materials, and work scope are included in the estimate that relate to "${userInput}" and write a professional 2-4 sentence description suitable for an invoice.

For example, if the user wrote "roof replacement", you would look at the estimate and expand it to something like:
"Complete roof system replacement including removal and disposal of existing shingles, installation of ice and water shield, synthetic underlayment, and GAF Timberline HDZ architectural shingles. Ridge vent installation and replacement of damaged drip edge and flashing."

Now expand "${userInput}" using the actual details from this estimate:`;
        } else {
          // Auto-generate from scratch
          userPrompt = `${claimSummary}

${pdfContent ? `An estimate PDF has been provided for analysis. Review it and provide a brief summary of the work described.` : `ESTIMATE CONTENT:
${content || 'No estimate content provided'}`}

Based on the estimate, write a 2-4 sentence summary describing the repairs/replacements that were completed. This will be used in the description section of an invoice for recoverable depreciation. Keep it professional and straightforward. Example format:

"Complete roof system replacement including removal and disposal of existing shingles, installation of new underlayment and architectural shingles. Repairs to damaged gutters and downspouts. Interior water damage restoration including drywall replacement and painting in affected areas."`;
        }
        break;
      }

      case 'document_comparison': {
        // Fetch counter-arguments library for reference
        const { data: counterArgs } = await supabase
          .from('counter_arguments')
          .select('*')
          .eq('is_active', true);
        
        const counterArgsContext = counterArgs && counterArgs.length > 0 
          ? `\n\nCOUNTER-ARGUMENTS LIBRARY (use these proven rebuttals when relevant):\n${counterArgs.map((ca: any) => 
              `- ${ca.denial_category}: ${ca.denial_reason}\n  Rebuttal: ${ca.rebuttal_template}\n  Citations: ${ca.legal_citations || 'N/A'}`
            ).join('\n\n')}`
          : '';

        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in comparing insurance documents. Your role is to provide detailed line-by-line comparisons between multiple estimates or documents.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting.

CRITICAL ARGUMENT STRATEGY - REPAIRABILITY OVER MATCHING:
- NEVER argue "matching" - PA and NJ do NOT have matching requirements
- ALWAYS argue "repairability" - damaged materials CANNOT BE REPAIRED
- Focus on: structural integrity, manufacturer specs prohibit partial repairs, code compliance, material degradation

Your expertise includes:
- Xactimate line item analysis
- Identifying discrepancies between carrier and contractor estimates
- Recognizing undervalued or missing items
- Building codes and manufacturer specifications
- O&P calculations

${counterArgsContext}`;

        userPrompt = `${claimSummary}

${pdfContent ? `PDF documents have been provided for comparison. Analyze them thoroughly.` : ''}

${additionalContext?.comparisonNotes ? `USER NOTES:\n${additionalContext.comparisonNotes}` : ''}

Please provide a comprehensive document comparison that includes:

1. DOCUMENT OVERVIEW:
   - Summary of each document analyzed
   - Total values from each estimate

2. LINE-BY-LINE DISCREPANCIES:
   - Items present in one document but missing from another
   - Quantity differences for the same items
   - Unit price variations
   - Different labor rates or material costs

3. MISSING ITEMS ANALYSIS:
   - Items that should be included but are missing
   - Code-required items not present
   - Manufacturer-required components omitted

4. PRICING ANALYSIS:
   - Items where pricing appears below market
   - O&P inclusion comparison
   - Depreciation calculation differences

5. SUMMARY OF DIFFERENCES:
   - Total dollar difference
   - Number of discrepant line items
   - Key areas of disagreement

6. RECOMMENDATIONS:
   - Priority items to address
   - Supporting arguments for each discrepancy
   - Suggested next steps`;
        break;
      }

      case 'smart_extraction': {
        const docType = additionalContext?.documentType || 'estimate';
        
        // Check if PDF is large and needs native extraction
        let extractedPdfText = '';
        const smartExtractionPdf = pdfContent || '';
        const isLargePdf = smartExtractionPdf.length > AI_EXTRACTION_LIMIT;
        
        if (isLargePdf) {
          console.log(`Large PDF detected (${Math.round(smartExtractionPdf.length / 1024 / 1024)}MB base64), using native extraction first`);
          try {
            extractedPdfText = await extractTextFromPDFNative(smartExtractionPdf, pdfFileName || 'document.pdf');
          } catch (nativeError) {
            console.error('Native extraction failed for large PDF:', nativeError);
            throw new Error(`This PDF is too large for AI processing and native text extraction failed. The PDF may be scanned/image-based. Please use a smaller file (<8MB) for scanned documents, or ensure the PDF has selectable text.`);
          }
        }
        
        systemPrompt = `You are Darwin, an expert AI specializing in extracting structured data from insurance claim documents. Your role is to parse PDFs and extract key financial and line item data into a structured format.

FORMATTING REQUIREMENT: Return a JSON object with the extracted data. Do NOT include markdown code blocks or any other formatting - just the raw JSON.

For ${docType} documents, extract:
- RCV (Replacement Cost Value) total
- ACV (Actual Cash Value) total  
- Deductible amount
- Depreciation amount
- All line items with: description, quantity, unit, unit price, total, category

Be precise with numbers. If a value is not present, omit it from the response.`;

        userPrompt = `${claimSummary}

DOCUMENT TYPE: ${docType}

${isLargePdf && extractedPdfText ? `EXTRACTED DOCUMENT TEXT:
${extractedPdfText.substring(0, 100000)}

Extract all structured data from the text above.` : pdfContent ? `A PDF document has been provided. Extract all structured data from it.` : `DOCUMENT CONTENT:\n${content || 'No content provided'}`}

Extract all financial data and line items from this document. Return a JSON object with this structure:
{
  "rcv_total": number or null,
  "acv_total": number or null,
  "deductible": number or null,
  "depreciation": number or null,
  "line_items": [
    {
      "description": "string",
      "quantity": number or null,
      "unit": "string or null",
      "unitPrice": number or null,
      "total": number or null,
      "category": "string or null"
    }
  ]
}

Return ONLY the JSON object, no additional text or formatting.`;
        
        // For large PDFs, we've extracted text so don't use multimodal
        if (isLargePdf) {
          additionalContext._useTextOnly = true;
        }
        break;
      }

      case 'weakness_detection': {
        // Fetch all claim documentation for analysis
        const { data: claimFiles } = await supabase
          .from('claim_files')
          .select('file_name, file_type, folder_id')
          .eq('claim_id', claimId);

        const { data: claimPhotos } = await supabase
          .from('claim_photos')
          .select('file_name, category, description')
          .eq('claim_id', claimId);

        const { data: claimNotes } = await supabase
          .from('claim_notes')
          .select('content, created_at')
          .eq('claim_id', claimId)
          .order('created_at', { ascending: false })
          .limit(10);

        // Fetch counter-arguments for known denial patterns
        const { data: counterArgs } = await supabase
          .from('counter_arguments')
          .select('denial_category, denial_reason, denial_keywords')
          .eq('is_active', true);

        const denialPatterns = counterArgs?.map((ca: any) => ca.denial_category).join(', ') || '';

        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in proactive claim review. Your role is to identify weaknesses, gaps, and vulnerabilities in a claim BEFORE the insurance carrier does.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting.

You understand:
- Common denial reasons and how carriers find weaknesses
- Documentation requirements for successful claims
- Evidence gaps that carriers exploit
- Timeline and deadline concerns
- ${stateInfo.stateName} insurance regulations

KNOWN DENIAL PATTERNS TO CHECK FOR:
${denialPatterns}

Be thorough but actionable. Every weakness should have a recommended fix.`;

        const filesSummary = claimFiles?.map((f: any) => f.file_name).join(', ') || 'No files uploaded';
        const photosSummary = claimPhotos?.map((p: any) => `${p.file_name} (${p.category || 'uncategorized'})`).join(', ') || 'No photos uploaded';
        const notesSummary = claimNotes?.map((n: any) => n.content?.substring(0, 100)).join('\n') || 'No notes';

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName}

CURRENT CLAIM DOCUMENTATION:
Files: ${filesSummary}
Photos: ${photosSummary}

RECENT NOTES:
${notesSummary}

${additionalContext?.focusAreas ? `USER-SPECIFIED FOCUS AREAS:\n${additionalContext.focusAreas}` : ''}

Analyze this claim and identify ALL weaknesses that could lead to denial, underpayment, or delays. For each weakness:

1. DOCUMENTATION GAPS:
   - Missing required documents
   - Incomplete documentation
   - Suggested documents to obtain

2. EVIDENCE WEAKNESSES:
   - Photo documentation gaps
   - Missing expert opinions
   - Lack of supporting evidence for claimed damage

3. TIMELINE CONCERNS:
   - Deadline risks under ${stateInfo.adminCode}
   - Statute of limitations issues
   - Prompt payment compliance

4. CLAIM PRESENTATION ISSUES:
   - Scope of loss concerns
   - Pricing vulnerabilities
   - Arguments carrier may use against claim

5. REGULATORY COMPLIANCE:
   - ${stateInfo.stateName} specific requirements
   - Policy compliance issues

6. PRIORITY ACTIONS:
   - Immediate fixes needed (high priority)
   - Important improvements (medium priority)
   - Nice-to-have enhancements (low priority)

Be specific and actionable. For each weakness, explain why it's a problem and exactly how to fix it.`;
        break;
      }

      case 'photo_linking': {
        // AI-powered photo to estimate line item linking
        systemPrompt = `You are Darwin, an expert in analyzing claim photos and matching them to estimate line items. Your role is to identify which photos correspond to which damaged items in an insurance estimate.

FORMATTING REQUIREMENT: Return ONLY valid JSON. No markdown, no explanations.

You understand:
- Construction terminology and damage types
- Photo categorization (roof, siding, interior, etc.)
- How to match visual evidence to line item descriptions
- Common roofing, siding, window, and interior damage patterns

Return a JSON object with a "matches" array containing objects with:
- photo_id: the ID of the photo
- line_item_index: the index of the matching line item
- confidence: a number between 0 and 1 indicating match confidence
- reason: brief explanation of why this photo matches this line item`;

        const photos = additionalContext?.photos || [];
        const lineItems = additionalContext?.lineItems || [];

        userPrompt = `Match these claim photos to the estimate line items based on file names, categories, descriptions, and logical associations.

PHOTOS:
${photos.map((p: any) => `- ID: ${p.id}, Name: ${p.name}, Category: ${p.category || 'none'}, Description: ${p.description || 'none'}`).join('\n')}

ESTIMATE LINE ITEMS:
${lineItems.map((item: any, idx: number) => `- Index ${idx}: ${item.description}${item.amount ? ` ($${item.amount})` : ''}`).join('\n')}

Return a JSON object with a "matches" array. Only include confident matches (confidence > 0.6). Each match should have: photo_id, line_item_index, confidence, reason.`;
        break;
      }

      case 'code_lookup': {
        // AI-powered building code and manufacturer spec lookup
        const searchQuery = content || '';
        
        // Fetch relevant codes and specs from database
        const { data: relevantCodes } = await supabase
          .from('building_code_citations')
          .select('*')
          .or(`content.ilike.%${searchQuery}%,section_title.ilike.%${searchQuery}%`)
          .limit(10);

        const { data: relevantSpecs } = await supabase
          .from('manufacturer_specs')
          .select('*')
          .or(`content.ilike.%${searchQuery}%,manufacturer.ilike.%${searchQuery}%,product_name.ilike.%${searchQuery}%`)
          .limit(10);

        systemPrompt = `You are Darwin, an expert in building codes and manufacturer specifications for insurance claims. Your role is to find and cite relevant codes and specifications that support claim arguments.

IMPORTANT: This claim is located in ${stateInfo.stateName}. Reference ${stateInfo.stateName}-adopted codes.

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting.

CRITICAL ARGUMENT STRATEGY - REPAIRABILITY OVER MATCHING:
- Focus on code requirements that mandate full replacement vs partial repair
- Cite manufacturer specs that prohibit mixing old and new materials
- Reference installation requirements that cannot be met with partial repairs
- Emphasize code compliance issues that require full scope replacement

You have access to these relevant codes and specifications:

BUILDING CODES:
${relevantCodes?.map((c: any) => `${c.code_source} ${c.code_year} ${c.section_number}: ${c.section_title || ''}\n${c.content}`).join('\n\n') || 'No matching codes found in database.'}

MANUFACTURER SPECIFICATIONS:
${relevantSpecs?.map((s: any) => `${s.manufacturer} ${s.product_name || s.product_category} (${s.spec_type}):\n${s.content}`).join('\n\n') || 'No matching specs found in database.'}`;

        userPrompt = `${claimSummary}

SEARCH QUERY: ${searchQuery}

LOSS TYPE: ${claim.loss_type || 'Unknown'}
LOSS DESCRIPTION: ${claim.loss_description || 'Not provided'}

Based on the search query and claim context, provide:

1. RELEVANT BUILDING CODE CITATIONS:
   - Specific code sections that apply
   - How they support full replacement arguments
   - Code requirements that cannot be met with partial repairs

2. MANUFACTURER SPECIFICATION REFERENCES:
   - Installation requirements that mandate full system installation
   - Warranty provisions that are voided by partial repairs
   - Technical specifications requiring matching components

3. APPLICATION TO THIS CLAIM:
   - How these codes/specs support the claim
   - Specific arguments to use with the carrier
   - Documentation needed to prove compliance requirements

Be specific with citations and provide actionable information for claim negotiation.`;
        break;
      }

      case 'smart_follow_ups': {
        // AI-powered follow-up recommendation generation
        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in claim workflow optimization. Your role is to analyze claim status and recommend strategic follow-up actions.

FORMATTING REQUIREMENT: Return ONLY valid JSON. No markdown, no explanations.

You understand:
- Insurance claim timelines and carrier response patterns
- Regulatory deadlines for ${stateInfo.stateName} (${stateInfo.adminCode})
- Best practices for claim communication cadence
- When to escalate vs. when to wait

Return a JSON object with a "recommendations" array. Each recommendation should have:
- type: 'call' | 'email' | 'document_request' | 'inspection_schedule' | 'escalation'
- priority: 'low' | 'medium' | 'high' | 'critical'
- date: ISO date string for when to perform the follow-up
- reason: explanation of why this follow-up is needed
- recipient: 'adjuster' | 'carrier' | 'client' | 'contractor'
- confidence: number between 0.5 and 1.0`;

        userPrompt = `${claimSummary}

DAYS SINCE LOSS: ${claim.loss_date ? Math.floor((Date.now() - new Date(claim.loss_date).getTime()) / (1000 * 60 * 60 * 24)) : 'Unknown'}
DAYS SINCE LAST ACTIVITY: ${context.emails?.length > 0 ? Math.floor((Date.now() - new Date(context.emails[0].created_at).getTime()) / (1000 * 60 * 60 * 24)) : 'Unknown'}

Based on this claim's current state, generate 3-5 strategic follow-up recommendations. Consider:
1. Regulatory deadlines under ${stateInfo.adminCode}
2. Time since last carrier communication
3. Pending tasks and their due dates
4. Inspection status and scheduling needs
5. Document request opportunities
6. Escalation triggers

Return JSON with a "recommendations" array.`;
        break;
      }

      case 'task_generation': {
        // AI-powered task suggestion based on claim analysis
        systemPrompt = `You are Darwin, an expert public adjuster AI that helps staff stay organized by suggesting relevant tasks. Your role is to analyze claim status and recommend actionable tasks.

FORMATTING REQUIREMENT: Return ONLY valid JSON. No markdown, no explanations.

You understand:
- Public adjusting workflows and best practices
- Insurance claim milestones and deliverables
- ${stateInfo.stateName} regulatory requirements
- Document preparation and submission timelines

Return a JSON object with a "tasks" array. Each task should have:
- title: concise task title (max 60 chars)
- description: brief description of what needs to be done
- due_date: ISO date string (YYYY-MM-DD format)
- priority: 'low' | 'medium' | 'high'
- reason: why this task is needed based on claim analysis`;

        const daysSinceLoss = claim.loss_date ? Math.floor((Date.now() - new Date(claim.loss_date).getTime()) / (1000 * 60 * 60 * 24)) : null;
        const pendingTasks = context.tasks?.filter((t: any) => t.status === 'pending' || t.status === 'in_progress') || [];

        userPrompt = `${claimSummary}

CURRENT PENDING TASKS:
${pendingTasks.map((t: any) => `- ${t.title} (${t.status}, due: ${t.due_date || 'no date'})`).join('\n') || 'No pending tasks'}

DAYS SINCE LOSS: ${daysSinceLoss || 'Unknown'}
CLAIM AGE: ${claim.created_at ? Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 'Unknown'} days

Based on this claim's current state and what tasks already exist, suggest 3-5 NEW tasks that should be created. Consider:
1. Missing documentation that should be gathered
2. Follow-up communications needed
3. Deadline-driven tasks based on ${stateInfo.stateName} regulations
4. Next logical steps based on claim status
5. Quality control and review tasks

Do NOT suggest tasks that duplicate existing pending tasks.

Return JSON with a "tasks" array.`;
        break;
      }

      case 'outcome_prediction': {
        // AI-powered claim outcome prediction
        const totalChecksReceived = context.checks?.reduce((sum: number, c: any) => sum + (c.amount || 0), 0) || 0;
        const latestSettlement = context.settlements?.[0];
        const rcv = latestSettlement?.replacement_cost_value || claim.claim_amount || 0;

        systemPrompt = `You are Darwin, an expert public adjuster AI with deep knowledge of claim outcomes and settlement patterns. Your role is to predict likely claim outcomes based on available data.

FORMATTING REQUIREMENT: Return ONLY valid JSON. No markdown, no explanations.

You understand:
- Settlement patterns for ${stateInfo.stateName} claims
- How claim characteristics affect outcomes
- Risk factors that reduce settlements
- Opportunity factors that increase settlements
- Typical timelines for different claim types

Return a JSON object with a "prediction" object containing:
- settlement_low: minimum expected settlement (number)
- settlement_high: maximum expected settlement (number)
- settlement_likely: most probable settlement (number)
- probability: confidence in prediction (0.5 to 0.95)
- timeline_days: expected days to resolution (number)
- risks: array of risk factor strings
- opportunities: array of opportunity factor strings
- notes: brief analysis summary`;

        userPrompt = `${claimSummary}

FINANCIAL DATA:
- Claim Amount / RCV: $${rcv.toLocaleString()}
- Deductible: $${latestSettlement?.deductible?.toLocaleString() || 'Unknown'}
- Recoverable Depreciation: $${latestSettlement?.recoverable_depreciation?.toLocaleString() || 'Unknown'}
- Total Checks Received: $${totalChecksReceived.toLocaleString()}
- Remaining to Collect: $${Math.max(0, rcv - totalChecksReceived).toLocaleString()}

CLAIM CHARACTERISTICS:
- Loss Type: ${claim.loss_type || 'Unknown'}
- Insurance Company: ${claim.insurance_company || 'Unknown'}
- Current Status: ${claim.status || 'Unknown'}
- Days Since Loss: ${claim.loss_date ? Math.floor((Date.now() - new Date(claim.loss_date).getTime()) / (1000 * 60 * 60 * 24)) : 'Unknown'}
- Has Inspection: ${context.inspections?.length > 0 ? 'Yes' : 'No'}
- Communication Count: ${context.emails?.length || 0} emails

Based on this data, predict the likely outcome of this claim. Consider:
1. Typical settlement percentages for this loss type
2. Carrier behavior patterns
3. Documentation strength
4. Timeline compliance
5. Claim complexity

Return JSON with a "prediction" object.`;
        break;
      }

      case 'carrier_email_draft': {
        // AI-powered carrier email drafting
        const emailType = additionalContext?.emailType || 'status_inquiry';
        const emailTypeLabel = additionalContext?.emailTypeLabel || 'Status Inquiry';
        const userContext = additionalContext?.userContext || '';

        systemPrompt = `You are Darwin, an expert public adjuster AI specializing in professional carrier communications. Your emails are:
- Professional and firm but not aggressive
- Compliant with ${stateInfo.stateName} insurance regulations
- Strategic - advancing the claim while documenting the carrier's obligations
- Reference specific deadlines and regulations when appropriate

FORMATTING REQUIREMENT: Return the email in this exact format:
SUBJECT: [subject line]
BODY: [full email body]

Include qualifying language where appropriate (e.g., "pending further investigation", "subject to revision").
Reference claim number and policy number in the subject line.
Include specific dates and deadlines based on ${stateInfo.adminCode}.`;

        const emailTypePrompts: Record<string, string> = {
          'status_inquiry': 'Request an update on the current status of the claim, referencing the time elapsed and any pending items.',
          'document_submission': 'Write a cover letter for document submission, listing what is being submitted and requesting acknowledgment.',
          'deadline_reminder': `Remind the carrier of regulatory deadlines under ${stateInfo.adminCode}, noting any approaching or missed deadlines.`,
          'payment_follow_up': 'Follow up on a pending payment, referencing the approval and requesting payment timeline.',
          'dispute_response': 'Respond to a carrier dispute or partial denial, presenting counter-arguments professionally.',
          'inspection_request': 'Request a re-inspection or joint inspection, explaining why it is necessary.',
          'supplement_submission': 'Submit supplemental claim documentation with a cover letter explaining the additional items.',
          'bad_faith_warning': `Issue a formal notice of potential bad faith violations under ${stateInfo.promptPayAct}, documenting specific violations.`,
        };

        userPrompt = `${claimSummary}

EMAIL TYPE: ${emailTypeLabel}
PURPOSE: ${emailTypePrompts[emailType] || emailTypePrompts['status_inquiry']}

${userContext ? `ADDITIONAL CONTEXT FROM USER:\n${userContext}\n` : ''}

Write a professional email to the insurance carrier for this ${emailTypeLabel.toLowerCase()}. 
The email should be from the public adjuster on behalf of the policyholder.
Include appropriate regulatory references for ${stateInfo.stateName}.
Address the email to the adjuster (${claim.adjuster_name || 'Claims Adjuster'}) at ${claim.insurance_company || 'the insurance company'}.`;
        break;
      }

      case 'one_click_package': {
        // Compile comprehensive claim package with Darwin analyses
        const components = additionalContext?.components || [];
        const darwinAnalyses = additionalContext?.darwinAnalyses || [];
        
        // Build Darwin analyses section for the package
        let darwinAnalysesSection = '';
        if (darwinAnalyses.length > 0) {
          darwinAnalysesSection = `\n\nDARWIN AI ANALYSES & REBUTTALS TO INCLUDE:\n`;
          darwinAnalysesSection += `The following ${darwinAnalyses.length} Darwin-generated analyses should be incorporated as formal rebuttals and supporting documentation:\n\n`;
          
          darwinAnalyses.forEach((analysis: any, index: number) => {
            darwinAnalysesSection += `=== ${analysis.type.toUpperCase()} (${new Date(analysis.date).toLocaleDateString()}) ===\n`;
            if (analysis.summary) {
              darwinAnalysesSection += `Source Document: ${analysis.summary}\n`;
            }
            darwinAnalysesSection += `\n${analysis.content}\n\n`;
            darwinAnalysesSection += `${'─'.repeat(80)}\n\n`;
          });
        }
        
        systemPrompt = `You are Darwin, an expert public adjuster AI. Your task is to compile a comprehensive claim package that serves as a FORMAL SUBMISSION to the insurance carrier.

=== CRITICAL REQUIREMENTS ===
1. When Darwin analyses/rebuttals are included, they form the CORE of this package
2. Structure the package as a formal demand/rebuttal document
3. The rebuttals should be presented as professional, referenced arguments
4. Include all supporting data (claim details, financials) as context for the rebuttals
5. Format as a professional legal-style document ready for carrier submission
6. IMPORTANT: When photos are included, REFERENCE THEM AS EVIDENCE throughout the document
   - Cite specific photos by name when discussing damage
   - Group photo evidence by damage type (hail, wind, water, etc.)
   - Note dates photos were taken to establish timeline of damage
   - Use photos to corroborate claims in rebuttals

=== DOCUMENT STRUCTURE ===
If Darwin rebuttals are included, structure as:
1. COVER LETTER - Professional introduction stating purpose of package
2. CLAIM SUMMARY - Key claim facts and current status  
3. PHOTOGRAPHIC EVIDENCE - Detailed inventory of all photos with descriptions, organized by damage type
4. FORMAL REBUTTALS & DEMANDS - Present each Darwin analysis as a formal section, REFERENCING specific photos as supporting evidence
5. SUPPORTING DOCUMENTATION - List of attached evidence
6. FINANCIAL SUMMARY - Amounts claimed and calculations
7. CONCLUSION & DEMANDS - Clear statement of what is being requested

Use professional legal formatting with proper section numbering.
Each rebuttal should be presented as a formal argument with citations preserved.
When discussing damage, ALWAYS reference the specific photos that document it.`;

        // Build detailed photo documentation section
        let photoDocumentation = '';
        if (additionalContext?.includePhotos && context.photos?.length > 0) {
          photoDocumentation = `\n\n=== PHOTOGRAPHIC EVIDENCE (${context.photos.length} photos) ===\n`;
          photoDocumentation += `These photos document the damage and support the claim:\n\n`;
          
          // Group photos by category
          const photosByCategory: Record<string, any[]> = {};
          context.photos.forEach((photo: any) => {
            const category = photo.category || 'Uncategorized';
            if (!photosByCategory[category]) {
              photosByCategory[category] = [];
            }
            photosByCategory[category].push(photo);
          });
          
          Object.entries(photosByCategory).forEach(([category, photos]) => {
            photoDocumentation += `\n**${category}** (${photos.length} photos):\n`;
            photos.forEach((photo: any) => {
              photoDocumentation += `  - ${photo.file_name}`;
              if (photo.description) {
                photoDocumentation += `: ${photo.description}`;
              }
              if (photo.taken_at) {
                photoDocumentation += ` (taken: ${new Date(photo.taken_at).toLocaleDateString()})`;
              }
              photoDocumentation += `\n`;
            });
          });
          
          photoDocumentation += `\nIMPORTANT: Reference these photos as evidence when presenting rebuttals. Photos documenting hail damage, storm damage, or other loss conditions are critical supporting evidence.\n`;
        }

        userPrompt = `${claimSummary}

REQUESTED COMPONENTS: ${components.join(', ')}
${photoDocumentation}
${additionalContext?.includeDocuments ? `\nDOCUMENTS ON FILE: ${context.files?.filter((f: any) => !f.file_type?.startsWith('image/'))?.length || 0} documents available` : ''}
${additionalContext?.includeCommunications && context.emails?.length > 0 ? `\nCOMMUNICATIONS TIMELINE (${context.emails.length} emails):\n${context.emails.map((e: any) => `--- EMAIL ${e.direction === 'outbound' ? 'SENT' : 'RECEIVED'} (${new Date(e.sent_at || e.created_at).toLocaleDateString()}) ---\nFrom: ${e.from_address || e.sent_by || 'Unknown'}\nTo: ${e.to_address || e.recipient_email || 'Unknown'}\nSubject: ${e.subject || 'No Subject'}\n${e.body ? e.body.substring(0, 2000) : 'No body'}\n`).join('\n')}` : ''}
${additionalContext?.includeInspections ? `\nINSPECTIONS:\n${context.inspections?.map((i: any) => `- ${i.inspection_type}: ${i.inspection_date} (${i.status})`).join('\n') || 'None scheduled'}` : ''}
${darwinAnalysesSection}

${darwinAnalyses.length > 0 ? `
IMPORTANT: This package includes ${darwinAnalyses.length} Darwin-generated rebuttals/analyses. 
You MUST:
1. Present these as formal, professional rebuttals addressed to the carrier
2. Preserve all citations, code references, and technical arguments
3. Structure them under clear section headers (e.g., "SECTION 3: REBUTTAL TO ENGINEER REPORT")
4. Include a cover letter explaining this is a formal response with supporting documentation
5. End with a clear DEMANDS section stating what the carrier must do

Compile this as a FORMAL CARRIER SUBMISSION PACKAGE, not just a summary.
` : `
Compile a comprehensive claim package summary including:
1. Executive Summary - Current claim status and key metrics
2. Claim Details - All relevant claim information
3. Financial Summary - Settlement data, checks received, amounts outstanding
4. Documentation Inventory - List of all files and photos
5. Communication Timeline - Summary of carrier correspondence
6. Next Steps - Recommended actions and pending items
`}

Format this as a professional document ready for carrier submission.`;
        break;
      }

      case 'auto_summary': {
        // Auto-generated claim summary with key facts
        systemPrompt = `You are Darwin, an expert public adjuster AI. Generate a comprehensive yet concise claim summary.

FORMATTING REQUIREMENT: Return ONLY valid JSON with this structure:
{
  "id": "summary_[timestamp]",
  "created_at": "[ISO date]",
  "summary": "2-3 paragraph executive summary",
  "key_facts": ["fact 1", "fact 2", ...],
  "next_actions": ["action 1", "action 2", ...],
  "risk_factors": ["risk 1", "risk 2", ...],
  "estimated_value": {
    "low": number,
    "likely": number,
    "high": number
  }
}`;

        const totalChecksReceived = context.checks?.reduce((sum: number, c: any) => sum + (c.amount || 0), 0) || 0;
        const latestSettlement = context.settlements?.[0];

        userPrompt = `${claimSummary}

ADDITIONAL DATA:
- Total Checks Received: $${totalChecksReceived.toLocaleString()}
- Documents on File: ${context.files?.length || 0}
- Photos on File: ${context.files?.filter((f: any) => f.file_type?.startsWith('image/'))?.length || 0}

Generate a comprehensive claim summary in the specified JSON format. Include:
1. Executive summary of the claim status and key issues
2. 5-7 key facts about the claim
3. 3-5 recommended next actions
4. Any risk factors that could affect the outcome
5. Estimated claim value range based on available data

Return ONLY valid JSON.`;
        break;
      }

      case 'claim_analysis': {
        systemPrompt = `You are Darwin, an expert public adjuster AI. Produce a clear, structured claim analysis. Write in plain prose: no markdown symbols, no bullet asterisks, no hash headers. Use normal paragraphs and clear section breaks.

Include: executive summary, timeline of key events, strengths, issues, root causes, missed opportunities, recommended process changes, and metrics to track. Write in a clean, professional tone.`;
        userPrompt = `${claimSummary}\n\n${claimFactsPackContext}\n\nGenerate the claim analysis in plain paragraphs.`;
        break;
      }

      case 'operating_manual': {
        systemPrompt = `You are Darwin. Turn this claim's handling into an operating manual with scenarios and mini trainings. Write in plain prose: no markdown symbols, no bullet asterisks. Use normal paragraphs.

Include: overview, then for each scenario: trigger signals, goals, step-by-step actions, communication scripts, escalation rules, and a short mini-training. Write in a clean, professional tone.`;
        userPrompt = `${claimSummary}\n\n${claimFactsPackContext}\n\nGenerate the operating manual in plain paragraphs.`;
        break;
      }

      case 'case_study': {
        systemPrompt = `You are Darwin. Write a case study from this claim. Use generic terms only: do NOT include real names, addresses, emails, phone numbers, claim numbers, or policy numbers. Use "the policyholder", "the carrier", "the adjuster". Write in plain prose: no markdown symbols. Use normal paragraphs.`;
        userPrompt = `${claimSummary}\n\n${claimFactsPackContext}\n\nGenerate the case study in plain paragraphs. Omit all identifying details.`;
        break;
      }

      case 'marketing_assets': {
        systemPrompt = `You are Darwin. Turn the claim summary into marketing assets: blog title and body, Facebook post, Instagram caption, TikTok script. No PII. Write in plain prose with clear section labels; no markdown symbols.`;
        userPrompt = `${claimSummary}\n\n${claimFactsPackContext}\n\nGenerate marketing assets in plain text. No identifying details.`;
        break;
      }

      case 'compliance_check': {
        // Compliance-aware messaging checker
        const textToCheck = additionalContext?.text || content || '';
        const state = claim?.policyholder_state || stateInfo.state;
        
        systemPrompt = `You are Darwin, an expert public adjuster compliance advisor for ${stateInfo.stateName}. 
You analyze communications for compliance issues, risky language, and professional best practices.

Your task is to identify any language that could:
1. Constitute unauthorized practice of law (UPL)
2. Make guarantees or promises that can't be kept
3. Allege bad faith without proper documentation
4. Use emotional or unprofessional language
5. Make improper coverage determinations
6. Violate ${stateInfo.stateName} insurance regulations

Return ONLY valid JSON with this structure:
{
  "issues": [
    {
      "severity": "error|warning|info",
      "category": "Category name",
      "originalText": "The problematic text",
      "issue": "Description of the issue",
      "suggestion": "Recommended alternative",
      "regulation": "Relevant regulation reference if any"
    }
  ],
  "overallScore": "compliant|needs_review|risky",
  "summary": "Brief overall assessment"
}`;

        userPrompt = `Analyze this communication for compliance issues:

---
${textToCheck}
---

State: ${stateInfo.stateName}
Applicable Regulations: ${stateInfo.adminCode}

Return ONLY valid JSON with any compliance issues found.`;
        break;
      }

      case 'document_classify': {
        // Document classification for smart sorting
        const fileName = additionalContext?.fileName || '';
        const fileSize = additionalContext?.fileSize || 0;
        
        systemPrompt = `You are Darwin, an expert document classifier for insurance claims.
Based on the file name and context, classify this document into one of these categories:
- Policy Documents
- Correspondence
- Estimates
- Photos
- Invoices
- Inspection Reports
- Legal Documents
- Contracts
- Weather Reports
- Engineering Reports
- Other

Return ONLY valid JSON with this structure:
{
  "classification": {
    "folder": "Category name",
    "type": "Specific document type",
    "confidence": 0.0-1.0,
    "sender": "Sender if identifiable",
    "date": "Date if identifiable",
    "topic": "Brief topic description"
  }
}`;

        userPrompt = `Classify this document:
File Name: ${fileName}
File Size: ${fileSize} bytes
Claim Type: ${claim?.loss_type || 'Property damage'}
Insurance Company: ${claim?.insurance_company || 'Unknown'}

Return ONLY valid JSON with the classification.`;
        break;
      }

      case 'auto_draft_rebuttal': {
        // Comprehensive rebuttal using all claim intelligence
        const strategicData = additionalContext?.strategicInsights || {};
        const previousAnalyses = additionalContext?.darwinAnalyses || [];
        const carrierBehavior = additionalContext?.carrierProfile || {};
        const fileList = additionalContext?.claimFiles || [];
        const aiPhotoAnalysis = additionalContext?.aiPhotoAnalysis || [];
        const photoAnalysisSummary = additionalContext?.photoAnalysisSummary || {};
        const proximityPrecedents = additionalContext?.proximityPrecedents || [];
        
        // Fetch multiple knowledge base categories for comprehensive coverage
        const [kbRebuttal, kbBuildingCodes, kbDenialTactics] = await Promise.all([
          searchKnowledgeBase(
            supabase,
            'rebuttal strategy insurance claim denial depreciation coverage policy building codes manufacturer specifications',
          ),
          searchKnowledgeBase(
            supabase,
            `${claim.loss_type || 'roof hail wind'} damage IRC IBC building code requirements ASTM ARMA standards`,
            'building-codes',
          ),
          searchKnowledgeBase(
            supabase,
            'carrier denial tactics wear tear pre-existing maintenance exclusion bad faith unfair claims practices',
          ),
        ]);
        
        // Combine all knowledge base content
        const combinedKnowledge = [kbRebuttal, kbBuildingCodes, kbDenialTactics].filter(Boolean).join('\n');

        // Fetch full claim files with classifications AND extracted text for evidence citation
        const { data: fullClaimFiles } = await supabase
          .from('claim_files')
          .select('file_name, document_classification, classification_metadata, uploaded_at, claim_folders(name), extracted_text, file_type')
          .eq('claim_id', claimId);
        
        // Build detailed document inventory for citations
        let documentInventory = '';
        let documentContentSection = '';
        
        if (fullClaimFiles && fullClaimFiles.length > 0) {
          // Categorize ALL document types for comprehensive evidence
          const fileNameLower = (f: any) => f.file_name?.toLowerCase() || '';
          
          const estimates = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'estimate' || 
            fileNameLower(f).includes('estimate') ||
            fileNameLower(f).includes('xactimate') ||
            fileNameLower(f).includes('symbility')
          );
          const denials = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'denial' || 
            fileNameLower(f).includes('denial')
          );
          const engineerReports = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'engineering_report' || 
            fileNameLower(f).includes('engineer')
          );
          const policies = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'policy' || 
            fileNameLower(f).includes('policy') || 
            fileNameLower(f).includes('declaration')
          );
          // NEW: Storm reports, weather data
          const stormReports = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'storm_report' ||
            f.document_classification === 'weather_report' ||
            fileNameLower(f).includes('storm') ||
            fileNameLower(f).includes('weather') ||
            fileNameLower(f).includes('hail') ||
            fileNameLower(f).includes('wind') ||
            fileNameLower(f).includes('nws') ||
            fileNameLower(f).includes('noaa')
          );
          // NEW: Inspection reports
          const inspectionReports = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'inspection' ||
            f.document_classification === 'inspection_report' ||
            fileNameLower(f).includes('inspection') ||
            fileNameLower(f).includes('roof report')
          );
          // NEW: Before/pre-storm photos and condition documentation
          const beforePhotos = fullClaimFiles.filter((f: any) => 
            fileNameLower(f).includes('before') ||
            fileNameLower(f).includes('pre-storm') ||
            fileNameLower(f).includes('prestorm') ||
            fileNameLower(f).includes('prior') ||
            fileNameLower(f).includes('original condition') ||
            fileNameLower(f).includes('overview')
          );
          // NEW: Contractor opinions/bids
          const contractorDocs = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'contractor' ||
            fileNameLower(f).includes('contractor') ||
            fileNameLower(f).includes('bid') ||
            fileNameLower(f).includes('quote') ||
            fileNameLower(f).includes('proposal')
          );
          // NEW: Correspondence from/to carrier
          const correspondence = fullClaimFiles.filter((f: any) => 
            f.document_classification === 'correspondence' ||
            fileNameLower(f).includes('letter') ||
            fileNameLower(f).includes('email') ||
            fileNameLower(f).includes('response')
          );
          
          documentInventory = `
=== DOCUMENTS AVAILABLE FOR CITATION (${fullClaimFiles.length} files) ===
CRITICAL: Reference these documents by name to support your arguments.

${stormReports.length > 0 ? `STORM/WEATHER REPORTS (${stormReports.length}) - USE FOR CAUSATION:
${stormReports.map((f: any) => `- ${f.file_name} (uploaded ${new Date(f.uploaded_at).toLocaleDateString()})`).join('\n')}
` : ''}
${beforePhotos.length > 0 ? `BEFORE/PRE-STORM PHOTOS (${beforePhotos.length}) - PROVES PRE-LOSS CONDITION:
${beforePhotos.map((f: any) => `- ${f.file_name} (uploaded ${new Date(f.uploaded_at).toLocaleDateString()})`).join('\n')}
` : ''}
${inspectionReports.length > 0 ? `INSPECTION REPORTS (${inspectionReports.length}):
${inspectionReports.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
${estimates.length > 0 ? `ESTIMATES (${estimates.length}):
${estimates.map((f: any) => {
  const meta = f.classification_metadata || {};
  const amounts = (meta as any).amounts || [];
  const amountStr = amounts.length > 0 ? ` - Amounts: ${amounts.map((a: any) => '$' + (a.amount || 0).toLocaleString()).join(', ')}` : '';
  return `- ${f.file_name}${amountStr}`;
}).join('\n')}
` : ''}
${denials.length > 0 ? `DENIAL LETTERS (${denials.length}):
${denials.map((f: any) => {
  const meta = f.classification_metadata || {};
  return `- ${f.file_name} - Summary: ${(meta as any).summary || 'No summary'}`;
}).join('\n')}
` : ''}
${engineerReports.length > 0 ? `ENGINEER REPORTS (${engineerReports.length}):
${engineerReports.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
${policies.length > 0 ? `POLICY DOCUMENTS (${policies.length}):
${policies.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
${contractorDocs.length > 0 ? `CONTRACTOR DOCUMENTS (${contractorDocs.length}):
${contractorDocs.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
${correspondence.length > 0 ? `CORRESPONDENCE (${correspondence.length}):
${correspondence.map((f: any) => `- ${f.file_name}`).join('\n')}
` : ''}
ALL FILES:
${fullClaimFiles.map((f: any) => `- ${f.file_name} [${f.document_classification || 'Unclassified'}] ${f.claim_folders?.name ? `(Folder: ${f.claim_folders.name})` : ''}`).join('\n')}
`;

          // NEW: Include extracted text content from critical documents for Darwin to read
          const criticalDocs = [...stormReports, ...inspectionReports, ...denials, ...engineerReports].filter(f => f.extracted_text);
          if (criticalDocs.length > 0) {
            documentContentSection = `
=== DOCUMENT CONTENT (from OCR/extraction) ===
CRITICAL: This is the actual text content from key documents. Use this to cite specific findings, quotes, and data.

`;
            for (const doc of criticalDocs.slice(0, 8)) { // Limit to prevent token overflow
              const textContent = doc.extracted_text?.substring(0, 4000) || '';
              if (textContent.length > 100) {
                documentContentSection += `\n--- ${doc.file_name} [${doc.document_classification || 'Document'}] ---\n${textContent}\n\n`;
              }
            }
          }
        }

        systemPrompt = `You are Darwin, an elite public adjuster AI generating a COMPREHENSIVE STRATEGIC REBUTTAL to OVERTURN the carrier's denial and secure coverage. You have access to ALL claim intelligence, strategic analyses, carrier behavior data, previous Darwin analyses, and the complete evidence file for this claim.

${getMandatoryFramework()}

=== YOUR MISSION ===
The carrier has denied or undervalued this claim. Your job is to compile an OVERWHELMING case using every piece of available evidence to prove they are WRONG and coverage MUST be afforded. Leave them no defensible position.

=== COMMUNICATION STYLE ===
You are professional yet personable. Show empathy for the policyholder while being ASSERTIVE and UNEQUIVOCAL when dealing with carriers. This is a formal demand letter—be thorough, cite everything, and leave no doubt about the correct outcome.

=== CRITICAL REBUTTAL PHILOSOPHY ===
STEP 1 - COVERAGE FIRST (PRIMARY FOCUS FOR DENIALS):
When the carrier has DENIED coverage, your PRIMARY focus must be:
1. POLICY LANGUAGE: Prove the loss is covered under the policy terms
2. OBSERVED DAMAGE: Document that covered damage EXISTS and was caused by a covered peril
3. CAUSATION: Connect the damage to the reported loss event (weather data, timeline, damage patterns)

DO NOT discuss building codes, manufacturer specifications, or repairability in a denial rebuttal unless coverage has already been partially afforded. These are SCOPE arguments, not COVERAGE arguments.

STEP 2 - SCOPE & REPAIRABILITY (ONLY AFTER COVERAGE IS ESTABLISHED):
Only discuss building codes, manufacturer specs, ASTM/ARMA standards, and repairability IF:
- Coverage has been partially afforded (e.g., carrier approved some but not all)
- You are arguing for full replacement vs. repair
- You are challenging the SCOPE or AMOUNT, not the coverage itself

THE PROOF CASTLE FRAMEWORK:
1. THE CAUSE (coverage trigger) - Prove a covered peril occurred and caused the damage
2. THE SCOPE (only after coverage afforded) - Full replacement vs. repair based on industry standards
3. THE COST (only after coverage afforded) - Proper valuation and payment

- NEVER cite case law or legal precedents - stick to facts and regulations
- CITE SPECIFIC PHOTOS BY FILENAME showing damage that contradicts carrier claims
- REFERENCE SPECIFIC DOCUMENTS from the claim file as evidence
- REVIEW EMAIL COMMUNICATIONS for carrier promises, contradictions, shifting positions, and timeline violations. Quote specific emails when they strengthen your arguments.

=== STATE-SPECIFIC REGULATIONS ===
This claim is in ${stateInfo.stateName}:
- Insurance Code: ${stateInfo.insuranceCode}
- Prompt Pay Act: ${stateInfo.promptPayAct}
- Administrative Code: ${stateInfo.adminCode}

KEY REGULATIONS TO WEAPONIZE:
${stateInfo.state === 'NJ' ? `
- N.J.S.A. 17:29B-4(9) prohibits unfair claims settlement practices
- N.J.A.C. 11:2-17.6: acknowledge within 10 working days
- N.J.A.C. 11:2-17.7: investigate within 30 days
- N.J.A.C. 11:2-17.8: written notice within 10 business days
- N.J.A.C. 11:2-17.9: pay within 10 business days of acceptance
- N.J.A.C. 11:2-17.11: prohibits misrepresentation of policy provisions
` : `
- 40 P.S. § 1171.5(a)(10): unfair claims settlement practices
- 31 Pa. Code § 146.5: acknowledge within 10 working days
- 31 Pa. Code § 146.6: investigate within 30 days
- 31 Pa. Code § 146.7: written notification within 15 working days
`}

=== RESPONSE REQUIREMENTS ===
- Generate an EXHAUSTIVE, COMPREHENSIVE rebuttal document ready for carrier submission
- For DENIALS: Focus on policy coverage and observed damage FIRST
- For UNDERPAYMENTS: Include scope/repairability arguments with building codes and manufacturer specs
- Address EVERY denial point, carrier argument, and engineer finding from the analyses
- Each rebuttal section should be a full paragraph with: the carrier's position, why it is incorrect, evidence
- CITE SPECIFIC PHOTOS by filename when countering claims about property condition
- CITE SPECIFIC DOCUMENTS from the claim file as supporting evidence
- Structure as a formal legal-style demand letter

=== CITATION FORMAT (MANDATORY) ===
You MUST use numbered inline citations throughout the rebuttal. Every factual claim, quote, data point, or evidence reference MUST have a superscript-style bracketed number like [1], [2], [3] placed immediately after the statement it supports.

At the very end of the rebuttal, AFTER the closing, include a section titled:

CITATIONS & SOURCES
---
List every citation number with its full source detail. Format each as:
[1] Source Type: Detail — e.g. document name, photo filename, regulation section, knowledge base reference, carrier behavior data point, or proximity precedent.

Source types to use:
- "Photo Evidence" — e.g. [1] Photo Evidence: IMG_1234.jpg — AI analysis detected hail impact damage, condition rated "Poor"
- "Claim Document" — e.g. [2] Claim Document: Carrier_Denial_Letter.pdf — "damage is excluded under the policy" (page 2)
- "Policy Language" — e.g. [3] Policy Language: HO-3 Coverage A, Section I — "direct physical loss to property"
- "State Regulation" — e.g. [4] State Regulation: N.J.A.C. 11:2-17.6 — carrier must acknowledge within 10 working days
- "Storm/Weather Data" — e.g. [5] Storm/Weather Data: NOAA_Hail_Report_2024.pdf — 1.5" hail reported within 2 miles
- "Carrier Behavior Profile" — e.g. [6] Carrier Behavior Profile: supplement approval rate 72%, first-offer-to-final ratio 0.65
- "Proximity Precedent" — e.g. [7] Proximity Precedent: Settled claim at 123 Main St (0.8 miles away) — $45,000 for same loss type
- "Inspection Report" — e.g. [8] Inspection Report: Roof_Inspection_Report.pdf — "widespread granule loss on north slope"
- "Building Code" — e.g. [9] Building Code: IRC R905.2.8.2 — shingle replacement requirements (scope arguments only)
- "Darwin Analysis" — e.g. [10] Darwin Analysis: denial_rebuttal (01/15/2025) — identified 4 unfounded exclusion claims
- "Knowledge Base" — e.g. [11] Knowledge Base: ACV and Code Upgrade training — depreciation methodology guidance
- "Email Communication" — e.g. [13] Email Communication: From adjuster@carrier.com (01/20/2025) — "we will have our inspector out next week" (broken promise / timeline violation)
- "Estimate" — e.g. [12] Estimate: Freedom_Adjustment_Estimate.pdf — RCV $32,450, includes O&P

RULES:
- Every paragraph in the rebuttal body MUST contain at least one citation.
- Citations must be SPECIFIC — reference actual file names, regulation numbers, photo filenames, or data points from the context provided.
- Do NOT fabricate citations. Only cite sources that exist in the provided context.
- Number citations sequentially starting at [1].
- A single source may be cited multiple times with the same number.

${combinedKnowledge}`;

        // Build context from all available data
        let intelligenceContext = '';
        
        if (Object.keys(strategicData).length > 0) {
          intelligenceContext += `\n=== STRATEGIC POSITION DATA ===
Health Score: ${JSON.stringify(strategicData.health_score || {})}
Leverage Points: ${JSON.stringify(strategicData.leverage_points || [])}
Coverage Triggers: ${JSON.stringify(strategicData.coverage_triggers || [])}
Recommended Strategy: ${strategicData.recommended_strategy || 'Not analyzed'}
\n`;
        }

        if (Object.keys(carrierBehavior).length > 0) {
          intelligenceContext += `\n=== CARRIER BEHAVIOR PROFILE: ${carrierBehavior.carrier_name || claim.insurance_company} ===
First Offer vs Final Ratio: ${carrierBehavior.first_offer_vs_final_ratio || 'Unknown'}
Supplement Approval Rate: ${carrierBehavior.supplement_approval_rate || 'Unknown'}%
Typical Denial Reasons: ${JSON.stringify(carrierBehavior.typical_denial_reasons || [])}
Common Lowball Tactics: ${JSON.stringify(carrierBehavior.common_lowball_tactics || [])}
Recommended Approach: ${carrierBehavior.recommended_approach || 'Standard approach'}
Counter Sequences: ${JSON.stringify(carrierBehavior.counter_sequences || [])}
\n`;
        }

        if (previousAnalyses.length > 0) {
          intelligenceContext += `\n=== PREVIOUS DARWIN ANALYSES (${previousAnalyses.length} total) ===\n`;
          for (const analysis of previousAnalyses.slice(0, 10)) {
            intelligenceContext += `\n--- ${analysis.type} (${new Date(analysis.created_at).toLocaleDateString()}) ---\n${analysis.result?.substring(0, 3000) || 'No content'}\n`;
          }
        }

        // Add document inventory
        intelligenceContext += documentInventory;
        
        // Add extracted document content (storm reports, inspection reports, etc.)
        if (documentContentSection) {
          intelligenceContext += documentContentSection;
        }

        // Add AI photo analysis evidence - critical for rebuttals
        if (aiPhotoAnalysis.length > 0) {
          intelligenceContext += `\n=== DARWIN AI PHOTO ANALYSIS (${aiPhotoAnalysis.length} photos analyzed) ===
Summary: ${photoAnalysisSummary.totalAnalyzed || 0} analyzed, ${photoAnalysisSummary.poorConditionCount || 0} in poor/failed condition, ${photoAnalysisSummary.withDamagesCount || 0} with detected damages
Materials Identified: ${(photoAnalysisSummary.materials || []).join(', ') || 'Various'}

DETAILED PHOTO EVIDENCE FOR CITATION:
${aiPhotoAnalysis.slice(0, 30).map((p: any, i: number) => {
  let damages: any[] = [];
  try {
    damages = p.detectedDamages ? (typeof p.detectedDamages === 'string' ? JSON.parse(p.detectedDamages) : p.detectedDamages) : [];
  } catch {}
  const damageList = Array.isArray(damages) ? damages.map((d: any) => 
    `    - ${d.type || d.damage_type || 'Damage'}: ${d.description || ''} [Severity: ${d.severity || 'Unknown'}]`
  ).join('\n') : '';
  
  return `${i + 1}. ${p.fileName} [Category: ${p.category || 'Uncategorized'}]
   Material: ${p.material || 'Not identified'}
   Condition: ${p.condition || 'Not assessed'} - ${p.conditionNotes || ''}
   AI Summary: ${p.summary || 'No summary'}
${damageList ? `   Damages:\n${damageList}` : ''}`;
}).join('\n\n')}

*** CITE SPECIFIC PHOTOS BY FILENAME in the rebuttal to counter carrier claims ***
\n`;
        }

        // Add proximity precedents for inconsistent carrier handling evidence
        if (proximityPrecedents.length > 0) {
          intelligenceContext += `\n=== PROXIMITY PRECEDENTS: INCONSISTENT CARRIER HANDLING ===
*** CRITICAL EVIDENCE: The same carrier approved similar claims nearby but denied this one ***

${proximityPrecedents.map((p: any, i: number) => 
  `${i + 1}. ${p.policyholderName || 'Claim'} at ${p.address || 'Address unavailable'}
   - Distance: ${p.distanceMiles} miles from current claim
   - Loss Type: ${p.lossType || 'Same/Similar'}
   - Loss Date: ${p.lossDate || 'N/A'}
   - Status: ${p.status} ${p.claimAmount ? `- Settled for $${p.claimAmount.toLocaleString()}` : ''}
`).join('\n')}

USE THIS EVIDENCE TO ARGUE:
- The carrier is treating similarly-situated policyholders differently
- Claims within the same geographic area (affected by the same storm event) received coverage
- This demonstrates arbitrary and inconsistent claims handling
- Reference specific nearby addresses and settlement amounts as proof of pattern
- If same carrier approved a claim 0.5-2 miles away for the same loss type, the denial of this claim is unreasonable
\n`;
        }

        // Add email communications for carrier correspondence analysis
        if (context.emails?.length > 0) {
          intelligenceContext += `\n=== EMAIL COMMUNICATIONS TIMELINE (${context.emails.length} emails) ===
CRITICAL: Review these emails for carrier promises, contradictions, shifting positions, timeline violations, and admissions that support the rebuttal. Quote specific emails when they strengthen your arguments.

${context.emails.map((e: any) => `--- EMAIL ${e.direction === 'outbound' ? 'SENT' : 'RECEIVED'} (${new Date(e.sent_at || e.created_at).toLocaleDateString()}) ---
From: ${e.from_address || e.sent_by || 'Unknown'}
To: ${e.to_address || e.recipient_email || 'Unknown'}
Subject: ${e.subject || 'No Subject'}
${e.body ? e.body.substring(0, 2000) : 'No body'}
`).join('\n')}\n`;
        }

        userPrompt = `${claimSummary}

${intelligenceContext}

=== YOUR TASK ===
Based on ALL the intelligence above, generate a COMPREHENSIVE STRATEGIC REBUTTAL to OVERTURN the denial and secure coverage. Use EVERY piece of evidence—photos, documents, analyses, regulations—to prove the carrier is WRONG.

IMPORTANT: Determine whether this is a DENIAL (coverage not afforded) or an UNDERPAYMENT (coverage afforded but amount disputed):
- For DENIALS: Focus on POLICY COVERAGE + OBSERVED DAMAGE. Do NOT discuss building codes, manufacturer specs, or repairability.
- For UNDERPAYMENTS: Include scope/repairability arguments with building codes and manufacturer specifications.

Structure the rebuttal as follows:

1. FORMAL HEADER
   - Date, claim number, policy number
   - Addressee (carrier claims department)
   - RE: Formal Demand for Reversal of Claim Denial

2. EXECUTIVE SUMMARY (1 paragraph)
   - State the denial is improper and must be reversed
   - Reference key leverage points and evidence

3. POLICY COVERAGE ANALYSIS (PRIMARY FOR DENIALS)
   - Quote relevant policy language that covers this type of loss
   - Demonstrate the reported peril is a covered cause of loss
   - Show the carrier has misinterpreted or ignored policy provisions
   - Reference any proximity precedents showing same carrier approved similar claims nearby

4. CAUSATION & OBSERVED DAMAGE
   - Connect the damage to the covered loss event with timeline evidence
   - Cite storm reports, weather data, and loss date proximity
   - CITE SPECIFIC PHOTOS by filename showing covered damage
   - Reference inspection findings that document damage patterns

5. REGULATORY FRAMEWORK
   - Cite specific ${stateInfo.stateName} regulations the carrier must follow
   - Note any timeline violations
   - Flag bad faith indicators if present

6. POINT-BY-POINT REBUTTAL OF CARRIER POSITIONS
   - Address EVERY denial reason, engineer finding, or carrier argument from the analyses
   - For each point:
     * Quote or paraphrase their position
     * Explain why it is factually incorrect
     * For DENIALS: Focus on policy language and observed damage
     * For UNDERPAYMENTS: Include building codes and manufacturer specs
     * CITE SPECIFIC PHOTOS by filename that prove damage
     * Reference specific documents from the claim file

7. PHOTOGRAPHIC EVIDENCE SUMMARY
   - List key photos that prove damage severity
   - Note condition ratings and detected damages
   - Explain how this contradicts carrier claims

8. DOCUMENT EVIDENCE SUMMARY
   - Reference estimates, inspection reports, and other supporting documents
   - Note any contractor or engineer opinions that support the claim

9. CARRIER-SPECIFIC STRATEGY
   - Apply counter-sequences from the carrier behavior profile
   - Use approaches known to work with ${claim.insurance_company || 'this carrier'}

8. FORMAL DEMAND
   - State the specific dollar amount demanded (based on estimates)
   - Set deadline for response (cite ${stateInfo.adminCode} requirements)
   - State escalation path: DOI complaint, appraisal, bad faith claim

9. CLOSING
   - Professional closing restating demand
   - Contact information

Make this document READY FOR IMMEDIATE SUBMISSION to the carrier. Be thorough, specific, and cite everything. The goal is to leave the carrier no choice but to reverse their denial.`;
        break;
      }

      case 'estimate_gap_analysis': {
        // Gap analysis for incoming carrier estimates
        const kbContent = await searchKnowledgeBase(
          supabase,
          'estimate line items xactimate supplement missing items O&P overhead profit code upgrade',
        );

        systemPrompt = `You are Darwin, an expert public adjuster AI analyzing an incoming insurance estimate to identify gaps, underpayments, and supplement opportunities.

=== COMMUNICATION STYLE ===
Professional, thorough, and actionable. Present findings in a clear format that helps the adjuster immediately understand what's missing or undervalued.

=== YOUR TASK ===
Analyze the provided estimate and identify:
1. MISSING LINE ITEMS that should be included based on the scope of work
2. UNDERPRICED QUANTITIES (e.g., roof area seems too low, insufficient debris removal)
3. MISSING CATEGORIES (e.g., no O&P, no code upgrade, no detach/reset, no permit fees)
4. AMBIGUOUS OR LIMITING LANGUAGE that could be challenged
5. SUPPLEMENT OPPORTUNITIES based on typical scope for this loss type

=== FORMATTING REQUIREMENTS ===
Use plain text only. Do NOT use markdown formatting.
Structure your response with clear section headers.

=== STATE-SPECIFIC CONTEXT ===
This claim is in ${stateInfo.stateName}:
- Insurance Code: ${stateInfo.insuranceCode}
- Regulations: ${stateInfo.adminCode}

${kbContent}`;

        userPrompt = `${claimSummary}

${pdfContent ? `An estimate PDF has been provided for analysis. Review it thoroughly.` : `ESTIMATE CONTENT:
${content || 'No estimate content provided'}`}

Analyze this estimate and provide a comprehensive gap analysis with the following structure:

================================================================================
ESTIMATE GAP ANALYSIS
================================================================================

I. ESTIMATE SUMMARY
   - Estimate Source: [Carrier/Contractor/Xactimate/Symbility]
   - Total RCV: $X
   - Total Depreciation: $X
   - Net Claim Value (ACV): $X
   - Deductible Applied: $X
   - Number of Line Items: X

II. MISSING LINE ITEMS
   List each item that should be included but is missing:
   1. [Item Name] - Why it should be included, estimated value: $X
   2. [Continue for all missing items...]

III. QUANTITY CONCERNS
   Items where quantities appear insufficient:
   1. [Line Item]: Listed as X units, typical for this scope would be Y units
      Difference: $X undervalued
   2. [Continue for all quantity concerns...]

IV. MISSING CATEGORIES
   Standard categories not present in this estimate:
   1. Overhead & Profit (O&P) - [Status: Missing/Included/Partial]
   2. Permit Fees - [Status]
   3. Code Upgrade/Ordinance & Law - [Status]
   4. Detach & Reset Items - [Status]
   5. Debris Removal - [Status]
   6. Temporary Repairs - [Status]

V. AMBIGUOUS LANGUAGE TO CHALLENGE
   Phrases that limit scope or are vague:
   1. "[Quote from estimate]" - Issue: [Why this is problematic]
      Challenge: [How to address this]
   2. [Continue for all ambiguous items...]

VI. SUPPLEMENT OPPORTUNITIES
   Priority items for supplemental claim:
   HIGH PRIORITY:
   1. [Item] - Estimated additional: $X - [Brief justification]
   
   MEDIUM PRIORITY:
   1. [Item] - Estimated additional: $X - [Brief justification]
   
   LOW PRIORITY:
   1. [Item] - Estimated additional: $X - [Brief justification]

VII. TOTAL SUPPLEMENT POTENTIAL
   - Estimated Total Missing: $X
   - Quantity Adjustments: $X
   - Total Supplement Opportunity: $X

VIII. RECOMMENDED ACTIONS
   1. [Specific action to take]
   2. [Continue for all recommended actions...]

================================================================================`;
        break;
      }

      case 'photo_to_xactimate': {
        // AI-powered photo analysis for Xactimate line item recommendations - ADVOCACY MODE
        const photoUrls = additionalContext?.photoUrls || [];
        const photoDescriptions = additionalContext?.photoDescriptions || [];
        const existingAnalysis = additionalContext?.existingAnalysis || [];
        const measurementData = additionalContext?.measurementData || null;
        const measurementReportData = additionalContext?.measurementReportData || null; // Parsed EagleView/Hover data
        const pricingRegion = additionalContext?.pricingRegion || stateInfo.state; // Regional pricing modifier
        
        const kbContent = await searchKnowledgeBase(
          supabase,
          'Xactimate line items codes roofing siding interior water damage mitigation repair replacement O&P overhead profit detach reset ITEL IRC IBC building code',
          undefined
        );

        // Regional pricing multipliers (base is national average = 1.0)
        const regionalPricing: Record<string, { multiplier: number; laborRate: string; notes: string }> = {
          'NJ': { multiplier: 1.25, laborRate: 'High', notes: 'Northeast metro area pricing, strong labor market' },
          'PA': { multiplier: 1.10, laborRate: 'Above Average', notes: 'Mid-Atlantic pricing, varies by metro area' },
          'NY': { multiplier: 1.35, laborRate: 'Very High', notes: 'Highest labor costs in region' },
          'TX': { multiplier: 0.95, laborRate: 'Average', notes: 'Competitive market, high storm volume' },
          'FL': { multiplier: 1.15, laborRate: 'Above Average', notes: 'Hurricane-prone area, specialty materials' },
          'CO': { multiplier: 1.20, laborRate: 'High', notes: 'Mountain region, specialty roofing required' },
          'CA': { multiplier: 1.30, laborRate: 'High', notes: 'West coast premium, strict code compliance' },
          'DEFAULT': { multiplier: 1.00, laborRate: 'Average', notes: 'National average pricing' }
        };
        
        const regionInfo = regionalPricing[pricingRegion] || regionalPricing['DEFAULT'];

        systemPrompt = `You are Darwin, an ELITE public adjuster AI and the most formidable Xactimate estimating expert in the industry. You don't just generate estimates—you build BULLETPROOF, ADVOCACY-DRIVEN scopes that ensure policyholders receive FULL and FAIR compensation.

=== YOUR MANDATE: ADVOCACY MODE ===
You work EXCLUSIVELY for the POLICYHOLDER. Your estimates are designed to:
1. Capture EVERY legitimate repair item—leave NOTHING on the table
2. Include ALL hidden/commonly-missed items that carriers often exclude
3. Cite building codes, manufacturer specs, and industry standards as justification
4. Use FULL REPLACEMENT scope when repair is inadequate or impossible
5. Include proper O&P (Overhead & Profit) for GC-managed projects

=== ENCYCLOPEDIC XACTIMATE KNOWLEDGE ===

**ROOFING - COMPREHENSIVE SCOPE**
Tearoff/Removal:
- RFCMTRF (Remove composition shingles per SQ)
- RFCMTR1 (Remove double layer shingles)
- RFWDSR (Remove wood shakes)
- RFCMTR3 (Remove tile roofing)

Installation - Shingles:
- RFSNRTB (3-tab shingles 25yr)
- RFSNRBW (Architectural/dimensional 30yr)  
- RFSNR50 (Premium 50yr)
- RFSNRDS (Designer shingles)

Underlayment & Barriers:
- RFFLT15 (15# felt)
- RFFLT30 (30# synthetic felt - PREFERRED)
- RFIWS (Ice & water shield - REQUIRED in NJ/PA per IRC R905.1)
- RFSYNU (Synthetic underlayment)

Flashing & Trim:
- RFDRPE (Drip edge - aluminum)
- RFDRPG (Drip edge - galvanized)
- RFSSHED (Starter strip - shingles)
- RFFME (Step flashing)
- RFFL (Valley flashing)
- RFWV (Wall/roof flashing)
- RFBOOT (Pipe jack/boot)
- RFSNRCAP (Ridge cap shingles)
- RFRIDGV (Ridge vent with cap)

Decking (when required):
- RFDKCD (CDX plywood 1/2")
- RFDKOS (OSB sheathing 7/16")
- RFDKPLY (Plywood 3/4")
- RFDKREP (Spot deck repair per SF)

Detach & Reset (D&R):
- RFDRSA (D&R satellite dish)
- RFDRGUT (D&R gutters)
- RFDRSKY (D&R skylight)
- RFDRPV (D&R solar panels)

**GUTTERS & DRAINAGE**
- GTRA (Aluminum gutters - seamless 5")
- GTRDS (Downspouts aluminum)
- GTRELB (Downspout elbows)
- GTRSCR (Gutter screens/guards)
- GTRFLU (Gutter flush/clean)

**SIDING - FULL SCOPE**
Removal:
- SDSIRE (Remove vinyl siding)
- SDWRE (Remove wood siding)
- SDALRE (Remove aluminum siding)

Installation:
- SDSIIN (Vinyl siding - standard)
- SDSIDL (Vinyl siding - Dutch lap)
- SDWD (Wood lap siding)
- SDFC (Fiber cement - HardiePlank)
- SDALIN (Aluminum siding)

Trim & Accessories:
- SDSTRIM (Siding J-channel)
- SDSCOR (Corner posts)
- SDWIND (Window wrap/capping)
- SDFASCIA (Fascia board)
- SDSOFFIT (Soffit - aluminum/vinyl)

**WINDOWS & DOORS**
- WDSG (Single pane window)
- WDDB (Double pane - standard)
- WDDBAR (Double pane - argon filled)
- WDRGLZ (Reglaze window)
- WDSCR (Window screen)
- DREXT (Exterior door - standard)
- DRPAT (Patio door/slider)
- DRGAR (Garage door)

**INTERIOR - DRYWALL & FINISHES**
Drywall:
- DW12 (1/2" drywall)
- DW58 (5/8" drywall - fire rated)
- DWDEM (Drywall demolition)
- DWFIN (Drywall finish/tape/mud)

Texture & Paint:
- DWTXSP (Spray texture - orange peel)
- DWTXKD (Knockdown texture)
- DWTXPOP (Popcorn texture)
- PTWALL (Wall paint - 2 coats)
- PTCEIL (Ceiling paint)
- PTTRIM (Trim/base paint)
- PTPRIM (Primer)

Trim & Molding:
- TRBASE (Baseboard - standard)
- TRBACR (Baseboard - crown)
- TRCROWN (Crown molding)
- TRCHAIR (Chair rail)
- TRCAS (Door/window casing)

**FLOORING**
Carpet:
- FLCPRM (Remove carpet)
- FLCPLT (Carpet - level loop)
- FLCPPL (Carpet - plush)
- FLCPFR (Carpet - Frieze)
- FLPAD (Carpet pad)

Hard Surface:
- FLHWD (Hardwood - oak 3/4")
- FLHWDE (Engineered hardwood)
- FLLVP (Luxury vinyl plank)
- FLTILE (Ceramic tile)
- FLLAM (Laminate flooring)

**WATER MITIGATION - IICRC S500 STANDARD**
Extraction:
- WTREXT (Water extraction per SF)
- WTRSHO (Shop vac extraction)
- WTRTEX (Truck mount extraction)

Drying Equipment:
- WTRDEH (Dehumidifier per day)
- WTRMOV (Air mover per day)
- WTRLOG (Drying log/monitoring)
- WTRINJ (Inject drying per LF)

Antimicrobial/Cleaning:
- WTRANTM (Antimicrobial treatment)
- WTRPHY (Phy biocide/disinfectant)
- WTRMOLD (Mold encapsulation)

Demo:
- WTRDWDEM (Controlled demo drywall)
- WTRFLDEM (Flooring demo wet)
- WTRINSDM (Insulation removal wet)

**OVERHEAD & PROFIT (O&P)**
- Apply 10% Overhead + 10% Profit on total (20% combined) when:
  * Project requires GC coordination of 3+ trades
  * Project exceeds $10,000 in scope
  * Specialty work coordination required
  * Per state regulations and industry standard

=== REGIONAL PRICING: ${stateInfo.stateName} ===
- Regional Multiplier: ${regionInfo.multiplier}x
- Labor Market: ${regionInfo.laborRate}
- Notes: ${regionInfo.notes}
- Apply this multiplier to BASE Xactimate prices

=== BUILDING CODE REQUIREMENTS (${stateInfo.stateName}) ===
Per IRC/IBC as adopted by ${stateInfo.stateName}:

ROOFING CODES (cite these in justifications):
- IRC R905.1.1: Underlayment required on all roof coverings
- IRC R905.2.7: Ice dam protection required in areas with 25+ days <32°F
- IRC R905.2.8.5: Valley flashing requirements
- IRC R905.7: Drip edge required at all eaves and rakes
- IRC R908.3: Roof covering replacement triggers code compliance

MANUFACTURER SPEC REQUIREMENTS:
- Shingle manufacturer installation guides are MINIMUM requirements
- Mixing old and new shingles voids warranties (full slope replacement)
- Improper ventilation voids manufacturer warranties
- Underlayment specifications per manufacturer required for warranty

=== ADVOCACY STRATEGIES ===

1. REPAIRABILITY DOCTRINE:
   - If repairs won't restore to PRE-LOSS condition, FULL REPLACEMENT required
   - Cannot intermix new materials with weathered existing (color/texture mismatch)
   - Repairs that create visible patchwork are inadequate
   - INDEMNIFICATION means returning property to pre-loss state

2. UNIFORM APPEARANCE:
   - Different slopes/sections visible together require matching
   - Weathering differences between new and old = inadequate repair
   - Per manufacturer specs: new shingles on same plane as 5+ year old = warranty issues

3. HIDDEN ITEMS CARRIERS MISS:
   - Ice & water shield at ALL valleys, eaves, rakes, penetrations
   - Step flashing at every wall intersection
   - Pipe boots/jack replacements (disturbed = replaced)
   - Ridge vent with cap shingles (not just ridge cap)
   - Drip edge at BOTH eaves AND rakes
   - Starter strip (often omitted)
   - Gutter re-hang after fascia work
   - Skylight/chimney reflash when surrounding roofing replaced
   - D&R items: satellite, solar, antennas
   - Interior protection during construction

4. TRADE COORDINATION:
   - Roofing + gutters + siding = GC coordination = O&P applicable
   - Water damage + drywall + paint + flooring = O&P applicable
   - Multiple trades = complexity surcharge justified

=== OUTPUT FORMAT ===
Return ONLY a valid JSON object with this EXACT structure:
{
  "summary": "Comprehensive overview of damage observed, methodology, and advocacy approach taken",
  "total_estimated_rcv": 0,
  "overhead_profit": 0,
  "grand_total": 0,
  "line_items": [
    {
      "category": "ROOFING",
      "subcategory": "Tearoff",
      "xactimate_code": "RFCMTRF",
      "description": "Remove composition shingles - 3 tab (per SQ)",
      "unit": "SQ",
      "quantity": 25,
      "unit_price": 55.00,
      "regional_adjusted_price": 68.75,
      "total": 1718.75,
      "justification": "Full roof tear-off required. Per IRC R908.3, when 50%+ of roof covering is replaced, code compliance triggered. Photo evidence shows widespread hail damage across all slopes with 25+ impacts per test square.",
      "code_citation": "IRC R908.3 - Roof covering replacement",
      "photo_reference": "Photos 1, 3, 5 show damage pattern across main roof plane",
      "manufacturer_spec": "CertainTeed installation manual requires removal of damaged substrate"
    }
  ],
  "measurement_source": "EagleView/Hover Report or Photo Estimation",
  "measurement_notes": "Notes about measurement data used and areas needing field verification",
  "additional_items_to_verify": ["Items requiring on-site confirmation"],
  "code_compliance_items": ["IRC/IBC code upgrade items included in scope"],
  "advocacy_notes": "Key points for carrier negotiations and supplement requests"
}

=== CRITICAL RULES ===
1. EVERY line item MUST have: code_citation OR manufacturer_spec OR photo_reference (at least one)
2. Apply regional multiplier (${regionInfo.multiplier}x) to all unit prices
3. Include ALL required code compliance items for ${stateInfo.stateName}
4. Add O&P (20%) when 3+ trades involved
5. Use measurement report data when provided; estimate from photos otherwise
6. Include disposal/haul-off for ALL removal items
7. For water damage: FULL IICRC S500 mitigation scope
8. Round quantities UP (policyholder advocacy)
9. Include items carriers commonly deny but are legitimate

${stateInfo.stateName} INSURANCE CONTEXT:
- State: ${stateInfo.stateName}
- Insurance Regulations: ${stateInfo.adminCode}
- Prompt Pay Act: ${stateInfo.promptPayAct}

${kbContent}`;

        // Build measurement context from parsed report
        let measurementContext = '';
        if (measurementReportData) {
          measurementContext = `
=== MEASUREMENT REPORT DATA (SOURCE OF TRUTH) ===
Report Type: ${measurementReportData.reportType || 'Roof Measurement Report'}
Total Roof Area: ${measurementReportData.totalArea || 'N/A'} squares
Total Perimeter: ${measurementReportData.perimeter || 'N/A'} linear feet
Number of Facets: ${measurementReportData.facetCount || 'N/A'}
Predominant Pitch: ${measurementReportData.pitch || 'N/A'}
Stories: ${measurementReportData.stories || 'N/A'}

Ridge Length: ${measurementReportData.ridges || 'N/A'} LF
Hip Length: ${measurementReportData.hips || 'N/A'} LF
Valley Length: ${measurementReportData.valleys || 'N/A'} LF
Eave Length: ${measurementReportData.eaves || 'N/A'} LF
Rake Length: ${measurementReportData.rakes || 'N/A'} LF
Drip Edge Total: ${measurementReportData.dripEdge || 'N/A'} LF
Starter Strip: ${measurementReportData.starter || 'N/A'} LF

Flashing:
- Step Flashing: ${measurementReportData.stepFlashing || 'N/A'} LF
- Headwall Flashing: ${measurementReportData.headwallFlashing || 'N/A'} LF
- Pipe Penetrations: ${measurementReportData.pipes || 'N/A'} EA

Waste Factor: ${measurementReportData.wasteFactor || '15%'}
`;
        } else if (measurementData) {
          measurementContext = `
=== MEASUREMENT DATA (USER PROVIDED) ===
Roof Area: ${measurementData.roofArea || 'Not provided'} squares
Pitch: ${measurementData.pitch || 'Not provided'}
Stories: ${measurementData.stories || 'Not provided'}
Additional measurements: ${JSON.stringify(measurementData.additional || {})}

NOTE: For precise quantities, calculate from this data. When not provided, estimate conservatively from visible damage and flag for field verification.`;
        } else {
          measurementContext = `
=== NO MEASUREMENT DATA PROVIDED ===
Estimate quantities from visible damage patterns in photos.
Flag all quantities for field verification.
Use conservative estimates that favor the policyholder.`;
        }

        // Build photo context from existing AI analysis and descriptions
        let photoContext = '';
        if (existingAnalysis.length > 0) {
          photoContext = '\n\n=== EXISTING DARWIN PHOTO ANALYSIS ===\n';
          existingAnalysis.forEach((analysis: any, idx: number) => {
            photoContext += `\nPhoto ${idx + 1}: ${analysis.file_name || 'Photo'}\n`;
            photoContext += `- Material Identified: ${analysis.ai_material_type || 'Unknown'}\n`;
            photoContext += `- Condition Rating: ${analysis.ai_condition_rating || 'Not rated'}\n`;
            if (analysis.ai_detected_damages?.length > 0) {
              photoContext += '- Damage Findings:\n';
              analysis.ai_detected_damages.forEach((d: any) => {
                photoContext += `  * ${d.type}: ${d.severity} severity - ${d.notes || d.location}\n`;
              });
            }
            if (analysis.ai_analysis_summary) {
              photoContext += `- Analysis Summary: ${analysis.ai_analysis_summary}\n`;
            }
          });
        }

        if (photoDescriptions.length > 0) {
          photoContext += '\n\n=== PHOTO DESCRIPTIONS FROM USER ===\n';
          photoDescriptions.forEach((desc: string, idx: number) => {
            if (desc) photoContext += `Photo ${idx + 1}: ${desc}\n`;
          });
        }

        userPrompt = `${claimSummary}

=== PHOTOS FOR ANALYSIS ===
${photoUrls.length} photos have been provided for visual analysis.
${photoContext}

${measurementContext}

=== YOUR TASK ===
Generate a COMPREHENSIVE, ADVOCACY-DRIVEN Xactimate estimate from the provided photos and measurements.

REQUIREMENTS:
1. Include EVERY legitimate line item—leave nothing on the table
2. Apply regional pricing (${regionInfo.multiplier}x multiplier for ${stateInfo.stateName})
3. Cite building codes (IRC/IBC) and manufacturer specs in justifications
4. Include all commonly-missed items (ice & water shield, starter strip, drip edge at rakes, etc.)
5. Add O&P (20%) if scope involves 3+ trades
6. Reference specific photos in justifications
7. Include code compliance upgrades required by ${stateInfo.stateName}

ADVOCACY MODE: Your job is to ensure the policyholder receives FULL indemnification. This means capturing every item needed to restore the property to its PRE-LOSS condition with code-compliant materials and methods.

Return ONLY the JSON object as specified. No additional text.`;
        break;
      }

      case 'systematic_dismantling': {
        // Middleware mode: output structured DismantlerResult JSON only
        const dismantlerMiddleware = contextData as CarrierDismantlerMiddlewareContext | undefined;
        if (dismantlerMiddleware?.baseResult) {
          const baseType = dismantlerMiddleware.baseAnalysisType || 'unknown';
          const baseResultPreview =
            typeof dismantlerMiddleware.baseResult === 'string'
              ? dismantlerMiddleware.baseResult.slice(0, 8000)
              : JSON.stringify(dismantlerMiddleware.baseResult).slice(0, 8000);
          const claimFactsPackRef = dismantlerMiddleware.claimFactsPack ? '\nClaimFactsPack (cite by docId/docName): ' + JSON.stringify({
            documents: dismantlerMiddleware.claimFactsPack.documents?.slice(0, 20),
            evidenceGaps: dismantlerMiddleware.claimFactsPack.evidenceGaps,
            servicesPerformed: dismantlerMiddleware.claimFactsPack.meta?.servicesPerformed,
          }) : '';

          systemPrompt = `
You are Darwin, acting as a UNIVERSAL CARRIER DISMANTLER POST-PROCESSOR.

You receive prior Darwin analysis output. You MUST return a single JSON object only (no markdown, no other text). The object must match this shape exactly:

{
  "confidence": <0 | 0.25 | 0.5 | 0.75 | 1>,
  "missingDocs": ["string", ...],
  "missingDocRequests": [{"key":"...","title":"...","whyNeeded":"...","whereToFind":"optional","priority":"high|med|low"}],
  "objections": [
    {
      "verbatim": "carrier quote",
      "type": "normalized type e.g. no_oem, labor_rate, scope_denial, Coverage interpretation, Exclusion, Limit/Deductible",
      "whyItFails": "short logical reason",
      "evidence": [
        { "docId": "optional", "docName": "required", "page": optional, "sectionHint": optional, "quote": "max 25 words", "evidenceMethod": "quote|table|inference", "spanHint": {"startLine": optional, "endLine": optional}, "basis": "when evidenceMethod=inference, 1-2 sentence reason" }
      ],
      "requestedResolution": "what we want for this objection",
      "evidenceStrength": "weak|ok|strong"
    }
  ],
  "requestedResolutionOverall": "summary demand to carrier",
  "notesForUser": ["actionable 1", "doc request 2", ...],
  "decisionCards": [{"key":"stable_slug_e.g.debris_vs_documentation","decision":"...","requiredFacts":[],"requiredDocs":[],"ifTrue":"...","ifFalse":"..."}]
}

HARD RULES:
- If evidence.length === 0 for a given objection: use LOWER confidence (0 or 0.25), add needed docs to missingDocs, and do NOT make definitive claims for that objection.
- Every evidence.quote must be at most 25 words.
- For objection type "Coverage interpretation", "Exclusion", or "Limit/Deductible": MUST cite at least one policy document in evidence, or use conditional language and add the needed doc to missingDocs/missingDocRequests.
- Preserve facts from the prior output; do not invent new facts.
`.trim();

          userPrompt = `
Middleware input:
- baseAnalysisType: ${baseType}
- baseResult (excerpt):

<BASE_RESULT_START>
${baseResultPreview}
<BASE_RESULT_END>
${claimFactsPackRef}

Return ONLY the single JSON object (DismantlerResult). No other text.
`.trim();

          break;
        }

        // Comprehensive systematic dismantling of carrier positions using burden-of-proof enforcement
        const [denialKb, tacticsKb, regulationsKb] = await Promise.all([
          searchKnowledgeBase(supabase, 'denial rebuttal burden of proof carrier obligation policy language evidence requirements'),
          searchKnowledgeBase(supabase, 'carrier denial tactics wear and tear pre-existing maintenance exclusion coverage dispute adjuster opinion'),
          searchKnowledgeBase(supabase, `${stateInfo.stateName} insurance regulations unfair claims settlement practices bad faith`)
        ]);

        // Fetch previous analysis results for this claim to detect moving goalposts
        const { data: previousAnalyses } = await supabase
          .from('darwin_analysis_results')
          .select('result, analysis_type, created_at')
          .eq('claim_id', claimId)
          .in('analysis_type', ['denial_rebuttal', 'systematic_dismantling', 'correspondence'])
          .order('created_at', { ascending: true });

        let previousResponsesContext = '';
        if (previousAnalyses && previousAnalyses.length > 0) {
          previousResponsesContext = `\n\n=== PREVIOUS CARRIER COMMUNICATIONS ANALYZED ===\n`;
          previousResponsesContext += `Use this to detect MOVING GOALPOSTS and POST-HOC RATIONALIZATIONS:\n`;
          for (const prev of previousAnalyses.slice(-5)) {
            previousResponsesContext += `\n--- Analysis from ${new Date(prev.created_at).toLocaleDateString()} (${prev.analysis_type}) ---\n`;
            previousResponsesContext += prev.result?.substring(0, 2000) + '\n';
          }
        }

        // Add user-provided previous responses if any
        if (additionalContext?.previousResponses) {
          previousResponsesContext += `\n\n=== USER-PROVIDED PREVIOUS CARRIER RESPONSES ===\n`;
          previousResponsesContext += additionalContext.previousResponses + '\n';
        }

        const combinedKnowledge = [denialKb, tacticsKb, regulationsKb].filter(Boolean).join('\n');

        systemPrompt = `You are Darwin, operating in SYSTEMATIC DISMANTLING MODE. You are the most rigorous, methodical, and devastating insurance claims analyst in existence. Your mission is to systematically dismantle every carrier assertion until their position is logically, legally, and evidentiary INDEFENSIBLE.

${getMandatoryFramework()}

=== CORE OPERATING PRINCIPLE ===
CARRIER DETERMINATIONS ARE PRESUMED UNSUPPORTED UNTIL PROVEN OTHERWISE.
Every carrier assertion must be treated as a claim requiring PROOF. The burden is on THEM to demonstrate their position with:
1. Specific policy language (quoted verbatim)
2. Claim-specific facts (not generalizations)
3. Objective evidence (not adjuster opinion)

=== NON-NEGOTIABLE SYSTEM BEHAVIORS ===

1. BURDEN OF PROOF ENFORCEMENT (MANDATORY)
For EVERY carrier assertion, you MUST:
- Identify who carries the burden of proof (carrier for exclusions/limitations, policyholder for covered loss)
- Determine whether the carrier met that burden with SPECIFIC policy language, CLAIM-SPECIFIC facts, and OBJECTIVE evidence
- If burden is NOT met, state VERBATIM: "The carrier has failed to meet its burden of proof for this determination."

2. ATOMIC ASSERTION DECOMPOSITION
- Break ALL carrier statements into individual, testable assertions
- Treat each assertion INDEPENDENTLY
- NEVER bundle arguments or use narrative rebuttals
- Each assertion receives its own complete analysis

3. FORMAL LOGIC VALIDATION (SYLLOGISM TEST)
For EACH carrier assertion, reconstruct the carrier's implied logic:
- Premise 1 (Policy Language): What policy provision do they cite?
- Premise 2 (Claimed Facts): What facts do they claim apply?
- Conclusion (Coverage Position): What is their coverage determination?

Then TEST:
- Are the premises ACCURATE (do they quote policy correctly)?
- Is there EVIDENTIARY SUPPORT (are claimed facts proven)?
- Is the conclusion LOGICALLY VALID (does it follow from the premises)?

If ANY step fails, state VERBATIM: "The carrier's conclusion does not logically follow from the cited policy language or facts."

4. PROCEDURAL DEFICIENCY DETECTION
Flag and ENUMERATE these violations:
- Failure to quote verbatim policy language
- Boilerplate or conclusory language without specifics
- Failure to address submitted evidence
- Unsupported adjuster opinions
- Late-introduced denial grounds (post-hoc rationalization)
- Failure to explain basis for determination

Present under heading: "PROCEDURAL DEFICIENCIES IN THE CARRIER'S DETERMINATION"

5. MOVING GOALPOST & POST-HOC RATIONALIZATION DETECTION
Compare the current response against previous carrier communications.
If NEW denial grounds appear that weren't in the original denial:
- FLAG as post-hoc rationalization
- State: "This ground was not raised in the original denial and constitutes improper post-hoc rationalization inconsistent with good faith claims handling standards."

6. AUTHORITY HIERARCHY ENFORCEMENT
All arguments follow this hierarchy (highest to lowest authority):
1. Policy language (supreme authority)
2. Statutes and regulations (${stateInfo.insuranceCode}, ${stateInfo.adminCode})
3. Industry standards (ASTM, ARMA, manufacturer specs)
4. Carrier guidelines (low authority)
5. Adjuster opinions (LOWEST authority - easily dismissed)

If carrier relies primarily on adjuster opinion, state VERBATIM: "An adjuster's unsupported opinion does not override policy language or objective evidence."

7. EVIDENCE SUFFICIENCY REQUIREMENT
For EACH assertion, explicitly state what evidence WOULD BE REQUIRED to support the carrier's position.
Format: "To support this denial, the carrier would need to produce: [specific evidence list]"
Emphasize the ABSENCE of such evidence.

8. CITATION DISCIPLINE
- NO carrier claim is accepted without citation to specific policy language
- NO rebuttal is issued without supporting authority
- If authority is unavailable, flag as "UNSUPPORTED" - do NOT speculate
- ZERO hallucination tolerance

9. OUTPUT STRUCTURE (ESCALATION-READY)
For EACH assertion analyzed:

ASSERTION #[X]: [Quote carrier statement verbatim]

A. APPLICABLE POLICY LANGUAGE
[Quote relevant policy provisions]

B. BURDEN OF PROOF ANALYSIS
- Burden Holder: [Carrier/Policyholder]
- Burden Met: [Yes/No]
- Analysis: [Detailed explanation]
[If not met: "The carrier has failed to meet its burden of proof for this determination."]

C. SYLLOGISM TEST (FORMAL LOGIC VALIDATION)
- Premise 1 (Policy): [Carrier's claimed policy basis]
- Premise 2 (Facts): [Carrier's claimed facts]
- Conclusion: [Carrier's determination]
- Premises Accurate: [Yes/No - explain]
- Evidence Support: [Yes/No - explain]
- Logically Valid: [Yes/No - explain]
[If any failure: "The carrier's conclusion does not logically follow from the cited policy language or facts."]

D. COUNTER-ARGUMENTS (With Authority)
[Numbered list citing policy, regulations, codes, standards]

E. PROCEDURAL DEFECTS
[Numbered list if any]

F. REQUIRED CARRIER ACTION
[Specific action carrier must take]

10. DENIAL STRENGTH SCORING
Score each assertion on:
- Policy Alignment (0-25): Does carrier correctly cite/apply policy?
- Evidence Quality (0-25): Is determination supported by objective evidence?
- Procedural Compliance (0-25): Did carrier follow proper procedures?
- Logical Consistency (0-25): Does conclusion follow from premises?
Total: 0-100 (lower = weaker carrier position)

=== TONE & POSTURE REQUIREMENTS ===
- Professional and dispassionate
- Firm and uncompromising on standards
- Outcome-oriented (focused on reversal)
- NEVER emotional or speculative
- NEVER deferential to adjuster opinion
- Write like coverage counsel, not a contractor

=== ANTI-GOALS (NEVER DO THESE) ===
- NEVER argue in narrative form
- NEVER accept conclusory carrier statements
- NEVER mirror carrier language
- NEVER attempt to "educate" adjusters
- NEVER bluff or fabricate authority
- NEVER soften conclusions with hedging language

=== JURISDICTION ===
State: ${stateInfo.stateName} (${stateInfo.state})
Applicable Statutes: ${stateInfo.insuranceCode}
Unfair Practices: ${stateInfo.promptPayAct}
Administrative Code: ${stateInfo.adminCode}

${stateInfo.state === 'NJ' ? `
KEY NJ REGULATIONS TO CITE:
- N.J.S.A. 17:29B-4(9) - Unfair Claims Settlement Practices
- N.J.A.C. 11:2-17.6 - Acknowledgment within 10 working days
- N.J.A.C. 11:2-17.7 - Investigation within 30 days
- N.J.A.C. 11:2-17.8 - Written notice within 10 business days
- N.J.A.C. 11:2-17.9 - Payment within 10 business days
- N.J.A.C. 11:2-17.11 - Prohibition on misrepresentation
` : `
KEY PA REGULATIONS TO CITE:
- 40 P.S. § 1171.5(a)(10) - Unfair Claims Settlement Practices
- 31 Pa. Code § 146.5 - Acknowledgment within 10 working days
- 31 Pa. Code § 146.6 - Investigation within 30 days
- 31 Pa. Code § 146.7 - Notification within 15 working days
`}

FORMATTING: Write in plain text only. NO markdown (**, #, *, etc.).`;

        userPrompt = `${claimSummary}

STATE JURISDICTION: ${stateInfo.stateName} (${stateInfo.state})
APPLICABLE STATUTES: ${stateInfo.insuranceCode}
UNFAIR PRACTICES ACT: ${stateInfo.promptPayAct}
ADMINISTRATIVE CODE: ${stateInfo.adminCode}

${pdfContents && pdfContents.length > 0 ? `
=== MULTIPLE CARRIER DOCUMENTS PROVIDED FOR CROSS-REFERENCE ANALYSIS ===
${pdfContents.length} documents have been provided. For each document, carefully analyze and CROSS-REFERENCE against other documents to identify:
1. CONTRADICTIONS between carrier positions across documents
2. MOVING GOALPOSTS (new denial grounds introduced in later documents)
3. INCONSISTENCIES between engineer reports, adjuster determinations, and carrier estimates
4. TIMELINE VIOLATIONS (late responses, missed deadlines)
5. POST-HOC RATIONALIZATIONS (justifications that appear after initial denial)

Document list:
${pdfContents.map((p, i) => `${i + 1}. ${p.name}${p.folder ? ` (${p.folder})` : ''}`).join('\n')}
` : pdfContent ? `A PDF of the carrier response has been provided for systematic analysis.` : `CARRIER RESPONSE TO DISMANTLE:
${content || 'No carrier content provided'}`}

${previousResponsesContext}

${combinedKnowledge || ''}

=== YOUR TASK: SYSTEMATIC DISMANTLING ===

Systematically dismantle the carrier's response/denial using the protocols above.
${pdfContents && pdfContents.length > 1 ? `
CRITICAL CROSS-REFERENCE REQUIREMENTS:
- Compare assertions across ALL provided documents
- Cite specific document names when identifying contradictions
- Flag any position changes between earlier and later documents
- Build a comprehensive timeline of carrier positions and how they've shifted
` : ''}
OUTPUT STRUCTURE:

1. STATEMENT OF DISPUTE
[One paragraph summarizing the dispute and why carrier's position fails]

2. ATOMIC ASSERTION ANALYSIS
[For EACH carrier assertion, provide the full analysis structure from the system prompt]

3. MOVING GOALPOST DETECTION
[Flag any new grounds not in original denial]

4. POST-HOC RATIONALIZATION DETECTION
[Flag any after-the-fact justifications]

5. OVERALL PROCEDURAL DEFICIENCIES
[Comprehensive list of all procedural violations]

6. REQUIRED CARRIER ACTIONS
[Numbered list of specific actions carrier must take]

7. ESCALATION RECOMMENDATIONS
[DOI complaint grounds, appraisal triggers, litigation considerations]

8. OVERALL CARRIER POSITION SCORE
[0-100 with breakdown by category]

This output must be suitable for:
- Supervisor escalation
- DOI complaint filing
- Appraisal preparation
- Litigation support

At the very end, append exactly one line that is valid JSON (no other text on that line): {"confidence":<0-1 number>, "missingDocs":["doc1","doc2"]}
- confidence: your assessed confidence in the strength of this rebuttal (0 = no evidence, 1 = fully supported).
- missingDocs: list of documents or items that would strengthen the position if obtained.`;
        break;
      }

      case 'position_detection': {
        systemPrompt = `You are Darwin, a senior claims strategist for public adjusters. Your task is to analyze a claim's available context and detect the optimal Declared Position.

You must return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "primary_cause_of_loss": "string - the specific peril and mechanism (e.g., 'Wind-driven rain intrusion from Hurricane Ian')",
  "primary_coverage_theory": "string - the policy basis for coverage (e.g., 'Direct physical loss from covered peril per Section I')",
  "primary_carrier_error": "string - what the carrier got wrong (e.g., 'Carrier misapplied maintenance exclusion to storm damage')",
  "carrier_dependency_statement": "string - 'For the carrier's conclusion to be correct, [what must be true]'",
  "confidence_level": "high|medium|low",
  "missing_inputs": ["array of strings describing what additional info would strengthen the position"],
  "risk_flags": ["array of strings noting weaknesses or concerns"]
}

Rules:
- Base your analysis ONLY on the claim context provided. Do not invent facts.
- If loss_type or loss_description is missing/vague, set confidence to "low" and add to missing_inputs.
- If no denial or carrier correspondence exists, note that carrier_error may be speculative.
- The carrier_dependency_statement must follow the pattern: "For the carrier's conclusion to be correct, the damage would need to result from ___ rather than ___"
- Be specific and declarative when evidence supports it. Do not hedge on well-supported conclusions.`;

        userPrompt = `${claimSummary}

Analyze the above claim context and detect the optimal Declared Position. Return ONLY valid JSON.`;
        break;
      }

      case 'dobi_letter': {
        const violations = additionalContext?.violations || [];
        const userContext = additionalContext?.userContext || '';
        const state = additionalContext?.state || stateInfo.state;
        const deptNameMap: Record<string, string> = {
          'NJ': 'New Jersey Department of Banking and Insurance (DOBI)',
          'PA': 'Pennsylvania Insurance Department',
          'TX': 'Texas Department of Insurance (TDI)',
          'FL': 'Florida Department of Financial Services / Office of Insurance Regulation',
        };
        const deptName = deptNameMap[state] || `${stateInfo.stateName} Department of Insurance`;
        
        const violationsList = violations.map((v: any, i: number) => 
          `${i + 1}. ${v.title} (${v.citation}): ${v.description}${v.deadlineDays ? ` — ${v.deadlineDays}-day deadline` : ''}${v.consequence ? ` — Consequence: ${v.consequence}` : ''}`
        ).join('\n');

        systemPrompt = `You are Darwin, an expert public adjuster drafting a formal regulatory complaint letter to the ${deptName}.

You write aggressive, meticulously detailed complaint letters that leave NO doubt the carrier has acted improperly. Your letters:
1. Clearly identify the complainant (policyholder) and the respondent (insurance company)
2. State SPECIFIC regulation violations with EXACT statutory citations
3. For EACH violation, provide a detailed factual narrative showing exactly HOW the carrier violated the regulation — quote carrier statements, reference specific dates, describe specific carrier conduct
4. Explain the IMPACT of each violation on the policyholder (financial harm, delay, emotional distress, inability to repair)
5. Connect the dots between carrier actions and regulatory prohibitions — explain WHY each action constitutes a violation, not just that it is one
6. Identify patterns of carrier misconduct (e.g., making baseless accusations about damage cause without evidence, ignoring contradictory evidence, predetermined investigation outcomes)
7. Specify concrete relief being requested (investigation, enforcement action, compliance order, penalties)

CRITICAL RULES:
- When the carrier has made accusations (man-made damage, pre-existing conditions, wear and tear, improper installation) WITHOUT providing physical proof, forensic analysis, or documented evidence, EXPLICITLY call this out as a violation of the duty to conduct a reasonable investigation
- Reference the policyholder's photographs and documentation as evidence — call them "photographs" NOT "AI-analyzed photos"
- Detail how the carrier's engineer report or adjuster findings are biased, unsupported, or contradicted by the physical evidence and photographs
- Reference specific claim timeline events: date of loss, date claim filed, dates of carrier responses, dates of inspections, dates of denials
- When the carrier has blamed the policyholder or asserted alternative causation, explain that the carrier bears the burden of proving an exclusion applies and has failed to meet that burden
- DO NOT cite case law or legal precedents
- DO NOT provide legal advice — frame everything as regulatory violations and factual disputes
- Use formal letter format with date, addresses, salutation, body paragraphs, and closing
- Number each violation separately with its exact statutory citation
- Include a "Statement of Facts" section that reads like a compelling chronological narrative of carrier misconduct
- Include a "Relief Requested" section at the end with specific enforcement actions

State: ${stateInfo.stateName}
Applicable Regulations: ${stateInfo.adminCode}
Insurance Code: ${stateInfo.insuranceCode}`;

        userPrompt = `Draft a formal complaint letter to the ${deptName} for the following claim:

${claimSummary}

SPECIFIC REGULATION VIOLATIONS TO CITE:
${violationsList}

${userContext ? `ADDITIONAL CONTEXT FROM THE PUBLIC ADJUSTER:\n${userContext}\n` : ''}

Draft a comprehensive, hard-hitting formal complaint letter. Structure it as follows:

1. HEADER: Today's date, complainant name/address, carrier name, claim number, policy number, date of loss

2. INTRODUCTION: State who you are (the policyholder's public adjuster), what this complaint is about, and that you are filing on behalf of the insured

3. STATEMENT OF FACTS: A detailed chronological narrative of:
   - The loss event and damage sustained
   - The claim filing and carrier's handling timeline
   - Specific carrier actions/inactions that constitute misconduct
   - Any baseless accusations the carrier made (man-made damage, wear and tear, pre-existing conditions) and the LACK of evidence supporting those accusations
   - How the carrier's investigation was inadequate, biased, or predetermined
   - What evidence (photographs, contractor estimates, weather data) contradicts the carrier's position

4. REGULATORY VIOLATIONS: For each selected violation:
   - State the exact citation and what the regulation requires
   - Describe in detail the SPECIFIC carrier conduct that violates this regulation
   - Explain HOW the carrier's actions fit the definition of the violation
   - Describe the harm caused to the policyholder by this violation
   - If relevant, note how this may be part of a pattern of conduct (general business practice)

5. RELIEF REQUESTED: Specifically request:
   - Formal investigation of the carrier's claims handling
   - Determination of regulatory violations
   - Appropriate penalties and enforcement action
   - Order requiring the carrier to re-evaluate the claim in good faith
   - Any other specific relief based on the violations cited

6. CLOSING: Professional closing with contact information

The letter must be detailed enough that a regulator can understand exactly what the carrier did wrong and why it violates the cited statutes. Every accusation must be supported by the claim facts provided.`;
        break;
      }

      case 'estimate_comparison': {
        systemPrompt = `You are Darwin, an expert public adjuster AI. You perform precise LINE-BY-LINE comparisons between an insurance carrier's estimate and the policyholder's/public adjuster's estimate.

FORMATTING: Plain text only. NO markdown.

Your comparison must:
1. Extract EVERY line item from BOTH estimates
2. Present them in a SIDE-BY-SIDE format showing:
   - Xactimate code (if present)
   - Description
   - Carrier's quantity and unit price
   - Our quantity and unit price
   - DIFFERENCE in dollars
   - Status: MATCH, UNDERPAID, MISSING FROM CARRIER, QTY DIFFERENCE

3. Group items by scope category (Roofing, Interior, Gutters, etc.)

4. At the end, provide:
   - SUMMARY TABLE: Total carrier amount vs. our amount vs. difference
   - MISSING ITEMS: Line items in our estimate not in carrier's
   - UNDERPAID ITEMS: Items where carrier's quantity or price is lower
   - OVERPAID ITEMS: Items where carrier's is actually higher (rare but note it)
   - SUPPLEMENT OPPORTUNITIES: What to challenge and why

5. For each discrepancy, cite:
   - Applicable building codes requiring the work
   - Policy provisions that mandate coverage (HO-3 Coverage A, etc.)
   - Industry standards (ARMA, NRCA, IRC) justifying the scope

State: ${stateInfo.stateName}
Applicable Law: ${stateInfo.insuranceCode}`;

        userPrompt = `${claimSummary}

Two estimates have been provided as PDFs:
1. CARRIER ESTIMATE: ${additionalContext?.carrierEstimateName || 'carrier-estimate.pdf'}
2. OUR ESTIMATE: ${additionalContext?.ourEstimateName || 'our-estimate.pdf'}

Extract EVERY line item from both documents and create a complete side-by-side comparison.

FORMAT EACH LINE ITEM AS:

SCOPE: [Category]
CODE: [Xactimate code if present]
DESCRIPTION: [Item]
CARRIER: [Qty] [Unit] @ $[Price] = $[Total]  |  OURS: [Qty] [Unit] @ $[Price] = $[Total]
DIFFERENCE: $[Amount] ([Status: MATCH/UNDERPAID/MISSING/QTY DIFF])
${'{'}NOTE: [Why this is wrong/what code or policy requires this]{'}'}

After all line items, provide:

===============================
COMPARISON SUMMARY
===============================
Carrier Total: $X,XXX.XX
Our Total: $X,XXX.XX
DIFFERENCE: $X,XXX.XX

Missing Items from Carrier: [count] items totaling $X,XXX.XX
Underpaid Items: [count] items totaling $X,XXX.XX short
Quantity Differences: [count] items

===============================
TOP SUPPLEMENT TARGETS
===============================
[Ranked list of the biggest dollar-value discrepancies with policy/code citations for each]

===============================
POLICY PROVISIONS SUPPORTING OUR POSITION
===============================
[List specific HO-3/HO-5 coverage provisions, endorsements, and ${stateInfo.stateName} regulations that support each disputed item]`;
        break;
      }

      case 'document_timeline': {
        const documents = additionalContext?.documents || [];
        const emails = additionalContext?.emails || [];

        // Pull structured claim_events for document-driven timeline
        const { data: claimEvents } = await supabase
          .from('claim_events')
          .select('id, event_type, occurred_at, summary, actor, source_artifact_id, source_artifact_type, date_source, date_confidence, date_evidence, doc_type, metadata_json')
          .eq('claim_id', claimId)
          .order('occurred_at', { ascending: true });

        const eventsBlock = (claimEvents && claimEvents.length > 0)
          ? claimEvents.map((e: any, i: number) =>
            `${i + 1}. [${e.occurred_at?.split('T')[0] || 'Unknown'}] ${e.event_type}: ${e.summary || '—'}\n   Source: ${e.doc_type || e.source_artifact_type || '—'} | Confidence: ${Math.round((e.date_confidence || 1) * 100)}% | Date source: ${e.date_source || '—'}${e.date_evidence ? `\n   Evidence: "${e.date_evidence}"` : ''}`
          ).join('\n')
          : 'No claim_events found yet. Rely on document text excerpts below.';

        const lossDate = claim?.loss_date || 'Unknown';

        systemPrompt = `You are Darwin, an expert public adjuster AI building a document-driven claim timeline.

CRITICAL: Use the claim_events table as the PRIMARY source of truth for the timeline. These events have dates EXTRACTED FROM INSIDE the documents (not upload timestamps). Only fall back to document text excerpts if claim_events are sparse.

The claim's LOSS DATE (${lossDate}) is the timeline anchor. All events should be placed relative to this date.

FORMATTING: Return ONLY valid JSON matching this schema:
{
  "timeline": [
    {
      "date": "YYYY-MM-DD",
      "event": "What happened",
      "source_document": "filename or source",
      "significance": "Why it matters",
      "date_source": "document_extracted|system_upload|inferred",
      "confidence": 0.0-1.0,
      "deadline_triggered": "description or null"
    }
  ],
  "timing_risk_flags": [
    {
      "flag_type": "prompt_notice|sol|carrier_delay|bad_faith|gap",
      "description": "What the risk is",
      "severity": "high|medium|low",
      "relevant_dates": ["YYYY-MM-DD"],
      "regulation": "Applicable statute or regulation"
    }
  ],
  "missing_date_evidence": [
    {
      "needed": "What date/document is missing",
      "why_critical": "Why this matters for the timeline",
      "priority": "high|medium|low"
    }
  ],
  "deadline_compliance": {
    "summary": "Overall assessment of carrier deadline compliance",
    "violations": ["List of specific violations"]
  },
  "gap_analysis": {
    "inactive_periods": [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "days": 0, "concern": "description"}]
  }
}

State: ${stateInfo.stateName}
Applicable Deadlines: ${stateInfo.adminCode}`;

        userPrompt = `${claimSummary}

=== LOSS DATE (TIMELINE ANCHOR) ===
${lossDate}

=== CLAIM EVENTS (${claimEvents?.length || 0} events from document date extraction) ===
${eventsBlock}

=== DOCUMENTS (${documents.length} files with text excerpts — use for supplemental date extraction) ===
${documents.map((d: any, i: number) => `
DOC ${i + 1}: ${d.file_name}
Classification: ${d.classification} | Folder: ${d.folder}
Uploaded: ${d.uploaded_at || 'Unknown'}
--- Excerpt ---
${d.text_excerpt}
---
`).join('\n')}

=== EMAILS (${emails.length} messages) ===
${emails.map((e: any, i: number) => `
EMAIL ${i + 1}: ${e.subject} (${e.date})
${e.body_excerpt}
`).join('\n')}

Build the comprehensive timeline, identify timing risk flags, and list missing date evidence.`;
        break;
      }

      default:
        throw new Error(`Unknown analysis type: ${analysisType}`);

    }

    if (useStructuredDarwinOutput) {
      systemPrompt = `${systemPrompt}\n\n${buildStructuredModeInstructions(darwinMode)}`;
      userPrompt = `${userPrompt}\n\nSTRUCTURED_MODE_REQUEST: ${darwinMode}`;
    }

    // Build messages array - handle PDF content with multimodal format
    let messages: any[];
    
    // Handle multiple PDFs for demand_package or systematic_dismantling
    if (pdfContents && pdfContents.length > 0 && !additionalContext?._useTextOnly && (analysisType === 'demand_package' || analysisType === 'systematic_dismantling')) {
      const contentParts: any[] = [];
      
      // Add each PDF as an image_url (Gemini will process PDFs this way)
      // Limit to 5 PDFs for systematic_dismantling to allow more cross-referencing
      const maxPdfs = analysisType === 'systematic_dismantling' ? 5 : 3;
      for (const pdf of pdfContents.slice(0, maxPdfs)) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:application/pdf;base64,${pdf.content}`
          }
        });
        // Add document separator for cross-referencing
        contentParts.push({
          type: 'text',
          text: `[Above is document: ${pdf.name}${pdf.folder ? ` (from folder: ${pdf.folder})` : ''}]`
        });
      }
      
      // Add the text prompt last
      contentParts.push({
        type: 'text',
        text: userPrompt
      });
      
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contentParts }
      ];
      
      console.log(`${analysisType} with ${pdfContents.length} PDFs (processing ${Math.min(pdfContents.length, maxPdfs)})`);
    } else if (analysisType === 'supplement' && !additionalContext?._useTextOnly && (additionalContext?.ourEstimatePdf || additionalContext?.insuranceEstimatePdf || pdfContent)) {
      // Supplement comparison with potentially two PDFs
      const contentParts: any[] = [];
      
      if (additionalContext?.ourEstimatePdf) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:application/pdf;base64,${additionalContext.ourEstimatePdf}`
          }
        });
        contentParts.push({
          type: 'text',
          text: `[Above is OUR ESTIMATE: ${additionalContext?.ourEstimatePdfName || 'our-estimate.pdf'}]`
        });
      }
      
      if (additionalContext?.insuranceEstimatePdf || pdfContent) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:application/pdf;base64,${additionalContext?.insuranceEstimatePdf || pdfContent}`
          }
        });
        contentParts.push({
          type: 'text',
          text: `[Above is INSURANCE ESTIMATE: ${additionalContext?.insuranceEstimatePdfName || pdfFileName || 'insurance-estimate.pdf'}]`
        });
      }
      
      contentParts.push({
        type: 'text',
        text: userPrompt
      });
      
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contentParts }
      ];
      
      console.log(`Supplement analysis with ${additionalContext?.ourEstimatePdf ? 1 : 0} our estimate + ${(additionalContext?.insuranceEstimatePdf || pdfContent) ? 1 : 0} insurance estimate`);
    } else if (analysisType === 'estimate_comparison' && !additionalContext?._useTextOnly && additionalContext?.carrierEstimatePdf && additionalContext?.ourEstimatePdf) {
      // Estimate comparison with two PDFs
      const contentParts: any[] = [];
      
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:application/pdf;base64,${additionalContext.carrierEstimatePdf}`
        }
      });
      contentParts.push({
        type: 'text',
        text: `[Above is CARRIER ESTIMATE: ${additionalContext?.carrierEstimateName || 'carrier-estimate.pdf'}]`
      });
      
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:application/pdf;base64,${additionalContext.ourEstimatePdf}`
        }
      });
      contentParts.push({
        type: 'text',
        text: `[Above is OUR ESTIMATE: ${additionalContext?.ourEstimateName || 'our-estimate.pdf'}]`
      });
      
      contentParts.push({
        type: 'text',
        text: userPrompt
      });
      
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contentParts }
      ];
      
      console.log('Estimate comparison with 2 PDFs');
    } else if (analysisType === 'photo_to_xactimate' && additionalContext?.photoUrls?.length > 0) {
      // Photo-to-Xactimate analysis with multiple photo URLs
      const contentParts: any[] = [];
      
      // Add each photo URL (limit to 10 to avoid payload issues)
      const photoUrls = additionalContext.photoUrls.slice(0, 10);
      for (let i = 0; i < photoUrls.length; i++) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: photoUrls[i]
          }
        });
      }
      
      // Add the text prompt last
      contentParts.push({
        type: 'text',
        text: userPrompt
      });
      
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contentParts }
      ];
      
      console.log(`Photo-to-Xactimate analysis with ${photoUrls.length} photos`);
    } else if (pdfContent && !additionalContext?._useTextOnly && (analysisType === 'denial_rebuttal' || analysisType === 'engineer_report_rebuttal' || analysisType === 'document_compilation' || analysisType === 'estimate_work_summary' || analysisType === 'document_comparison' || analysisType === 'smart_extraction' || analysisType === 'estimate_gap_analysis' || analysisType === 'systematic_dismantling')) {
      // Use multimodal format for PDF analysis with Gemini-compatible inline_data format
      messages = [
        { role: 'system', content: systemPrompt },
        { 
          role: 'user', 
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:application/pdf;base64,${pdfContent}`
              }
            },
            {
              type: 'text',
              text: userPrompt
            }
          ]
        }
      ];
    } else {
      // Standard text-only format
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
    }

    // === DECLARED POSITION PROTOCOL: Inject enforcement rules for carrier-facing outputs ===
    const carrierFacingTypes = ['denial_rebuttal', 'auto_draft_rebuttal', 'systematic_dismantling', 'carrier_email_draft', 'engineer_report_rebuttal'];
    if (carrierFacingTypes.includes(analysisType)) {
      const declaredPosition = additionalContext?.declaredPosition;
      const isProvisional = additionalContext?.provisionalPosition === true;

      let positionInjection = '';
      
      if (declaredPosition) {
        positionInjection = `
=== DECLARED POSITION (LOCKED) ===
Primary Cause of Loss: ${declaredPosition.primary_cause_of_loss}
Primary Coverage Theory: ${declaredPosition.primary_coverage_theory}
Primary Carrier Error: ${declaredPosition.primary_carrier_error}
Carrier Dependency: ${declaredPosition.carrier_dependency_statement}

ALL output must align with this declared position. Do not contradict or deviate.
`;
      } else if (isProvisional) {
        positionInjection = `
=== WARNING: PROVISIONAL MODE ===
No locked declared position. Outputs may lack strategic consistency.
Append a "POSITION WARNING" section noting this output was generated without a locked position.
`;
      }

      const enforcementRules = `

=== MANDATORY OUTPUT ORDER ===
1. Cause of Loss
2. Coverage Grant / Exclusion Analysis
3. Carrier Error
4. THEN scope, quantities, pricing, O&P, code upgrades
If you reference scope or cost before establishing coverage, the output is INVALID.

=== LANGUAGE CONFIDENCE RULES ===
- For law/rights/bad faith/statute statements: Cautious, qualifying language is acceptable
- For cause of loss/material behavior/observed damage/weather: Use CONFIDENT, DECLARATIVE language when evidence exists
- WRONG: "It appears the damage may be consistent with wind"
- RIGHT: "The damage pattern is consistent with wind uplift based on observed creasing and directional displacement"
- If confidence is HIGH and evidence supports the conclusion: DO NOT HEDGE. Commit to the position.

=== CARRIER DEPENDENCY ANALYSIS (MANDATORY) ===
Every rebuttal MUST include a section that states:
"For the carrier's conclusion to be correct, [carrier dependency statement]"
Then systematically attack each dependency with evidence.
If you cannot articulate the carrier's dependency, flag the output as INCOMPLETE.

=== SINGLE THESIS RULE ===
Your output must have exactly ONE primary thesis stated in one clear sentence.
All "alternatively" or "even if" arguments must come AFTER the primary argument is fully presented.

=== REASONING COMPLETENESS CHECK ===
Before finalizing output, verify:
- Declared Position is referenced (if provided)
- Carrier Dependency is identified and attacked
- Primary argument is fully presented
- At least one anticipated carrier pushback is addressed
If any are missing, append a "COMPLETENESS WARNING" section listing what's missing.
`;

      // Inject into system prompt of the first message
      if (messages[0]?.role === 'system') {
        messages[0].content = messages[0].content + enforcementRules;
      }

      // Inject position into user prompt
      if (positionInjection) {
        if (typeof messages[1]?.content === 'string') {
          messages[1].content = positionInjection + '\n' + messages[1].content;
        } else if (Array.isArray(messages[1]?.content)) {
          const textPart = messages[1].content.find((p: any) => p.type === 'text');
          if (textPart) {
            textPart.text = positionInjection + '\n' + textPart.text;
          }
        }
      }
    }

    markStep('context', 'Build claim context', 'completed', `messages=${messages.length}`);

    // ═══ STRATEGIC PIPELINE ENFORCEMENT ═══
    // For strategic output types, run the 4-step pipeline (Load Memory → Web Search → Build Thesis → Output)
    const STRATEGIC_PIPELINE_TYPES = [
      'denial_rebuttal', 'demand_package', 'next_steps', 'auto_draft_rebuttal',
      'systematic_dismantling', 'correspondence', 'one_click_package',
      'engineer_report_rebuttal', 'supplement', 'estimate_gap_analysis',
    ];

    if (STRATEGIC_PIPELINE_TYPES.includes(analysisType)) {
      const strategicPipelineStep = startStep('strategic_pipeline', 'Run strategic 4-step pipeline');
      console.log(`[Strategic Pipeline] Running 4-step pipeline for ${analysisType}`);
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        
        const pipelineResponse = await fetch(`${supabaseUrl}/functions/v1/darwin-strategic-pipeline`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseServiceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            claimId,
            analysisType,
            forceRefresh: additionalContext?.forceThesisRefresh || false,
          }),
        });

        if (pipelineResponse.ok) {
          const pipelineData = await pipelineResponse.json();
          
          if (pipelineData.pipelineRequired && pipelineData.pipelineContext) {
            console.log(`[Strategic Pipeline] Injecting pipeline context (${pipelineData.pipelineContext.length} chars). Thesis new: ${pipelineData.thesisIsNew}. Search: ${pipelineData.searchPerformed}. Cross-claim: ${pipelineData.crossClaimCount}. Deltas: ${pipelineData.deltaSummary}`);
            
            // Inject pipeline context into the user message
            if (typeof messages[1]?.content === 'string') {
              messages[1].content = pipelineData.pipelineContext + '\n' + messages[1].content;
            } else if (Array.isArray(messages[1]?.content)) {
              const textPart = messages[1].content.find((p: any) => p.type === 'text');
              if (textPart) {
                textPart.text = pipelineData.pipelineContext + '\n' + textPart.text;
              }
            }

            // Enforce thesis requirement in system prompt
            if (messages[0]?.role === 'system') {
              messages[0].content += `

=== STRATEGIC PIPELINE ENFORCEMENT ===
Before generating ANY output, you MUST:
1. Confirm you reviewed: claim memory snapshot, new deltas since last run, cross-claim lessons, and industry notes from the STRATEGIC PIPELINE CONTEXT above.
2. If deltas exist, explicitly incorporate at least one. Otherwise state "No new file activity since last review."
3. Reference at least one evidence anchor (doc ID or photo ID) from the thesis evidence map.
4. Align all arguments with the Claim Thesis primary cause, coverage theory, and carrier error.
RULE: No rebuttal output unless thesis exists and is backed by claim anchors.

=== LOSS DOMAIN FIDELITY (HARD ENFORCEMENT) ===
The LOSS DOMAIN FIDELITY section in the pipeline context above is MANDATORY.
- If the domain is INTERIOR_WATER with roof involvement "none" or "possible":
  * You MUST NOT use roof-specific arguments, shingle standards, ARMA guidelines, hail/wind terminology, IRC roofing sections, or manufacturer shingle specs.
  * Focus ONLY on water intrusion patterns, plumbing codes, moisture damage, mold risk, interior finish materials.
  * If roof is "possible" but unconfirmed, present roof involvement ONLY as a conditional hypothesis: "If the source of water ingress is determined to be the roof system, then..."
- If the domain is FIRE_SMOKE: Use fire/smoke-specific standards only (NFPA, smoke migration, char depth).
- If the domain is THEFT_VANDALISM: No weather or structural deterioration arguments.
- If the domain is VEHICLE_IMPACT: No weather causation or roofing terminology.
- If the domain is WIND_ONLY without confirmed roof involvement: Do not assume roof damage.
- ONLY if domain is ROOF_EXTERIOR or HAIL are roof-specific arguments permitted.
VIOLATION OF DOMAIN FIDELITY INVALIDATES THE OUTPUT.
`;
            }
            endStep(
              strategicPipelineStep,
              'completed',
              `context=${pipelineData.pipelineContext.length} chars, deltas=${pipelineData.deltaSummary || 'n/a'}`,
            );
          } else {
            endStep(strategicPipelineStep, 'completed', 'No additional pipeline context required');
          }
        } else {
          console.error(`[Strategic Pipeline] Pipeline call failed: ${pipelineResponse.status}`);
          endStep(strategicPipelineStep, 'error', `HTTP ${pipelineResponse.status}`);
          // Continue without pipeline - don't block the analysis
        }
      } catch (pipelineError) {
        console.error('[Strategic Pipeline] Pipeline error:', pipelineError);
        endStep(
          strategicPipelineStep,
          'error',
          pipelineError instanceof Error ? pipelineError.message : 'Unknown pipeline error',
        );
        // Continue without pipeline - graceful degradation
      }
    } else {
      markStep('strategic_pipeline', 'Run strategic 4-step pipeline', 'skipped', 'Not required for this analysis type');
    }
    // ═══ END STRATEGIC PIPELINE ═══

    // Call Lovable AI with model fallback chain for reliability
    const hasPdfContent = pdfContent || (pdfContents && pdfContents.length > 0) || additionalContext?.ourEstimatePdf || additionalContext?.insuranceEstimatePdf;
    const needsPdfProcessing = hasPdfContent && !additionalContext?._useTextOnly && ['denial_rebuttal', 'engineer_report_rebuttal', 'document_compilation', 'estimate_work_summary', 'supplement', 'demand_package', 'document_comparison', 'smart_extraction', 'estimate_gap_analysis', 'systematic_dismantling'].includes(analysisType);
    
    // Model fallback chain - use only Gemini models for PDF processing (OpenAI doesn't support PDF multimodal)
    // For text-only analysis, we can use OpenAI as fallback
    // IMPORTANT: gemini-3-flash-preview first as it's on newer infrastructure
    const modelFallbackChain = needsPdfProcessing ? [
      'google/gemini-3-flash-preview', // Newest model, different infrastructure - try first
      'google/gemini-2.5-flash',       // Fast option for PDFs
      'google/gemini-2.5-pro',         // Most capable for PDFs
      'google/gemini-3-pro-preview',   // Newer pro model
    ] : [
      'google/gemini-3-flash-preview', // Newest, fastest
      'openai/gpt-5-mini',             // Different provider fallback
      'google/gemini-2.5-flash',       // Fast Google fallback
      'openai/gpt-5.2',                // Most capable OpenAI (user's preference for Darwin)
      'openai/gpt-5-nano',             // Fast OpenAI fallback
    ];
    console.log(`Model fallback chain: ${modelFallbackChain.join(' -> ')} (PDF processing: ${needsPdfProcessing})`);
    
    // For task_followup, use tool calling to get structured actions
    const useTaskFollowupToolCalling = analysisType === 'task_followup' && !useStructuredDarwinOutput;
    let baseRequestBody: any = {
      messages,
      temperature: 0.7,
      max_tokens: 8000,
    };
    
    if (useTaskFollowupToolCalling) {
      baseRequestBody.tools = [
        {
          type: 'function',
          function: {
            name: 'provide_task_followup',
            description: 'Provide analysis and suggested follow-up actions for a task',
            parameters: {
              type: 'object',
              properties: {
                analysis: {
                  type: 'string',
                  description: 'Detailed analysis of the task including what it requires, why its important, urgency level, and recommended approach'
                },
                suggestedActions: {
                  type: 'array',
                  description: 'List of suggested follow-up actions',
                  items: {
                    type: 'object',
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['email', 'sms', 'note'],
                        description: 'Type of action'
                      },
                      title: {
                        type: 'string',
                        description: 'Brief title for the action'
                      },
                      content: {
                        type: 'string',
                        description: 'The actual content - email body, SMS message, or note text'
                      }
                    },
                    required: ['type', 'title', 'content']
                  }
                }
              },
              required: ['analysis', 'suggestedActions']
            }
          }
        }
      ];
      baseRequestBody.tool_choice = { type: 'function', function: { name: 'provide_task_followup' } };
    }
    
    // Model fallback with retries - more retries for PDF processing since fewer models available
    const RETRIES_PER_MODEL = needsPdfProcessing ? 3 : 1;
    const BASE_RETRY_DELAY_MS = 1500;
    const getRetryDelayMs = (attemptIndex: number) =>
      Math.min(8000, BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attemptIndex)));
    
    let aiData: any = null;
    let lastError: string = '';
    let successfulModel: string = '';
    let modelAttempts = 0;
    let modelFailures = 0;
    const modelLoopStartedAt = Date.now();
    const modelRunStep = startStep(
      'model_execution',
      'Run AI model with fallback chain',
      `models=${modelFallbackChain.join(' -> ')}`,
    );
    
    modelLoop:
    for (const currentModel of modelFallbackChain) {
      if (Date.now() - modelLoopStartedAt > MODEL_TOTAL_RUNTIME_LIMIT_MS) {
        lastError = `Model runtime limit exceeded (${Math.round(MODEL_TOTAL_RUNTIME_LIMIT_MS / 1000)}s).`;
        console.error(lastError);
        break;
      }
      console.log(`Trying model: ${currentModel}`);
      
      for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
        if (Date.now() - modelLoopStartedAt > MODEL_TOTAL_RUNTIME_LIMIT_MS) {
          lastError = `Model runtime limit exceeded (${Math.round(MODEL_TOTAL_RUNTIME_LIMIT_MS / 1000)}s).`;
          console.error(lastError);
          break modelLoop;
        }

        modelAttempts += 1;
        try {
          console.log(`  Attempt ${attempt + 1}/${RETRIES_PER_MODEL} for ${currentModel}`);
          
          const requestBody = { ...baseRequestBody, model: currentModel };
          const requestController = new AbortController();
          const timeoutId = setTimeout(() => requestController.abort(), MODEL_REQUEST_TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${LOVABLE_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
              signal: requestController.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          // Handle HTTP-level errors
          if (!response.ok) {
            const errorText = await response.text();
            lastError = `HTTP ${response.status} on ${currentModel}: ${errorText.substring(0, 200)}`;
            modelFailures += 1;
            console.error(`  AI Gateway HTTP error:`, response.status);
            
            // Don't retry on client errors (4xx) except 429
            if (response.status === 429) {
              endStep(modelRunStep, 'error', `Rate-limited after ${modelAttempts} attempts`);
              return new Response(
                JSON.stringify({ error: 'Rate limit exceeded. Please try again in a moment.' }),
                { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              );
            }
            if (response.status === 402) {
              endStep(modelRunStep, 'error', `Credits exhausted after ${modelAttempts} attempts`);
              return new Response(
                JSON.stringify({ error: 'AI usage limit reached. Please add credits to continue.' }),
                { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              );
            }
            // For 4xx errors (not 429/402), try next model immediately
            if (response.status >= 400 && response.status < 500) {
              console.log(`  Client error ${response.status}, trying next model...`);
              continue modelLoop;
            }
            
            // Retry on 5xx errors
            if (attempt < RETRIES_PER_MODEL - 1) {
              const delay = getRetryDelayMs(attempt);
              console.log(`  Retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            // Exhausted retries for this model, try next
            console.log(`  Exhausted retries for ${currentModel}, trying next model...`);
            continue modelLoop;
          }
          
          // Parse the response
          aiData = await response.json();
          
          // Log the raw response for debugging
          console.log(`  Response structure:`, JSON.stringify({
            hasChoices: !!aiData.choices,
            choicesLength: aiData.choices?.length,
            hasMessage: !!aiData.choices?.[0]?.message,
            contentType: typeof aiData.choices?.[0]?.message?.content,
            contentLength: aiData.choices?.[0]?.message?.content?.length,
            finishReason: aiData.choices?.[0]?.finish_reason,
            error: aiData.error
          }));
          
          // Check if there was an error in the response body
          if (aiData.error) {
            const errorCode = aiData.error.code || aiData.error.status || 0;
            const errorMsg = aiData.error.message || aiData.error || 'Unknown error';
            lastError = `API Error ${errorCode} on ${currentModel}: ${errorMsg}`;
            modelFailures += 1;
            console.error('  AI Gateway returned error in body:', aiData.error);
            
            // Retry on server errors (5xx codes in the body)
            if (errorCode >= 500 && attempt < RETRIES_PER_MODEL - 1) {
              const delay = getRetryDelayMs(attempt);
              console.log(`  Retrying due to API error ${errorCode} in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            // Try next model
            console.log(`  Error from ${currentModel}, trying next model...`);
            continue modelLoop;
          }
          
          // Check if we got valid choices
          if (!aiData.choices || aiData.choices.length === 0) {
            lastError = `No choices from ${currentModel}`;
            modelFailures += 1;
            console.error('  AI Gateway returned no choices');
            
            if (attempt < RETRIES_PER_MODEL - 1) {
              const delay = getRetryDelayMs(attempt);
              console.log(`  Retrying due to empty response in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            // Try next model
            console.log(`  No choices from ${currentModel}, trying next model...`);
            continue modelLoop;
          }
          
          // Success!
          successfulModel = currentModel;
          console.log(`  SUCCESS with model ${currentModel}!`);
          endStep(modelRunStep, 'completed', `model=${successfulModel}, attempts=${modelAttempts}, failures=${modelFailures}`);
          break modelLoop;
          
        } catch (fetchError) {
          const isAbortTimeout = fetchError instanceof Error && fetchError.name === 'AbortError';
          console.error(`  Fetch error (attempt ${attempt + 1}):`, fetchError);
          lastError = isAbortTimeout
            ? `Request timeout after ${Math.round(MODEL_REQUEST_TIMEOUT_MS / 1000)}s on ${currentModel}`
            : (fetchError instanceof Error ? fetchError.message : 'Network error');
          modelFailures += 1;
          
          if (attempt < RETRIES_PER_MODEL - 1) {
            const delay = getRetryDelayMs(attempt);
            console.log(`  Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          // If exhausted retries, will continue to next model
        }
      }
    }
    
    if (!aiData || !aiData.choices || aiData.choices.length === 0) {
      endStep(modelRunStep, 'error', `attempts=${modelAttempts}, failures=${modelFailures}, error=${lastError}`);
      console.error('All models failed:', lastError);
      throw new Error(`AI Gateway temporarily unavailable. Tried ${modelFallbackChain.length} models. ${lastError}`);
    }
    
    console.log(`Darwin AI analysis completed using model: ${successfulModel}`);

    const parseStep = startStep('parse_model_output', 'Parse model output');

    // For task_followup in legacy mode, parse the tool call response
    let suggestedActions: Array<{type: string; title: string; content: string}> = [];
    let analysisResult = '';
    
    if (useTaskFollowupToolCalling) {
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (toolCall?.function?.arguments) {
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          analysisResult = parsed.analysis || 'No analysis generated';
          suggestedActions = parsed.suggestedActions || [];
          console.log(`Parsed ${suggestedActions.length} suggested actions from tool call`);
        } catch (e) {
          console.error('Failed to parse tool call response:', e);
          analysisResult = aiData.choices?.[0]?.message?.content || 'No analysis generated';
        }
      } else {
        analysisResult = aiData.choices?.[0]?.message?.content || 'No analysis generated';
      }
    } else {
      // Extract content - handle both string and potential array formats
      const messageContent = aiData.choices?.[0]?.message?.content;
      
      if (typeof messageContent === 'string' && messageContent.trim()) {
        analysisResult = messageContent;
      } else if (Array.isArray(messageContent)) {
        // Some models return content as array of parts
        analysisResult = messageContent
          .filter((part: any) => part.type === 'text' && part.text)
          .map((part: any) => part.text)
          .join('\n') || 'No analysis generated';
      } else {
        // Log what we actually got for debugging
        console.error('Unexpected content format:', JSON.stringify(messageContent));
        
        // Check finish_reason - if it's 'length', the response was cut off
        const finishReason = aiData.choices?.[0]?.finish_reason;
        if (finishReason === 'length') {
          analysisResult = 'Analysis was too long and got truncated. Please try with fewer documents.';
        } else if (finishReason === 'content_filter') {
          analysisResult = 'Content was filtered by the AI model. Please try with different documents.';
        } else {
          analysisResult = 'No analysis generated - the AI model returned an empty response. Please try again.';
        }
      }
    }

    let structuredResult: DarwinStructuredResult | null = null;
    if (useStructuredDarwinOutput) {
      structuredResult = parseStructuredResponse(analysisResult);
      analysisResult = JSON.stringify(structuredResult, null, 2);
    }
    endStep(parseStep, 'completed', `resultLength=${analysisResult.length}`);
    
    console.log(`Darwin AI Analysis completed for ${analysisType}, result length: ${analysisResult.length}`);

    // Save analysis result to database for future reference
    const inputSummary = pdfFileName 
      ? `PDF: ${pdfFileName}` 
      : additionalContext?.trigger_reason || `${analysisType} analysis`;
    
    const saveStep = startStep('persist_analysis', 'Persist analysis snapshot');
    try {
      const { error: saveError } = await supabase
        .from('darwin_analysis_results')
        .insert({
          claim_id: claimId,
          analysis_type: analysisType,
          input_summary: inputSummary.substring(0, 500), // Truncate if too long
          result: analysisResult,
          pdf_file_name: pdfFileName || null,
        });
      
      if (saveError) {
        console.error('Failed to save analysis result:', saveError);
        endStep(saveStep, 'error', saveError.message);
      } else {
        console.log(`Analysis result saved to darwin_analysis_results for claim ${claimId}`);
        endStep(saveStep, 'completed');
      }
    } catch (saveErr) {
      console.error('Error saving analysis result:', saveErr);
      endStep(saveStep, 'error', saveErr instanceof Error ? saveErr.message : 'Unknown save error');
      // Don't fail the request if save fails
    }

    // ═══ UNIVERSAL CARRIER DISMANTLER POST-PROCESSOR (unless enableDismantler=false) ═══
    let carrierDismantlerResult: DismantlerResult | null = null;
    const dismantlerStep = startStep('carrier_dismantler', 'Run carrier dismantler middleware');
    try {
      const shouldRunDismantler =
        enableDismantler &&
        analysisType !== 'systematic_dismantling' &&
        !useStructuredDarwinOutput;

      if (shouldRunDismantler && analysisResult) {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

        if (supabaseUrl && supabaseServiceKey) {
          const audienceHint =
            additionalContext?.audience ||
            (carrierFacingTypes.includes(analysisType) ? 'carrier' : 'internal');

          const middlewareBody: AnalysisRequest = {
            claimId,
            analysisType: 'systematic_dismantling',
            contextData: {
              baseAnalysisType: analysisType,
              baseResult: analysisResult,
              claimFactsPack: claimFactsPack || undefined,
            },
            additionalContext: {
              ...additionalContext,
              audience: audienceHint,
              _middleware: true,
            },
          };

          const dismantlerResp = await fetch(
            `${supabaseUrl}/functions/v1/darwin-ai-analysis`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${supabaseServiceKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(middlewareBody),
            },
          );

          if (dismantlerResp.ok) {
            const dismantlerJson = await dismantlerResp.json();
            const rawResult =
              dismantlerJson.result ||
              dismantlerJson.analysis ||
              dismantlerJson.carrierDismantler ||
              null;
            const rawText = typeof rawResult === 'string' ? rawResult : (rawResult && typeof rawResult === 'object' ? null : JSON.stringify(rawResult));
            let parsed: any = null;
            if (typeof rawResult === 'object' && rawResult !== null && typeof rawResult.confidence !== 'undefined') {
              parsed = rawResult;
            } else if (rawText) {
              let toParse = rawText.trim();
              const codeFence = toParse.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/m);
              if (codeFence) toParse = codeFence[1].trim();
              try {
                parsed = JSON.parse(toParse);
              } catch (_) {
                const jsonStart = rawText.lastIndexOf('{"confidence"');
                const altStart = rawText.lastIndexOf('{"missingDocs"');
                const idx = jsonStart >= 0 ? jsonStart : (altStart >= 0 ? altStart : -1);
                if (idx >= 0) {
                  try {
                    parsed = JSON.parse(rawText.substring(idx).trim());
                  } catch (_2) {}
                }
              }
            }
            const roundConf = (n: number): DismantlerConfidence => {
              if (n <= 0) return 0;
              if (n <= 0.25) return 0.25;
              if (n <= 0.5) return 0.5;
              if (n <= 0.75) return 0.75;
              return 1;
            };
            if (parsed && typeof parsed.confidence !== 'undefined' && Array.isArray(parsed.missingDocs)) {
              const notesForUser = Array.isArray(parsed.notesForUser) ? [...parsed.notesForUser] : [];
              let missingDocs = [...parsed.missingDocs];
              const policyDocNames = new Set<string>();
              if (claimFactsPack?.documents?.length) {
                for (const d of claimFactsPack.documents) {
                  if (d.docName && isPolicyDoc(d)) policyDocNames.add(d.docName);
                }
              }

              // 1) Build result with raw evidence (evidenceMethod, spanHint included)
              const objections: DismantlerObjection[] = Array.isArray(parsed.objections) ? parsed.objections.map((o: any) => {
                const evidence: DismantlerEvidenceChip[] = Array.isArray(o.evidence) ? o.evidence.map((e: any) => ({
                  docId: e.docId,
                  docName: e.docName || '',
                  page: e.page,
                  sectionHint: e.sectionHint,
                  quote: e.quote,
                  evidenceMethod: ['quote', 'table', 'inference'].includes(e.evidenceMethod) ? e.evidenceMethod : undefined,
                  spanHint: e.spanHint && (e.spanHint.startLine != null || e.spanHint.endLine != null) ? { startLine: e.spanHint.startLine, endLine: e.spanHint.endLine } : undefined,
                  basis: typeof e.basis === 'string' ? e.basis.trim().slice(0, 300) : undefined,
                })) : [];
                const chipCount = evidence.length;
                const hasQuote = evidence.some((e) => e.quote && e.quote.trim().length > 0);
                const atLeastOneQuote = evidence.some((e) => e.evidenceMethod === 'quote' || (e.quote && e.quote.trim().length > 0));
                const atLeastOneTable = evidence.some((e) => e.evidenceMethod === 'table');
                const atLeastOneQuoteOrTable = atLeastOneQuote || atLeastOneTable;
                const hasQuoteOrTable = evidence.some((e) => e.evidenceMethod === 'quote' || e.evidenceMethod === 'table' || (e.quote && e.quote.trim().length > 0));
                const atLeastOneDocId = evidence.some((e) => !!e.docId);
                const inferenceOnly = chipCount > 0 && evidence.every((e) => e.evidenceMethod === 'inference' || !e.evidenceMethod);
                const policyTypes = ['Coverage interpretation', 'Exclusion', 'Limit/Deductible'];
                const isPolicyTypeObjection = policyTypes.some((t) => o.type && o.type.includes(t));
                const hasPolicyChip = !isPolicyTypeObjection || evidence.some((e) => e.docName && policyDocNames.has(e.docName));
                // Deterministic rubric: strong = ≥2 chips AND (≥1 quote OR ≥1 table) AND docId AND policy-chip when required; ok = ≥1 quote/table; else weak.
                let evidenceStrength: EvidenceStrength = (o.evidenceStrength && ['weak', 'ok', 'strong'].includes(o.evidenceStrength)) ? o.evidenceStrength : undefined as any;
                if (evidenceStrength == null) {
                  if (chipCount === 0 || inferenceOnly || !atLeastOneDocId || !hasPolicyChip) evidenceStrength = 'weak';
                  else if (chipCount >= 2 && atLeastOneQuoteOrTable && atLeastOneDocId && hasPolicyChip) evidenceStrength = 'strong';
                  else if (hasQuoteOrTable) evidenceStrength = 'ok';
                  else evidenceStrength = 'weak';
                }
                return {
                  verbatim: o.verbatim || '',
                  type: o.type || 'unknown',
                  whyItFails: o.whyItFails || '',
                  evidence,
                  requestedResolution: o.requestedResolution || '',
                  evidenceStrength,
                };
              }) : [];

              // 2) No-policy-language guardrail: types that must cite policy
              let policyGuardrailTriggeredCount = 0;
              const policyTypesGuardrail = ['Coverage interpretation', 'Exclusion', 'Limit/Deductible'];
              for (const obj of objections) {
                const needsPolicy = policyTypesGuardrail.some((t) => obj.type && obj.type.includes(t));
                if (!needsPolicy) continue;
                const hasPolicyEvidence = obj.evidence.some((e) => e.docName && policyDocNames.has(e.docName));
                if (!hasPolicyEvidence && policyDocNames.size > 0) {
                  missingDocs = [...missingDocs, 'Policy page or endorsement citing the provision at issue'];
                  notesForUser.push(`Objection "${obj.type}" should cite policy language; add policy doc or state conditionally.`);
                  policyGuardrailTriggeredCount++;
                }
              }

              // 4) Resolve docName → docId only when unique (duplicate docNames => do not assign; add note)
              let duplicateDocNameCount = 0;
              if (claimFactsPack?.documents?.length) {
                const nameToIds = new Map<string, string[]>();
                for (const d of claimFactsPack.documents) {
                  if (!d.docName) continue;
                  const list = nameToIds.get(d.docName) ?? [];
                  list.push(d.docId);
                  nameToIds.set(d.docName, list);
                }
                const duplicateNames = new Set<string>();
                for (const obj of objections) {
                  for (const e of obj.evidence) {
                    if (e.docId || !e.docName) continue;
                    const ids = nameToIds.get(e.docName);
                    if (ids?.length === 1) (e as any).docId = ids[0];
                    else if (ids && ids.length > 1) duplicateNames.add(e.docName);
                  }
                }
                duplicateDocNameCount = duplicateNames.size;
                for (const name of duplicateNames) {
                  notesForUser.push(`Multiple docs named "${name}"; cannot resolve docId.`);
                }
              }

              // 5) Trim quotes to ≤25 words (after docId fill)
              for (const obj of objections) {
                for (const e of obj.evidence) {
                  if (e.quote && e.quote.split(/\s+/).length > 25) {
                    (e as any).quote = e.quote.split(/\s+/).slice(0, 25).join(' ');
                  }
                }
              }

              // 6) Clamp confidence
              let confidence = roundConf(Number(parsed.confidence));

              // 7) Enforce: no evidence => lower confidence only when 1 objection or ≥2 with no evidence
              const noEvidenceCount = objections.filter((o) => o.evidence.length === 0 && (o.verbatim || o.whyItFails)).length;
              const shouldClamp = objections.length === 1 ? noEvidenceCount >= 1 : noEvidenceCount >= 2;
              if (shouldClamp && noEvidenceCount > 0) {
                if (confidence > 0.25) confidence = 0.25;
                notesForUser.push(`Objection(s) without evidence cited; add docs to strengthen.`);
              }

              const dismantlerMissingDocRequests: MissingDocRequest[] = Array.isArray(parsed.missingDocRequests)
                ? parsed.missingDocRequests.filter((r: any) => r && typeof r.key === 'string' && typeof r.title === 'string' && typeof r.whyNeeded === 'string')
                  .map((r: any) => ({
                    key: r.key,
                    title: r.title,
                    whyNeeded: r.whyNeeded,
                    whereToFind: r.whereToFind,
                    priority: ['high', 'med', 'low'].includes(r.priority) ? r.priority : 'med',
                  }))
                : [];
              const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 48) || 'card';
              const decisionCards: DecisionCard[] = Array.isArray(parsed.decisionCards)
                ? parsed.decisionCards.filter((c: any) => c && typeof c.decision === 'string' && Array.isArray(c.requiredFacts) && Array.isArray(c.requiredDocs) && typeof c.ifTrue === 'string' && typeof c.ifFalse === 'string')
                  .map((c: any) => ({
                    key: (c.key && typeof c.key === 'string' && c.key.trim()) ? slug(c.key.trim()) : slug(c.decision),
                    decision: c.decision,
                    requiredFacts: c.requiredFacts || [],
                    requiredDocs: c.requiredDocs || [],
                    ifTrue: c.ifTrue,
                    ifFalse: c.ifFalse,
                  }))
                : [];

              const mergedMissingDocRequests = mergeMissingDocRequests(claimFactsPack?.missingDocRequests, dismantlerMissingDocRequests.length ? dismantlerMissingDocRequests : undefined);

              carrierDismantlerResult = {
                confidence,
                missingDocs,
                missingDocRequests: mergedMissingDocRequests.length ? mergedMissingDocRequests : undefined,
                objections,
                requestedResolutionOverall: parsed.requestedResolutionOverall || '',
                notesForUser,
                decisionCards: decisionCards.length ? decisionCards : undefined,
              };
              const noEvidenceObjectionCount = objections.filter((o) => o.evidence.length === 0).length;
              const inferenceChipCount = objections.reduce((s, o) => s + o.evidence.filter((e) => e.evidenceMethod === 'inference').length, 0);
              logDismantlerTelemetry({
                objectionsWithEvidencePct: objections.length ? objections.filter((o) => o.evidence.length > 0).length / objections.length : 0,
                avgEvidencePerObjection: objections.length ? objections.reduce((s, o) => s + o.evidence.length, 0) / objections.length : 0,
                topMissingDocRequestKeys: mergedMissingDocRequests.map((r) => r.key),
                parseSuccess: true,
                confidence,
                objectionCount: objections.length,
                decisionCardCount: (decisionCards ?? []).length,
                policyGuardrailTriggeredCount,
                noEvidenceObjectionCount,
                duplicateDocNameCount,
                inferenceChipCount,
              });
            } else {
              const conf = parsed && typeof parsed.confidence === 'number' ? roundConf(parsed.confidence) : 0.5;
              const missing = (parsed && Array.isArray(parsed.missingDocs) ? parsed.missingDocs : []) as string[];
              carrierDismantlerResult = {
                confidence: conf,
                missingDocs: missing,
                objections: [],
                requestedResolutionOverall: rawText?.replace(/\n?\{[^{}]*"confidence"[^{}]*\}\s*$/m, '').trim() || '',
                notesForUser: missing.map((d: string) => `Request: ${d}`),
              };
              logDismantlerTelemetry({
                objectionsWithEvidencePct: 0,
                avgEvidencePerObjection: 0,
                topMissingDocRequestKeys: [],
                parseSuccess: false,
                confidence: conf,
                objectionCount: 0,
                decisionCardCount: 0,
                policyGuardrailTriggeredCount: 0,
                noEvidenceObjectionCount: 0,
                duplicateDocNameCount: 0,
                inferenceChipCount: 0,
              });
            }
            endStep(
              dismantlerStep,
              'completed',
              `confidence=${carrierDismantlerResult?.confidence ?? 'n/a'}, objections=${carrierDismantlerResult?.objections?.length ?? 0}`,
            );
          } else {
            console.error(
              'Carrier Dismantler middleware call failed:',
              dismantlerResp.status,
            );
            endStep(dismantlerStep, 'error', `HTTP ${dismantlerResp.status}`);
          }
        } else {
          endStep(dismantlerStep, 'error', 'Missing Supabase environment secrets');
        }
      } else {
        endStep(dismantlerStep, 'skipped', 'Not applicable for this analysis type');
      }
    } catch (middlewareErr) {
      console.error(
        'Carrier Dismantler middleware error (non-fatal):',
        middlewareErr,
      );
      endStep(
        dismantlerStep,
        'error',
        middlewareErr instanceof Error ? middlewareErr.message : 'Unknown middleware error',
      );
    }

    if (useStructuredDarwinOutput && structuredResult) {
      return new Response(
        JSON.stringify(structuredResult),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const responseBuildStep = startStep('response', 'Build response payload');
    const responsePayload: any = {
      success: true,
      analysisType,
      result: analysisResult,
      analysis: analysisResult,
      suggestedActions,
      carrierDismantler: carrierDismantlerResult,
      claimId,
    };
    if (claimFactsPack) responsePayload.claimFactsPack = claimFactsPack;
    responsePayload.executionSteps = executionSteps;
    responsePayload.processingMetrics = {
      totalDurationMs: Date.now() - operationStartedAt,
      successfulModel,
      modelAttempts,
      modelFailures,
      fallbackModelsTried: modelFallbackChain.length,
      usedToolCalling: useTaskFollowupToolCalling,
      strategicPipelineApplied: STRATEGIC_PIPELINE_TYPES.includes(analysisType),
    };
    endStep(responseBuildStep, 'completed', `durationMs=${responsePayload.processingMetrics.totalDurationMs}`);
    return new Response(
      JSON.stringify(responsePayload),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error: any) {
    console.error('Darwin AI Analysis error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
