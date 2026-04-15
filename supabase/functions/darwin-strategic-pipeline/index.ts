import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generate } from "../_shared/ai/generate.ts";
import { searchTavily } from "../_shared/ai/tavily.ts";
import { getClaimsContextBundle, formatContextBundle } from "../_shared/ai/claimsKnowledgeEngine.ts";
import { formatDismantlerForPrompt, type DismantlerResult } from "../_shared/ai/universalDismantler.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Strategic output types that MUST go through the pipeline
const STRATEGIC_TYPES = [
  'denial_rebuttal',
  'demand_package',
  'next_steps',
  'auto_draft_rebuttal',
  'systematic_dismantling',
  'correspondence',
  'one_click_package',
  'engineer_report_rebuttal',
  'supplement',
  'estimate_gap_analysis',
];

interface PipelineRequest {
  claimId: string;
  analysisType: string;
  forceRefresh?: boolean;
}

// Loss domain definitions
type LossDomain = 'roof_exterior' | 'interior_water' | 'fire_smoke' | 'theft_vandalism' | 'vehicle_impact' | 'wind_only' | 'hail' | 'mixed' | 'unknown';

interface LossDomainClassification {
  domain: LossDomain;
  confidence: 'confirmed' | 'probable' | 'conditional';
  roofInvolvement: 'confirmed' | 'possible' | 'none' | 'unknown';
  reasoning: string;
  unansweredQuestions: string[];
}

interface ThesisObject {
  primary_cause_of_loss: string;
  primary_coverage_theory: string;
  primary_carrier_error: string;
  evidence_map: Array<{ type: 'document' | 'photo'; id: string; name: string; relevance: string }>;
  anticipated_pushback: string;
  pushback_counter: string;
  loss_domain: LossDomainClassification;
}

// ─── STEP A: Load Memory ───────────────────────────────────────────────

async function loadMemory(supabase: any, claimId: string, claim: any) {
  console.log(`[Pipeline Step A] Loading memory for claim ${claimId}`);

  // 1. Claim memory snapshot: latest strategic insights + declared position + last analysis results
  const [
    insightsResult,
    positionResult,
    recentAnalysesResult,
    filesResult,
    photosResult,
    notesResult,
    emailsResult,
    checksResult,
    settlementsResult,
  ] = await Promise.all([
    supabase.from('claim_strategic_insights').select('*').eq('claim_id', claimId).maybeSingle(),
    supabase.from('declared_positions').select('*').eq('claim_id', claimId).eq('is_locked', true).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('darwin_analysis_results').select('analysis_type, result, created_at, pdf_file_name').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(10),
    supabase.from('claim_files').select('id, file_name, document_classification, classification_metadata, uploaded_at, extracted_text').eq('claim_id', claimId),
    supabase.from('claim_photos').select('id, file_name, category, ai_analyzed_at, ai_condition_rating, ai_detected_damages, ai_material_type, ai_analysis_summary').eq('claim_id', claimId),
    supabase.from('notes').select('id, content, created_at').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(10),
    supabase.from('emails').select('id, subject, body_text, direction, created_at').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(10),
    supabase.from('claim_checks').select('*').eq('claim_id', claimId),
    supabase.from('claim_settlements').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(1),
  ]);

  const memorySnapshot = {
    strategicInsights: insightsResult.data || null,
    declaredPosition: positionResult.data || null,
    recentAnalyses: recentAnalysesResult.data || [],
    files: filesResult.data || [],
    photos: photosResult.data || [],
    notes: notesResult.data || [],
    emails: emailsResult.data || [],
    checks: checksResult.data || [],
    settlement: settlementsResult.data || null,
  };

  // 2. Recent deltas since last thesis/analysis
  const { data: existingThesis } = await supabase
    .from('claim_thesis_objects')
    .select('last_deltas_reviewed_at, updated_at')
    .eq('claim_id', claimId)
    .maybeSingle();

  const lastReviewedAt = existingThesis?.last_deltas_reviewed_at || existingThesis?.updated_at || '1970-01-01';

  const [newFilesResult, newNotesResult, newEmailsResult] = await Promise.all([
    supabase.from('claim_files').select('id, file_name, document_classification, uploaded_at').eq('claim_id', claimId).gt('uploaded_at', lastReviewedAt),
    supabase.from('notes').select('id, content, created_at').eq('claim_id', claimId).gt('created_at', lastReviewedAt),
    supabase.from('emails').select('id, subject, direction, created_at').eq('claim_id', claimId).gt('created_at', lastReviewedAt),
  ]);

  const deltas = {
    newFiles: newFilesResult.data || [],
    newNotes: newNotesResult.data || [],
    newEmails: newEmailsResult.data || [],
    hasDelta: (newFilesResult.data?.length || 0) + (newNotesResult.data?.length || 0) + (newEmailsResult.data?.length || 0) > 0,
  };

  // 3. Top 5 cross-claim lessons based on (carrier, loss type, denial theme)
  const carrier = claim.insurance_company || '';
  const lossType = claim.loss_type || '';

  // Find outcomes from similar claims
  const { data: crossClaimLessons } = await supabase
    .from('claim_outcomes')
    .select(`
      id, claim_id, initial_estimate, final_settlement, recovery_percentage,
      winning_arguments, effective_evidence, key_leverage_points, failed_arguments,
      resolution_type, notes,
      claims!inner(insurance_company, loss_type, status)
    `)
    .neq('claim_id', claimId)
    .order('created_at', { ascending: false })
    .limit(50);

  // Score and rank lessons by relevance
  const scoredLessons = (crossClaimLessons || []).map((lesson: any) => {
    let score = 0;
    if (lesson.claims?.insurance_company?.toLowerCase() === carrier.toLowerCase()) score += 3;
    if (lesson.claims?.loss_type?.toLowerCase() === lossType.toLowerCase()) score += 2;
    if (lesson.winning_arguments && Object.keys(lesson.winning_arguments).length > 0) score += 1;
    return { ...lesson, relevanceScore: score };
  })
    .filter((l: any) => l.relevanceScore > 0)
    .sort((a: any, b: any) => b.relevanceScore - a.relevanceScore)
    .slice(0, 5);

  // 4. Cached industry notes matching (state, peril, material, denial theme)
  const state = claim.policyholder_address?.match(/\b([A-Z]{2})\b/)?.[1] || 'NJ';
  const { data: cachedNotes } = await supabase
    .from('industry_notes_cache')
    .select('*')
    .gt('expires_at', new Date().toISOString())
    .or(`state_code.eq.${state},state_code.is.null`)
    .limit(10);

  // Filter further by relevance
  const relevantNotes = (cachedNotes || []).filter((note: any) => {
    if (note.peril && lossType && !lossType.toLowerCase().includes(note.peril.toLowerCase())) return false;
    return true;
  });

  console.log(`[Pipeline Step A] Memory loaded: ${memorySnapshot.files.length} files, ${deltas.hasDelta ? 'has new deltas' : 'no new deltas'}, ${scoredLessons.length} cross-claim lessons, ${relevantNotes.length} industry notes`);

  return { memorySnapshot, deltas, crossClaimLessons: scoredLessons, industryNotes: relevantNotes, state };
}

// ─── STEP B: Decide if Web Search Needed ───────────────────────────────

async function decideWebSearch(
  supabase: any,
  claim: any,
  memorySnapshot: any,
  industryNotes: any[],
  state: string,
): Promise<{ needed: boolean; queries: string[]; reasons: string[] }> {
  console.log(`[Pipeline Step B] Evaluating web search need`);

  const queries: string[] = [];
  const reasons: string[] = [];

  // 1. State regulation referenced but not cached or expired?
  const hasStateRegulation = industryNotes.some(
    (n: any) => n.source_type === 'regulation' && n.state_code === state,
  );
  if (!hasStateRegulation) {
    queries.push(`${state} state insurance regulations property damage claims unfair claims settlement practices statute`);
    reasons.push(`State regulation for ${state} not cached`);
  }

  // 2. Manufacturer spec referenced but not cached?
  // Check if photos identified specific materials
  const materials = memorySnapshot.photos
    ?.map((p: any) => p.ai_material_type)
    .filter(Boolean)
    .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i) || [];

  for (const material of materials.slice(0, 2)) {
    const hasMaterialSpec = industryNotes.some(
      (n: any) => n.source_type === 'manufacturer_spec' && n.material?.toLowerCase() === material.toLowerCase(),
    );
    if (!hasMaterialSpec) {
      queries.push(`${material} manufacturer installation specifications warranty requirements`);
      reasons.push(`Manufacturer spec for ${material} not cached`);
    }
  }

  // 3. Weather validation for DOL not in file?
  const hasWeatherFile = memorySnapshot.files?.some(
    (f: any) =>
      f.document_classification === 'weather_report' ||
      f.document_classification === 'storm_report' ||
      f.file_name?.toLowerCase().includes('weather') ||
      f.file_name?.toLowerCase().includes('storm'),
  );
  if (!hasWeatherFile && claim.loss_date) {
    queries.push(
      `severe weather ${claim.policyholder_address || ''} ${claim.loss_date} hail wind storm damage reports NOAA NWS`,
    );
    reasons.push('Weather validation for DOL not in claim files');
  }

  const needed = queries.length > 0;
  console.log(`[Pipeline Step B] Web search ${needed ? 'NEEDED' : 'NOT needed'}. Reasons: ${reasons.join('; ') || 'none'}`);

  return { needed, queries, reasons };
}

async function executeWebSearches(queries: string[]): Promise<Array<{ query: string; result: string }>> {
  const results: Array<{ query: string; result: string }> = [];

  // Execute searches via shared Tavily layer (max 3 to control cost/latency)
  for (const query of queries.slice(0, 3)) {
    try {
      const tavilyResult = await searchTavily(query, 'basic');
      if (tavilyResult && tavilyResult.answer) {
        const sourceSummary = tavilyResult.sources.slice(0, 3)
          .map((s, i) => `[${i + 1}] ${s.title} (${s.url})`)
          .join('\n');
        results.push({ query, result: `${tavilyResult.answer}\n\nSources:\n${sourceSummary}` });
        console.log(`[Pipeline Step B] Tavily search succeeded for: ${query.slice(0, 60)}...`);
      }
    } catch (error) {
      console.error(`Web search error for: ${query}`, error);
    }
  }

  return results;
}

// ─── Loss Domain Classification ───────────────────────────────────────

function classifyLossDomain(claim: any, memorySnapshot: any): LossDomainClassification {
  const lossType = (claim.loss_type || '').toLowerCase();
  const description = (claim.loss_description || '').toLowerCase();
  const combined = `${lossType} ${description}`;

  // Photo-based evidence for roof involvement
  const roofPhotos = (memorySnapshot.photos || []).filter((p: any) => {
    const cat = (p.category || '').toLowerCase();
    const name = (p.file_name || '').toLowerCase();
    return cat.includes('roof') || name.includes('roof') || name.includes('shingle');
  });
  const interiorPhotos = (memorySnapshot.photos || []).filter((p: any) => {
    const cat = (p.category || '').toLowerCase();
    const name = (p.file_name || '').toLowerCase();
    return cat.includes('interior') || name.includes('interior') || name.includes('ceiling') || name.includes('wall') || name.includes('floor');
  });

  // File-based evidence
  const fileNames = (memorySnapshot.files || []).map((f: any) => (f.file_name || '').toLowerCase()).join(' ');

  // Classify
  if (/fire|smoke|burn|char|flame|arson/i.test(combined)) {
    return {
      domain: 'fire_smoke',
      confidence: 'confirmed',
      roofInvolvement: /roof/i.test(combined) ? 'possible' : 'none',
      reasoning: `Loss type "${claim.loss_type}" and description indicate fire/smoke damage`,
      unansweredQuestions: [],
    };
  }

  if (/theft|vandal|break.?in|stolen|burglary/i.test(combined)) {
    return {
      domain: 'theft_vandalism',
      confidence: 'confirmed',
      roofInvolvement: 'none',
      reasoning: `Loss type "${claim.loss_type}" indicates theft/vandalism`,
      unansweredQuestions: [],
    };
  }

  if (/vehicle|car|truck|auto|collision|impact/i.test(combined)) {
    return {
      domain: 'vehicle_impact',
      confidence: 'confirmed',
      roofInvolvement: 'none',
      reasoning: `Loss type "${claim.loss_type}" indicates vehicle impact`,
      unansweredQuestions: [],
    };
  }

  if (/water|flood|pipe|leak|plumb|sewer|overflow|burst|mold|moisture/i.test(combined)) {
    // Interior water — but check if roof is explicitly mentioned as source
    const roofMentionedAsSource = /roof.*leak|leak.*roof|roof.*water|water.*roof|roof.*drip/i.test(combined);
    const hasRoofEvidence = roofPhotos.length > 0 || /roof/i.test(fileNames);

    if (roofMentionedAsSource && hasRoofEvidence) {
      return {
        domain: 'interior_water',
        confidence: 'confirmed',
        roofInvolvement: 'confirmed',
        reasoning: 'Water damage with confirmed roof involvement based on description and evidence',
        unansweredQuestions: [],
      };
    }
    if (roofMentionedAsSource || hasRoofEvidence) {
      return {
        domain: 'interior_water',
        confidence: 'probable',
        roofInvolvement: 'possible',
        reasoning: 'Water damage with possible roof involvement — needs confirmation',
        unansweredQuestions: [
          'Has a roof inspection confirmed the water entry point?',
          'Is there visible roof damage directly above the interior water damage?',
          'Could the water source be plumbing, HVAC condensation, or appliance failure instead?',
        ],
      };
    }
    return {
      domain: 'interior_water',
      confidence: 'confirmed',
      roofInvolvement: 'none',
      reasoning: 'Water damage with no evidence of roof involvement',
      unansweredQuestions: [],
    };
  }

  if (/hail/i.test(combined)) {
    return {
      domain: 'hail',
      confidence: 'confirmed',
      roofInvolvement: 'confirmed',
      reasoning: 'Hail damage — roof/exterior involvement inherent',
      unansweredQuestions: [],
    };
  }

  if (/wind|hurricane|tornado|cyclone/i.test(combined)) {
    if (interiorPhotos.length > 0 && roofPhotos.length === 0 && !/roof|shingle/i.test(combined)) {
      return {
        domain: 'wind_only',
        confidence: 'probable',
        roofInvolvement: 'possible',
        reasoning: 'Wind damage claimed but only interior evidence found. Roof involvement unconfirmed.',
        unansweredQuestions: [
          'Has the roof been inspected for wind damage?',
          'Is the interior damage from wind-driven rain through a roof breach, or from windows/doors?',
        ],
      };
    }
    return {
      domain: 'wind_only',
      confidence: 'confirmed',
      roofInvolvement: roofPhotos.length > 0 || /roof|shingle/i.test(combined) ? 'confirmed' : 'possible',
      reasoning: 'Wind damage — checking for roof/exterior involvement',
      unansweredQuestions: roofPhotos.length > 0 ? [] : ['Has a roof inspection been performed to confirm wind damage to roof system?'],
    };
  }

  if (/roof|shingle|gutter|siding|exterior|fascia|soffit/i.test(combined)) {
    return {
      domain: 'roof_exterior',
      confidence: 'confirmed',
      roofInvolvement: 'confirmed',
      reasoning: 'Explicitly roof/exterior claim',
      unansweredQuestions: [],
    };
  }

  // Mixed or unclear
  if (interiorPhotos.length > 0 && roofPhotos.length > 0) {
    return {
      domain: 'mixed',
      confidence: 'probable',
      roofInvolvement: 'confirmed',
      reasoning: 'Both interior and roof/exterior evidence present',
      unansweredQuestions: [],
    };
  }

  return {
    domain: 'unknown',
    confidence: 'conditional',
    roofInvolvement: 'unknown',
    reasoning: `Loss type "${claim.loss_type || 'not specified'}" does not clearly map to a domain. Manual classification recommended.`,
    unansweredQuestions: [
      'What is the primary area of damage (roof/exterior, interior, or both)?',
      'What peril caused the damage?',
    ],
  };
}

// ─── STEP C: Build/Validate Claim Thesis Object ───────────────────────

async function buildThesisObject(
  supabase: any,
  claimId: string,
  claim: any,
  memorySnapshot: any,
  deltas: any,
  crossClaimLessons: any[],
  industryNotes: any[],
  webSearchResults: any[],
  forceRefresh: boolean,
): Promise<{ thesis: ThesisObject; isNew: boolean; validationErrors: string[] }> {
  console.log(`[Pipeline Step C] Building Claim Thesis Object`);

  // Classify loss domain
  const lossDomain = classifyLossDomain(claim, memorySnapshot);
  console.log(`[Pipeline Step C] Loss domain: ${lossDomain.domain} (roof: ${lossDomain.roofInvolvement})`);

  // Check for existing locked thesis
  if (!forceRefresh) {
    const { data: existingThesis } = await supabase
      .from('claim_thesis_objects')
      .select('*')
      .eq('claim_id', claimId)
      .maybeSingle();

    if (existingThesis && existingThesis.is_locked) {
      console.log(`[Pipeline Step C] Using existing locked thesis`);
      return {
        thesis: {
          primary_cause_of_loss: existingThesis.primary_cause_of_loss,
          primary_coverage_theory: existingThesis.primary_coverage_theory,
          primary_carrier_error: existingThesis.primary_carrier_error,
          evidence_map: existingThesis.evidence_map || [],
          anticipated_pushback: existingThesis.anticipated_pushback || '',
          pushback_counter: existingThesis.pushback_counter || '',
          loss_domain: lossDomain,
        },
        isNew: false,
        validationErrors: [],
      };
    }
  }

  // Check for declared position first
  const declaredPosition = memorySnapshot.declaredPosition;
  if (declaredPosition) {
    console.log(`[Pipeline Step C] Building thesis from declared position`);
    const evidenceMap = buildEvidenceMap(memorySnapshot.files, memorySnapshot.photos, claim);
    const thesis: ThesisObject = {
      primary_cause_of_loss: declaredPosition.primary_cause_of_loss || claim.loss_type || 'Unknown',
      primary_coverage_theory: declaredPosition.primary_coverage_theory || 'Direct physical loss from covered peril',
      primary_carrier_error: declaredPosition.primary_carrier_error || 'Carrier failed to properly evaluate claim evidence',
      evidence_map: evidenceMap,
      anticipated_pushback: declaredPosition.carrier_dependency_statement || '',
      pushback_counter: '',
      loss_domain: lossDomain,
    };

    const validationErrors = validateThesis(thesis);
    await upsertThesis(supabase, claimId, thesis, memorySnapshot, deltas, crossClaimLessons, industryNotes, webSearchResults);

    return { thesis, isNew: true, validationErrors };
  }

  // No declared position - use AI to generate thesis
  console.log(`[Pipeline Step C] Generating thesis via AI`);
  const thesis = await generateThesisViaAI(supabase, claimId, claim, memorySnapshot, crossClaimLessons, industryNotes, webSearchResults, lossDomain);
  const validationErrors = validateThesis(thesis);

  await upsertThesis(supabase, claimId, thesis, memorySnapshot, deltas, crossClaimLessons, industryNotes, webSearchResults);

  return { thesis, isNew: true, validationErrors };
}

function buildEvidenceMap(files: any[], photos: any[], claim: any): ThesisObject['evidence_map'] {
  const map: ThesisObject['evidence_map'] = [];

  // Add critical documents
  for (const file of files || []) {
    const classification = file.document_classification?.toLowerCase();
    if (['denial', 'estimate', 'engineering_report', 'policy', 'storm_report', 'weather_report', 'invoice'].includes(classification)) {
      map.push({
        type: 'document',
        id: file.id,
        name: file.file_name,
        relevance: classification === 'denial' ? 'Carrier denial to rebut'
          : classification === 'estimate' ? 'Scope/cost evidence'
          : classification === 'engineering_report' ? 'Technical evidence'
          : classification === 'policy' ? 'Coverage reference'
          : classification === 'storm_report' || classification === 'weather_report' ? 'Causation evidence'
          : 'Supporting evidence',
      });
    }
  }

  // Add photos with damage evidence
  for (const photo of (photos || []).filter((p: any) => p.ai_condition_rating === 'Poor' || p.ai_condition_rating === 'Failed')) {
    map.push({
      type: 'photo',
      id: photo.id,
      name: photo.file_name,
      relevance: `Damage evidence - ${photo.ai_condition_rating} condition${photo.ai_material_type ? ` (${photo.ai_material_type})` : ''}`,
    });
  }

  return map;
}

function validateThesis(thesis: ThesisObject): string[] {
  const errors: string[] = [];
  if (!thesis.primary_cause_of_loss || thesis.primary_cause_of_loss === 'Unknown') {
    errors.push('Missing primary cause of loss');
  }
  if (!thesis.primary_coverage_theory) {
    errors.push('Missing primary coverage theory');
  }
  if (!thesis.primary_carrier_error) {
    errors.push('Missing primary carrier error');
  }
  if (!thesis.evidence_map || thesis.evidence_map.length === 0) {
    errors.push('No evidence anchors (doc IDs / photo IDs) found');
  }
  return errors;
}

async function upsertThesis(
  supabase: any,
  claimId: string,
  thesis: ThesisObject,
  memorySnapshot: any,
  deltas: any,
  crossClaimLessons: any[],
  industryNotes: any[],
  webSearchResults: any[],
) {
  await supabase.from('claim_thesis_objects').upsert(
    {
      claim_id: claimId,
      primary_cause_of_loss: thesis.primary_cause_of_loss,
      primary_coverage_theory: thesis.primary_coverage_theory,
      primary_carrier_error: thesis.primary_carrier_error,
      evidence_map: thesis.evidence_map,
      anticipated_pushback: thesis.anticipated_pushback,
      pushback_counter: thesis.pushback_counter,
      last_memory_snapshot: {
        fileCount: memorySnapshot.files?.length || 0,
        photoCount: memorySnapshot.photos?.length || 0,
        analysisCount: memorySnapshot.recentAnalyses?.length || 0,
      },
      last_deltas_reviewed_at: new Date().toISOString(),
      cross_claim_lessons: crossClaimLessons.map((l: any) => ({
        claimId: l.claim_id,
        carrier: l.claims?.insurance_company,
        lossType: l.claims?.loss_type,
        winningArguments: l.winning_arguments,
        recoveryPct: l.recovery_percentage,
      })),
      industry_notes_used: industryNotes.map((n: any) => ({
        id: n.id,
        type: n.source_type,
        state: n.state_code,
      })),
      web_search_performed: webSearchResults.length > 0,
      web_search_results: webSearchResults.length > 0 ? webSearchResults : null,
    },
    { onConflict: 'claim_id' },
  );
}

async function generateThesisViaAI(
  supabase: any,
  claimId: string,
  claim: any,
  memorySnapshot: any,
  crossClaimLessons: any[],
  industryNotes: any[],
  webSearchResults: any[],
  lossDomain: LossDomainClassification,
): Promise<ThesisObject> {
  // Build context for AI
  const filesContext = (memorySnapshot.files || [])
    .filter((f: any) => f.document_classification)
    .map((f: any) => `- [${f.document_classification}] ${f.file_name} (ID: ${f.id})`)
    .join('\n');

  const photosContext = (memorySnapshot.photos || [])
    .filter((p: any) => p.ai_analyzed_at)
    .map((p: any) => `- ${p.file_name} [${p.ai_condition_rating || 'N/A'}] ${p.ai_material_type || ''} (ID: ${p.id})`)
    .join('\n');

  const lessonsContext = crossClaimLessons
    .map((l: any) => `- Carrier: ${l.claims?.insurance_company}, Loss: ${l.claims?.loss_type}, Recovery: ${l.recovery_percentage}%, Winning args: ${JSON.stringify(l.winning_arguments)}`)
    .join('\n');

  const prompt = `You are a senior public adjuster strategist. Based on the following claim data, generate a Claim Thesis Object.

CLAIM:
- Claim #: ${claim.claim_number}
- Loss Type: ${claim.loss_type || 'Unknown'}
- Loss Date: ${claim.loss_date || 'Unknown'}
- Insurance Company: ${claim.insurance_company || 'Unknown'}
- Status: ${claim.status}
- Description: ${claim.loss_description || 'N/A'}

DOCUMENTS ON FILE:
${filesContext || 'None'}

PHOTOS ON FILE:
${photosContext || 'None'}

CROSS-CLAIM LESSONS:
${lessonsContext || 'None available'}

You MUST return a JSON object with these exact fields:
{
  "primary_cause_of_loss": "The specific peril/event that caused damage",
  "primary_coverage_theory": "Why this loss is covered under the policy",
  "primary_carrier_error": "What the carrier got wrong or failed to do",
  "evidence_map": [{"type": "document|photo", "id": "actual ID from above", "name": "filename", "relevance": "why this matters"}],
  "anticipated_pushback": "What the carrier will likely argue back",
  "pushback_counter": "How to counter their anticipated argument"
}

IMPORTANT: evidence_map MUST reference actual document/photo IDs from the lists above. No fabricated IDs.`;

    // ── Claims Knowledge Engine enrichment ──
    let knowledgePrefix = '';
    try {
      const bundle = await getClaimsContextBundle({
        claimId,
        userQuery: `${claim.loss_type || ''} ${claim.damage_type || ''} thesis generation`,
        taskType: 'copilot_reasoning',
        supabase,
      });
      knowledgePrefix = formatContextBundle(bundle);
      if (knowledgePrefix) {
        console.log(`[Pipeline] Knowledge Engine: dispute=${bundle.disputeType}, knowledge=${bundle.retrievalMeta.knowledgeCount}, lessons=${bundle.retrievalMeta.lessonsCount}`);
      }
    } catch (e) {
      console.error('[Pipeline] Knowledge Engine error (non-fatal):', e);
    }

    const aiResult = await generate({
      task: 'copilot_reasoning',
      system: (knowledgePrefix ? knowledgePrefix + '\n\n' : '') + 'You are a claims strategy AI. Return ONLY valid JSON, no markdown.',
      user: prompt,
      claimId,
      searchMode: 'off',
      temperature: 0.3,
      jsonMode: true,
    });

    console.log(`[Pipeline Step C] Thesis AI model=${aiResult.model}, cached=${aiResult.cached}`);

    const content = aiResult.text;
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      primary_cause_of_loss: parsed.primary_cause_of_loss || claim.loss_type || 'Unknown',
      primary_coverage_theory: parsed.primary_coverage_theory || 'Direct physical loss',
      primary_carrier_error: parsed.primary_carrier_error || 'Insufficient evaluation',
      evidence_map: Array.isArray(parsed.evidence_map) ? parsed.evidence_map : buildEvidenceMap(memorySnapshot.files, memorySnapshot.photos, claim),
      anticipated_pushback: parsed.anticipated_pushback || '',
      pushback_counter: parsed.pushback_counter || '',
      loss_domain: lossDomain,
    };
  } catch (e) {
    console.error('Failed to generate/parse AI thesis:', e);
    return {
      primary_cause_of_loss: claim.loss_type || 'Unknown',
      primary_coverage_theory: 'Direct physical loss from covered peril',
      primary_carrier_error: 'Carrier failed to properly evaluate claim',
      evidence_map: buildEvidenceMap(memorySnapshot.files, memorySnapshot.photos, claim),
      anticipated_pushback: '',
      pushback_counter: '',
      loss_domain: lossDomain,
    };
  }
}

// ─── STEP D: Build Pipeline Context for Output ────────────────────────

function buildPipelineContext(
  thesis: ThesisObject,
  memorySnapshot: any,
  deltas: any,
  crossClaimLessons: any[],
  industryNotes: any[],
  webSearchResults: any[],
  validationErrors: string[],
  dismantlerResults?: any[],
): string {
  let ctx = '\n\n=== STRATEGIC PIPELINE CONTEXT (MANDATORY REVIEW) ===\n';
  ctx += 'You MUST review the following before generating output.\n\n';

  // Loss Domain Fidelity (MUST come first)
  const ld = thesis.loss_domain;
  ctx += '══ LOSS DOMAIN FIDELITY (MANDATORY — READ BEFORE ANYTHING ELSE) ══\n';
  ctx += `Detected Domain: ${ld.domain.toUpperCase()} (Confidence: ${ld.confidence})\n`;
  ctx += `Roof Involvement: ${ld.roofInvolvement}\n`;
  ctx += `Reasoning: ${ld.reasoning}\n`;
  if (ld.unansweredQuestions.length > 0) {
    ctx += `Open Questions: ${ld.unansweredQuestions.join('; ')}\n`;
  }
  ctx += '\n';

  // Domain-specific enforcement rules
  if (ld.domain === 'interior_water' && ld.roofInvolvement !== 'confirmed') {
    ctx += `🚫 HARD BLOCK: This is an INTERIOR WATER claim with ${ld.roofInvolvement === 'possible' ? 'UNCONFIRMED' : 'NO'} roof involvement.\n`;
    ctx += `   - DO NOT use roof-specific arguments, shingle standards, ARMA guidelines, or hail/wind damage terminology.\n`;
    ctx += `   - DO NOT cite IRC roofing sections, manufacturer shingle specs, or wind speed thresholds.\n`;
    ctx += `   - Focus on: water intrusion patterns, plumbing codes, moisture damage, mold risk, interior finish materials.\n`;
    if (ld.roofInvolvement === 'possible') {
      ctx += `   - If you need to reference roof as a water source, present it as a CONDITIONAL HYPOTHESIS ONLY:\n`;
      ctx += `     "If the source of water ingress is determined to be the roof system, then [argument]"\n`;
      ctx += `   - ASK: ${ld.unansweredQuestions.join('; ')}\n`;
    }
    ctx += '\n';
  } else if (ld.domain === 'fire_smoke') {
    ctx += `🔥 DOMAIN: FIRE/SMOKE. Use fire-specific standards, smoke damage evaluation, structural integrity assessment.\n`;
    ctx += `   - DO NOT default to roofing arguments unless fire caused roof damage.\n`;
    ctx += `   - Focus on: NFPA standards, smoke migration, char depth, thermal damage patterns, ALE/Coverage D.\n\n`;
  } else if (ld.domain === 'theft_vandalism') {
    ctx += `🔒 DOMAIN: THEFT/VANDALISM. Focus on property crime evidence, police reports, inventory verification.\n`;
    ctx += `   - DO NOT use weather-based or structural deterioration arguments.\n\n`;
  } else if (ld.domain === 'vehicle_impact') {
    ctx += `🚗 DOMAIN: VEHICLE IMPACT. Focus on structural damage, masonry, foundation, impact trajectory.\n`;
    ctx += `   - DO NOT use weather-based causation or roofing terminology.\n\n`;
  } else if (ld.domain === 'wind_only') {
    ctx += `💨 DOMAIN: WIND ONLY. Focus on wind-specific damage patterns (uplift, creasing, displacement).\n`;
    ctx += `   - Use wind speed data, directional indicators, and wind-specific manufacturer thresholds.\n\n`;
  } else if (ld.domain === 'roof_exterior' || ld.domain === 'hail') {
    ctx += `🏠 DOMAIN: ROOF/EXTERIOR. Roof-specific arguments, standards, and citations ARE permitted.\n\n`;
  }
  ctx += '══ END LOSS DOMAIN FIDELITY ══\n\n';

  // Thesis
  ctx += '── CLAIM THESIS (Locked Position) ──\n';
  ctx += `Primary Cause of Loss: ${thesis.primary_cause_of_loss}\n`;
  ctx += `Primary Coverage Theory: ${thesis.primary_coverage_theory}\n`;
  ctx += `Primary Carrier Error: ${thesis.primary_carrier_error}\n`;
  ctx += `Anticipated Pushback: ${thesis.anticipated_pushback || 'Not specified'}\n`;
  ctx += `Counter: ${thesis.pushback_counter || 'Not specified'}\n`;
  if (validationErrors.length > 0) {
    ctx += `⚠️ Thesis Warnings: ${validationErrors.join('; ')}\n`;
  }
  ctx += '\n';

  // Evidence map
  ctx += '── EVIDENCE ANCHORS ──\n';
  ctx += 'ALL outputs MUST cite at least one of these anchors:\n';
  for (const evidence of thesis.evidence_map) {
    ctx += `- [${evidence.type.toUpperCase()}] ${evidence.name} (ID: ${evidence.id}) — ${evidence.relevance}\n`;
  }
  if (thesis.evidence_map.length === 0) {
    ctx += '⚠️ NO EVIDENCE ANCHORS AVAILABLE. Output should note evidence gaps.\n';
  }
  ctx += '\n';

  // Deltas
  ctx += '── RECENT DELTAS ──\n';
  if (deltas.hasDelta) {
    if (deltas.newFiles.length > 0) {
      ctx += `New files since last review:\n${deltas.newFiles.map((f: any) => `  - ${f.file_name} [${f.document_classification || 'unclassified'}] (uploaded ${new Date(f.uploaded_at).toLocaleDateString()})`).join('\n')}\n`;
    }
    if (deltas.newNotes.length > 0) {
      ctx += `New notes: ${deltas.newNotes.length}\n`;
    }
    if (deltas.newEmails.length > 0) {
      ctx += `New emails: ${deltas.newEmails.map((e: any) => `${e.subject} (${e.direction})`).join(', ')}\n`;
    }
    ctx += 'MANDATE: You must explicitly incorporate at least one delta item in your output.\n';
  } else {
    ctx += 'No new file activity since last review.\n';
  }
  ctx += '\n';

  // Cross-claim lessons
  ctx += '── CROSS-CLAIM LESSONS ──\n';
  if (crossClaimLessons.length > 0) {
    for (const lesson of crossClaimLessons) {
      ctx += `- Carrier: ${lesson.claims?.insurance_company || 'Unknown'}, Loss: ${lesson.claims?.loss_type || 'Unknown'}, Recovery: ${lesson.recovery_percentage || 'N/A'}%\n`;
      if (lesson.winning_arguments) {
        const args = typeof lesson.winning_arguments === 'string' ? lesson.winning_arguments : JSON.stringify(lesson.winning_arguments);
        ctx += `  Winning args: ${args.substring(0, 200)}\n`;
      }
    }
  } else {
    ctx += 'No matching cross-claim lessons found.\n';
  }
  ctx += '\n';

  // Industry notes
  ctx += '── INDUSTRY NOTES ──\n';
  if (industryNotes.length > 0) {
    for (const note of industryNotes.slice(0, 5)) {
      ctx += `- [${note.source_type}] ${note.cache_key}: ${note.content.substring(0, 200)}...\n`;
    }
  } else {
    ctx += 'No cached industry notes matched.\n';
  }
  ctx += '\n';

  // Web search results
  if (webSearchResults.length > 0) {
    ctx += '── WEB SEARCH RESULTS ──\n';
    for (const result of webSearchResults) {
      ctx += `Query: ${result.query}\nResult: ${result.result.substring(0, 500)}\n\n`;
    }
  }

  // Dismantler intelligence
  if (dismantlerResults && dismantlerResults.length > 0) {
    ctx += '── DOCUMENT DISMANTLER INTELLIGENCE ──\n';
    for (const d of dismantlerResults) {
      ctx += `[${d.document_type}] ${d.source_file_name || 'Document'}\n`;
      ctx += `Position: ${d.main_position || 'N/A'}\n`;
      if (d.strongest_rebuttal_points?.length > 0) {
        ctx += `Strongest Rebuttals: ${d.strongest_rebuttal_points.slice(0, 3).join('; ')}\n`;
      }
      if (d.contradictions?.length > 0) {
        ctx += `Contradictions: ${d.contradictions.slice(0, 3).join('; ')}\n`;
      }
      if (d.coverage_weaknesses?.length > 0) {
        ctx += `Coverage Weaknesses: ${d.coverage_weaknesses.slice(0, 3).join('; ')}\n`;
      }
      ctx += '\n';
    }
  }

  ctx += '=== END STRATEGIC PIPELINE CONTEXT ===\n';
  ctx += 'RULE: No rebuttal/strategic output unless thesis exists and is backed by claim anchors (doc IDs / photo IDs).\n';

  return ctx;
}

// ─── Main Handler ─────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { claimId, analysisType, forceRefresh }: PipelineRequest = await req.json();

    if (!claimId) throw new Error('claimId is required');

    // Check if this analysis type requires the pipeline
    const requiresPipeline = STRATEGIC_TYPES.includes(analysisType);
    if (!requiresPipeline) {
      return new Response(
        JSON.stringify({ pipelineRequired: false, pipelineContext: '' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch claim
    const { data: claim, error: claimError } = await supabase
      .from('claims')
      .select('*')
      .eq('id', claimId)
      .single();
    if (claimError || !claim) throw new Error('Claim not found');

    // ── Step A ──
    const { memorySnapshot, deltas, crossClaimLessons, industryNotes, state } = await loadMemory(supabase, claimId, claim);

    // ── Step B ──
    const searchDecision = await decideWebSearch(supabase, claim, memorySnapshot, industryNotes, state);
    let webSearchResults: any[] = [];
    if (searchDecision.needed) {
      webSearchResults = await executeWebSearches(searchDecision.queries);

      // Cache web search results as industry notes
      for (const result of webSearchResults) {
        if (result.result && result.result.length > 50) {
          const cacheKey = `${state}_${claim.loss_type || 'general'}_${Date.now()}`;
          const sourceType = result.query.includes('regulation') ? 'regulation'
            : result.query.includes('manufacturer') ? 'manufacturer_spec'
            : 'weather_data';
          try {
            await supabase.from('industry_notes_cache').upsert({
              cache_key: cacheKey,
              state_code: state,
              peril: claim.loss_type || null,
              content: result.result.substring(0, 5000),
              source_type: sourceType,
              expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            }, { onConflict: 'cache_key' });
          } catch (e) {
            console.error('Failed to cache industry note:', e);
          }
        }
      }
    }

    // ── Step C ──
    const { thesis, isNew, validationErrors } = await buildThesisObject(
      supabase, claimId, claim, memorySnapshot, deltas,
      crossClaimLessons, industryNotes, webSearchResults, forceRefresh || false,
    );

    // ── Dismantler intelligence ──
    let dismantlerResults: any[] = [];
    try {
      const { data } = await supabase
        .from('claim_document_dismantlers')
        .select('document_type, source_file_name, report_summary, main_position, non_covered_theories, limitations, unsupported_assumptions, contradictions, omissions, repairability_overreach, coverage_weaknesses, strongest_rebuttal_points, evidence_to_gather_next, draft_rebuttal_language, chunk_count, successful_chunks, failed_chunks, model, cached, used_search')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(3);
      dismantlerResults = data || [];
      if (dismantlerResults.length > 0) {
        console.log(`[Pipeline] Dismantler intelligence: ${dismantlerResults.length} document analyses`);
      }
    } catch (e) {
      console.error('[Pipeline] Dismantler fetch error (non-fatal):', e);
    }

    // ── Step D ──
    const pipelineContext = buildPipelineContext(
      thesis, memorySnapshot, deltas, crossClaimLessons,
      industryNotes, webSearchResults, validationErrors, dismantlerResults,
    );

    console.log(`[Pipeline] Complete. Thesis ${isNew ? 'generated' : 'reused'}. ${validationErrors.length} warnings. Context: ${pipelineContext.length} chars`);

    return new Response(
      JSON.stringify({
        pipelineRequired: true,
        pipelineContext,
        thesis,
        thesisIsNew: isNew,
        validationErrors,
        searchPerformed: searchDecision.needed,
        searchReasons: searchDecision.reasons,
        deltaSummary: deltas.hasDelta
          ? `${deltas.newFiles.length} new files, ${deltas.newNotes.length} new notes, ${deltas.newEmails.length} new emails`
          : 'No new activity since last review',
        crossClaimCount: crossClaimLessons.length,
        industryNotesCount: industryNotes.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('Strategic pipeline error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
