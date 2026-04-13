import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type QueueRow = {
  id: string;
  claim_id: string;
  file_id: string;
  segment_id?: string | null;
  source_scope?: string;
  intelligence_id?: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: {
    document_type?: string;
    document_classification?: string;
    source_scope?: string;
    segment_id?: string;
    intelligence_id?: string;
    source_summary?: string;
  };
};

type MeaningOutput = {
  coverage_position: Record<string, unknown>;
  carrier_arguments: Array<Record<string, unknown>>;
  financial_position: Record<string, unknown>;
  deadlines: Array<Record<string, unknown>>;
  requested_items: Array<Record<string, unknown>>;
  missing_evidence: Array<Record<string, unknown>>;
  contradictions: Array<Record<string, unknown>>;
  recommended_response: Record<string, unknown>;
  strategic_weight: string;
  urgency: string;
  response_required: boolean;
  source_summary: string;
  confidence_score: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = await safeJson(req);
    const batchSize = Math.min(Number(body?.batchSize ?? 5), 10);
    const workerId = `darwin-meaning-worker-${crypto.randomUUID()}`;

    const jobs = await lockPendingJobs(supabase, workerId, batchSize);

    if (jobs.length === 0) {
      return json({
        success: true,
        message: 'No pending document meaning jobs',
        processed: 0,
      });
    }

    let completed = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        await processJob(supabase, job);
        completed += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error('[DocMeaningWorker] job failed', { jobId: job.id, fileId: job.file_id, message });

        const nextAttempts = job.attempts + 1;
        const terminal = nextAttempts >= job.max_attempts;

        await supabase
          .from('document_meaning_queue')
          .update({
            status: terminal ? 'failed' : 'pending',
            attempts: nextAttempts,
            last_error: message,
            locked_at: null,
            locked_by: null,
            run_after: terminal
              ? new Date().toISOString()
              : new Date(Date.now() + nextAttempts * 5 * 60 * 1000).toISOString(),
          })
          .eq('id', job.id);
      }
    }

    return json({
      success: true,
      processed: jobs.length,
      completed,
      failed,
    });
  } catch (error) {
    console.error('[DocMeaningWorker] fatal error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function processJob(
  supabase: ReturnType<typeof createClient>,
  job: QueueRow
) {
  const sourceScope = job.source_scope || job.payload.source_scope || 'file';
  const intelligenceId = job.intelligence_id || job.payload.intelligence_id || null;

  let intelligence: any = null;

  if (intelligenceId) {
    const { data, error } = await supabase
      .from('claim_document_intelligence')
      .select('*')
      .eq('id', intelligenceId)
      .single();

    if (error || !data) {
      throw new Error(`Document intelligence not found for ${intelligenceId}`);
    }

    intelligence = data;
  } else if (sourceScope === 'segment' && (job.segment_id || job.payload.segment_id)) {
    const segmentId = job.segment_id || job.payload.segment_id!;
    const { data, error } = await supabase
      .from('claim_document_intelligence')
      .select('*')
      .eq('segment_id', segmentId)
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Document intelligence not found for segment ${segmentId}`);
    }

    intelligence = data;
  } else {
    const { data, error } = await supabase
      .from('claim_document_intelligence')
      .select('*')
      .eq('file_id', job.file_id)
      .is('segment_id', null)
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Document intelligence not found for file ${job.file_id}`);
    }

    intelligence = data;
  }

  const meaning = await extractDocumentMeaning({
    documentType: intelligence.document_type || job.payload.document_type || 'other',
    documentClassification: intelligence.document_classification || job.payload.document_classification || 'other',
    sourceSummary: intelligence.source_summary || job.payload.source_summary || '',
    intelligence,
  });

  const upsertPayload = {
    claim_id: intelligence.claim_id,
    file_id: intelligence.file_id,
    segment_id: intelligence.segment_id ?? null,
    source_scope: intelligence.source_scope || sourceScope,
    document_type: intelligence.document_type,
    document_classification: intelligence.document_classification,
    meaning_version: 'v1',
    coverage_position: meaning.coverage_position,
    carrier_arguments: meaning.carrier_arguments,
    financial_position: meaning.financial_position,
    deadlines: meaning.deadlines,
    requested_items: meaning.requested_items,
    missing_evidence: meaning.missing_evidence,
    contradictions: meaning.contradictions,
    recommended_response: meaning.recommended_response,
    strategic_weight: meaning.strategic_weight,
    urgency: meaning.urgency,
    response_required: meaning.response_required,
    source_summary: meaning.source_summary,
    confidence_score: meaning.confidence_score,
    raw_model_output: meaning,
    updated_at: new Date().toISOString(),
  };

  const onConflictTarget = intelligence.segment_id ? 'segment_id' : 'file_id';

  const { error: meaningError } = await supabase
    .from('claim_document_meaning')
    .upsert(upsertPayload, { onConflict: onConflictTarget });

  if (meaningError) {
    throw new Error(`Failed to upsert claim_document_meaning: ${meaningError.message}`);
  }

  await supabase
    .from('document_meaning_queue')
    .update({
      status: 'completed',
      attempts: job.attempts + 1,
      locked_at: null,
      locked_by: null,
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', job.id);

  await refreshClaimMasterStateMeaning(supabase, intelligence.claim_id);
}

async function extractDocumentMeaning(input: {
  documentType: string;
  documentClassification: string;
  sourceSummary: string;
  intelligence: any;
}): Promise<MeaningOutput> {
  const { callOpenAI } = await import("../_shared/ai/openaiClient.ts");

  const prompt = `
You are Darwin, a property-claim claim-strategy engine.

Return ONLY valid JSON with this exact structure:
{
  "coverage_position": {
    "status": "supportive|adverse|neutral|mixed|unknown",
    "position_summary": "string",
    "policy_basis": ["string"],
    "causation_position": "string|null",
    "scope_position": "string|null",
    "payment_position": "string|null"
  },
  "carrier_arguments": [
    {
      "argument": "string",
      "category": "causation|coverage|scope|pricing|depreciation|late_notice|documentation|other",
      "supporting_basis": "string",
      "strength": "high|medium|low"
    }
  ],
  "financial_position": {
    "rcv": number|null,
    "acv": number|null,
    "depreciation": number|null,
    "deductible": number|null,
    "net_payment": number|null,
    "underpayment_signal": boolean,
    "financial_summary": "string"
  },
  "deadlines": [
    {
      "date": "string|null",
      "label": "string",
      "priority": "high|medium|low",
      "reason": "string"
    }
  ],
  "requested_items": [
    {
      "item": "string",
      "owner": "carrier|insured|adjuster|contractor|expert|unknown",
      "reason": "string",
      "priority": "high|medium|low"
    }
  ],
  "missing_evidence": [
    {
      "item": "string",
      "why_it_matters": "string",
      "priority": "high|medium|low"
    }
  ],
  "contradictions": [
    {
      "issue": "string",
      "description": "string",
      "severity": "high|medium|low"
    }
  ],
  "recommended_response": {
    "summary": "string",
    "next_action": "string",
    "draftable_artifact": "letter|email|war_room_card|regulatory_complaint|none",
    "response_owner": "adjuster|attorney|insured|contractor|expert|unknown"
  },
  "strategic_weight": "high|medium|low",
  "urgency": "high|medium|low",
  "response_required": boolean,
  "source_summary": "string",
  "confidence_score": number
}

Rules:
- Do not invent facts.
- Base the answer on the provided intelligence only.
- Use null when unknown.
- Keep source_summary under 80 words.
- confidence_score must be between 0 and 1.
`;

  const content = `
DOCUMENT TYPE: ${input.documentType}
DOCUMENT CLASSIFICATION: ${input.documentClassification}
SOURCE SUMMARY: ${input.sourceSummary}

DOCUMENT INTELLIGENCE JSON:
${JSON.stringify(input.intelligence).slice(0, 25000)}
`;

  const result = await callOpenAI({
    model: 'gpt-4o-mini',
    system: prompt,
    user: content,
    temperature: 0.1,
    jsonMode: true,
  });

  const raw = result.text;

  const parsed = JSON.parse(raw);

  return {
    coverage_position: parsed.coverage_position || {},
    carrier_arguments: Array.isArray(parsed.carrier_arguments) ? parsed.carrier_arguments : [],
    financial_position: parsed.financial_position || {},
    deadlines: Array.isArray(parsed.deadlines) ? parsed.deadlines : [],
    requested_items: Array.isArray(parsed.requested_items) ? parsed.requested_items : [],
    missing_evidence: Array.isArray(parsed.missing_evidence) ? parsed.missing_evidence : [],
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
    recommended_response: parsed.recommended_response || {},
    strategic_weight: parsed.strategic_weight || 'medium',
    urgency: parsed.urgency || 'medium',
    response_required: Boolean(parsed.response_required),
    source_summary: String(parsed.source_summary || input.sourceSummary || ''),
    confidence_score: normalizeConfidence(parsed.confidence_score),
  };
}

async function refreshClaimMasterStateMeaning(
  supabase: ReturnType<typeof createClient>,
  claimId: string
) {
  const { data: existing } = await supabase
    .from('claim_master_state')
    .select('state_json')
    .eq('claim_id', claimId)
    .maybeSingle();

  const { data: meaningRows } = await supabase
    .from('claim_document_meaning')
    .select('strategic_weight, urgency, response_required, recommended_response, contradictions, missing_evidence, carrier_arguments')
    .eq('claim_id', claimId);

  let responseRequiredDocs = 0;
  let highUrgencyDocs = 0;
  let highStrategicDocs = 0;
  let contradictionCount = 0;
  let missingEvidenceCount = 0;
  let carrierArgumentCount = 0;
  let latestRecommendedAction: string | null = null;

  for (const row of meaningRows || []) {
    if (row.response_required) responseRequiredDocs += 1;
    if (row.urgency === 'high') highUrgencyDocs += 1;
    if (row.strategic_weight === 'high') highStrategicDocs += 1;

    contradictionCount += Array.isArray(row.contradictions) ? row.contradictions.length : 0;
    missingEvidenceCount += Array.isArray(row.missing_evidence) ? row.missing_evidence.length : 0;
    carrierArgumentCount += Array.isArray(row.carrier_arguments) ? row.carrier_arguments.length : 0;

    const action = (row.recommended_response as any)?.next_action;
    if (typeof action === 'string' && action.trim()) {
      latestRecommendedAction = action.trim();
    }
  }

  const currentState = (existing?.state_json ?? {}) as Record<string, unknown>;
  const currentMeaning = (currentState.document_meaning ?? {}) as Record<string, unknown>;

  const nextState = {
    ...currentState,
    document_meaning: {
      ...currentMeaning,
      response_required_docs: responseRequiredDocs,
      high_urgency_docs: highUrgencyDocs,
      high_strategic_docs: highStrategicDocs,
      contradiction_count: contradictionCount,
      missing_evidence_count: missingEvidenceCount,
      carrier_argument_count: carrierArgumentCount,
      latest_recommended_action: latestRecommendedAction,
      last_meaning_refresh_at: new Date().toISOString(),
    },
    updated_at_iso: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('claim_master_state')
    .upsert({
      claim_id: claimId,
      state_json: nextState,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    console.error('[DocMeaningWorker] claim_master_state update error:', error.message);
  }
}

async function lockPendingJobs(
  supabase: ReturnType<typeof createClient>,
  workerId: string,
  batchSize: number
): Promise<QueueRow[]> {
  const nowIso = new Date().toISOString();
  const staleLockIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from('document_meaning_queue')
    .select('id, claim_id, file_id, segment_id, source_scope, intelligence_id, status, attempts, max_attempts, payload, locked_at')
    .or(`and(status.eq.pending,run_after.lte.${nowIso}),and(status.eq.processing,locked_at.lte.${staleLockIso})`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`Failed to fetch queue candidates: ${error.message}`);
  }

  const locked: QueueRow[] = [];

  for (const row of candidates || []) {
    const { data: updated, error: lockError } = await supabase
      .from('document_meaning_queue')
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        locked_by: workerId,
      })
      .eq('id', row.id)
      .in('status', ['pending', 'processing'])
      .select('id, claim_id, file_id, segment_id, source_scope, intelligence_id, status, attempts, max_attempts, payload')
      .maybeSingle();

    if (!lockError && updated) {
      locked.push(updated as QueueRow);
    }
  }

  return locked;
}

function normalizeConfidence(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

async function safeJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
