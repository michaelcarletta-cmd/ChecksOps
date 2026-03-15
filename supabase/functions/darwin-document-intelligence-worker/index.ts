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
  status: string;
  attempts: number;
  max_attempts: number;
  payload: {
    document_type?: string;
    document_classification?: string;
    confidence_score?: number;
    summary?: string;
    segment_id?: string;
    source_scope?: string;
  };
};

type IntelligenceOutput = {
  source_summary: string;
  extracted_entities: Record<string, unknown>;
  financial_data: Record<string, unknown>;
  timeline_data: Record<string, unknown>;
  action_items: Array<Record<string, unknown>>;
  coverage_signals: Record<string, unknown>;
  parties: Array<Record<string, unknown>>;
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
    const workerId = `darwin-docintel-worker-${crypto.randomUUID()}`;

    const jobs = await lockPendingJobs(supabase, workerId, batchSize);

    if (jobs.length === 0) {
      return json({
        success: true,
        message: 'No pending document intelligence jobs',
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
        console.error('[DocIntelWorker] job failed', { jobId: job.id, fileId: job.file_id, message });

        const nextAttempts = job.attempts + 1;
        const terminal = nextAttempts >= job.max_attempts;

        await supabase
          .from('document_intelligence_queue')
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
    console.error('[DocIntelWorker] fatal error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function processJob(supabase: ReturnType<typeof createClient>, job: QueueRow) {
  let sourceText = '';
  let sourceSummary = '';
  let sourceDocumentType = job.payload.document_type || 'other';
  let sourceClassification = job.payload.document_classification || 'other';
  let claimId = job.claim_id;
  let fileId = job.file_id;
  let segmentId: string | null = job.segment_id || job.payload.segment_id || null;
  let sourceScope = job.source_scope || job.payload.source_scope || 'file';
  let fileName = '';

  if (sourceScope === 'segment' && segmentId) {
    const { data: segment, error: segmentError } = await supabase
      .from('claim_file_segments')
      .select('id, claim_id, file_id, segment_label, clean_text, extracted_text, segment_classification, classification_confidence, document_family')
      .eq('id', segmentId)
      .single();

    if (segmentError || !segment) {
      throw new Error(`Claim file segment not found for ${segmentId}`);
    }

    claimId = segment.claim_id;
    fileId = segment.file_id;
    sourceText = String(segment.clean_text || segment.extracted_text || '').trim();
    sourceSummary = segment.segment_label || '';
    sourceDocumentType = mapDocumentType(segment.segment_classification || 'other');
    sourceClassification = segment.segment_classification || 'other';
    fileName = `${segment.segment_label || 'Segment'} (virtual)`;
  } else {
    const { data: file, error: fileError } = await supabase
      .from('claim_files')
      .select('id, claim_id, file_name, clean_text, extracted_text, document_type, document_classification, classification_confidence, document_summary, classification_metadata')
      .eq('id', job.file_id)
      .single();

    if (fileError || !file) {
      throw new Error(`Claim file not found for ${job.file_id}`);
    }

    claimId = file.claim_id;
    fileId = file.id;
    sourceText = String(file.clean_text || file.extracted_text || '').trim();
    sourceSummary = file.document_summary || '';
    sourceDocumentType = file.document_type || job.payload.document_type || 'other';
    sourceClassification = file.document_classification || job.payload.document_classification || 'other';
    fileName = file.file_name;
  }

  if (sourceText.length < 100) {
    throw new Error(`Insufficient text for intelligence extraction on ${sourceScope} ${segmentId || fileId}`);
  }

  const intelligence = await extractDocumentIntelligence({
    fileName,
    documentType: sourceDocumentType,
    documentClassification: sourceClassification,
    summary: sourceSummary,
    text: sourceText,
  });

  const upsertPayload = {
    claim_id: claimId,
    file_id: fileId,
    segment_id: segmentId,
    source_scope: sourceScope,
    document_type: sourceDocumentType,
    document_classification: sourceClassification,
    source_summary: intelligence.source_summary,
    extracted_entities: intelligence.extracted_entities,
    financial_data: intelligence.financial_data,
    timeline_data: intelligence.timeline_data,
    action_items: intelligence.action_items,
    coverage_signals: intelligence.coverage_signals,
    parties: intelligence.parties,
    confidence_score: intelligence.confidence_score,
    raw_model_output: intelligence,
    intelligence_version: 'v1',
    updated_at: new Date().toISOString(),
  };

  const onConflictTarget = segmentId ? 'segment_id' : 'file_id';

  const { error: intelError } = await supabase
    .from('claim_document_intelligence')
    .upsert(upsertPayload, { onConflict: onConflictTarget });

  if (intelError) {
    throw new Error(`Failed to upsert claim_document_intelligence: ${intelError.message}`);
  }

  await supabase
    .from('document_intelligence_queue')
    .update({
      status: 'completed',
      attempts: job.attempts + 1,
      locked_at: null,
      locked_by: null,
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', job.id);

  await refreshClaimMasterState(supabase, claimId, fileId, sourceDocumentType);
}

async function extractDocumentIntelligence(input: {
  fileName: string;
  documentType: string;
  documentClassification: string;
  summary: string;
  text: string;
}): Promise<IntelligenceOutput> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const prompt = `
You are Darwin, a property-claim document intelligence engine.

Return ONLY valid JSON with this exact structure:
{
  "source_summary": "string",
  "extracted_entities": {
    "claim_number": "string|null",
    "policy_number": "string|null",
    "loss_date": "string|null",
    "document_date": "string|null",
    "property_address": "string|null",
    "carrier": "string|null",
    "insured": "string|null"
  },
  "financial_data": {
    "rcv": number|null,
    "acv": number|null,
    "net_claim": number|null,
    "deductible": number|null,
    "depreciation": number|null,
    "approved_amount": number|null,
    "denied_amount": number|null,
    "payments_mentioned": [
      { "type": "string", "amount": number, "date": "string|null", "description": "string" }
    ]
  },
  "timeline_data": {
    "dates": [
      { "date": "string", "label": "string", "confidence": number }
    ],
    "deadlines": [
      { "date": "string|null", "label": "string", "source_excerpt": "string" }
    ]
  },
  "action_items": [
    { "title": "string", "owner": "carrier|adjuster|insured|contractor|unknown", "priority": "high|medium|low", "deadline": "string|null", "reason": "string" }
  ],
  "coverage_signals": {
    "denial_present": boolean,
    "partial_approval_present": boolean,
    "payment_present": boolean,
    "reservation_of_rights_present": boolean,
    "proof_of_loss_requested": boolean,
    "examination_under_oath_requested": boolean,
    "appraisal_mentioned": boolean
  },
  "parties": [
    { "name": "string", "role": "string", "company": "string|null" }
  ],
  "confidence_score": number
}

Rules:
- Do not invent facts.
- Use null when unknown.
- Keep source_summary under 80 words.
- confidence_score must be between 0 and 1.
`;

  const content = `
FILE NAME: ${input.fileName}
DOCUMENT TYPE: ${input.documentType}
DOCUMENT CLASSIFICATION: ${input.documentClassification}
CURRENT SUMMARY: ${input.summary}

DOCUMENT TEXT:
${input.text.slice(0, 25000)}
`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI extraction failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error('No model output returned');
  }

  const parsed = JSON.parse(raw);

  return {
    source_summary: String(parsed.source_summary || input.summary || ''),
    extracted_entities: parsed.extracted_entities || {},
    financial_data: parsed.financial_data || {},
    timeline_data: parsed.timeline_data || {},
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    coverage_signals: parsed.coverage_signals || {},
    parties: Array.isArray(parsed.parties) ? parsed.parties : [],
    confidence_score: normalizeConfidence(parsed.confidence_score),
  };
}

function mapDocumentType(classification: string): string {
  const docTypeMap: Record<string, string> = {
    denial: 'denial_letter',
    estimate: 'carrier_estimate',
    approval: 'coverage_letter',
    rfi: 'carrier_correspondence',
    engineering_report: 'engineering_report',
    policy: 'policy_document',
    correspondence: 'carrier_correspondence',
    invoice: 'invoice',
    photo: 'photos_report',
    other: 'other',
  };
  return docTypeMap[classification] || classification;
}

async function refreshClaimMasterState(
  supabase: ReturnType<typeof createClient>,
  claimId: string,
  lastFileId: string,
  lastDocumentType: string
) {
  const { data: existing } = await supabase
    .from('claim_master_state')
    .select('state_json')
    .eq('claim_id', claimId)
    .maybeSingle();

  const { count: analyzedCount } = await supabase
    .from('claim_document_intelligence')
    .select('id', { count: 'exact', head: true })
    .eq('claim_id', claimId);

  const { count: pendingCount } = await supabase
    .from('document_intelligence_queue')
    .select('id', { count: 'exact', head: true })
    .eq('claim_id', claimId)
    .in('status', ['pending', 'processing']);

  const { data: highPriorityDocs } = await supabase
    .from('claim_document_intelligence')
    .select('action_items')
    .eq('claim_id', claimId);

  let highPriorityActionDocs = 0;
  for (const row of highPriorityDocs || []) {
    const items = Array.isArray(row.action_items) ? row.action_items : [];
    if (items.some((item: any) => item?.priority === 'high')) {
      highPriorityActionDocs += 1;
    }
  }

  const currentState = (existing?.state_json ?? {}) as Record<string, unknown>;
  const currentDocIntel = (currentState.document_intelligence ?? {}) as Record<string, unknown>;

  const nextState = {
    ...currentState,
    document_intelligence: {
      ...currentDocIntel,
      analyzed_documents: analyzedCount ?? 0,
      pending_documents: pendingCount ?? 0,
      high_priority_action_docs: highPriorityActionDocs,
      last_processed_file_id: lastFileId,
      last_document_type: lastDocumentType,
      last_processed_at: new Date().toISOString(),
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
    console.error('[DocIntelWorker] claim_master_state update error:', error.message);
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
    .from('document_intelligence_queue')
    .select('id, claim_id, file_id, segment_id, source_scope, status, attempts, max_attempts, payload, locked_at')
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
      .from('document_intelligence_queue')
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        locked_by: workerId,
      })
      .eq('id', row.id)
      .in('status', ['pending', 'processing'])
      .select('id, claim_id, file_id, segment_id, source_scope, status, attempts, max_attempts, payload')
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
