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

async function enqueueDocumentMeaningJob(
  supabase: any,
  payload: {
    claim_id: string;
    file_id: string;
    intelligence_id: string;
    segment_id?: string | null;
    source_scope?: string;
    document_type: string;
    document_classification: string;
    source_summary?: string;
    priority?: number;
  }
) {
  const queueRow = {
    claim_id: payload.claim_id,
    file_id: payload.file_id,
    segment_id: payload.segment_id ?? null,
    source_scope: payload.source_scope || (payload.segment_id ? 'segment' : 'file'),
    intelligence_id: payload.intelligence_id,
    status: 'pending',
    priority: payload.priority ?? 50,
    run_after: new Date().toISOString(),
    payload: {
      intelligence_id: payload.intelligence_id,
      segment_id: payload.segment_id ?? null,
      source_scope: payload.source_scope || (payload.segment_id ? 'segment' : 'file'),
      document_type: payload.document_type,
      document_classification: payload.document_classification,
      source_summary: payload.source_summary || '',
    },
  };

  const conflictTarget = payload.segment_id ? 'segment_id' : 'file_id';

  const { error } = await supabase
    .from('document_meaning_queue')
    .upsert(queueRow, { onConflict: conflictTarget });

  if (error) {
    console.error('[DocMeaningQueue] enqueue error:', error.message);
    throw error;
  }
}

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

async function processJob(supabase: any, job: QueueRow) {
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

  // Enqueue meaning extraction after intelligence is saved
  const { data: savedIntel, error: savedIntelError } = await supabase
    .from('claim_document_intelligence')
    .select('id, claim_id, file_id, segment_id, source_scope, document_type, document_classification, source_summary, confidence_score')
    .eq(segmentId ? 'segment_id' : 'file_id', segmentId ? segmentId : fileId)
    .maybeSingle();

  if (savedIntelError || !savedIntel) {
    throw new Error(`Unable to fetch saved document intelligence for meaning queue`);
  }

  await enqueueDocumentMeaningJob(supabase, {
    claim_id: savedIntel.claim_id,
    file_id: savedIntel.file_id,
    intelligence_id: savedIntel.id,
    segment_id: savedIntel.segment_id ?? null,
    source_scope: savedIntel.source_scope || sourceScope,
    document_type: savedIntel.document_type,
    document_classification: savedIntel.document_classification,
    source_summary: savedIntel.source_summary || '',
    priority: Number(savedIntel.confidence_score || 0.5) >= 0.85 ? 100 : 50,
  });

  await refreshClaimMasterState(supabase, claimId, fileId, sourceDocumentType);

  // === WRITE INTELLIGENCE-EXTRACTED DATES INTO claim_events ===
  await writeIntelligenceDatesToClaimEvents(
    supabase, claimId, fileId, fileName,
    sourceDocumentType, sourceClassification,
    intelligence, savedIntel.confidence_score ?? 0.5,
  );
}

// =========================================================================
// INTELLIGENCE → CANONICAL TIMELINE: Write high-quality dates to claim_events
// =========================================================================
const INTEL_LABEL_TO_EVENT_TYPE: Record<string, string> = {
  'loss_date': 'loss_event',
  'date_of_loss': 'loss_event',
  'fnol': 'fnol_received',
  'date_reported': 'fnol_received',
  'acknowledgement': 'acknowledgement_issued',
  'acknowledgment': 'acknowledgement_issued',
  'reservation_of_rights': 'ror_issued',
  'ror': 'ror_issued',
  'denial': 'denial_issued',
  'denial_date': 'denial_issued',
  'inspection': 'inspection',
  'inspection_date': 'inspection',
  'payment': 'payment_issued',
  'payment_date': 'payment_issued',
  'estimate': 'estimate_issued',
  'estimate_date': 'estimate_issued',
  'document_date': 'document_issued',
  'letter_date': 'document_issued',
  'deadline': 'deadline',
};

function parseIntelDate(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  // YYYY-MM-DD
  const iso = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const y = parseInt(iso[1]), m = parseInt(iso[2]), d = parseInt(iso[3]);
    if (y >= 2000 && y <= new Date().getFullYear() + 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${iso[1]}-${iso[2]}-${iso[3]}T12:00:00.000Z`;
    }
  }
  // MM/DD/YYYY
  const slash = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const mm = slash[1].padStart(2, '0');
    const dd = slash[2].padStart(2, '0');
    let yr = slash[3];
    if (yr.length === 2) yr = `20${yr}`;
    const y = parseInt(yr), m = parseInt(mm), d = parseInt(dd);
    if (y >= 2000 && y <= new Date().getFullYear() + 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${yr}-${mm}-${dd}T12:00:00.000Z`;
    }
  }
  return null;
}

async function writeIntelligenceDatesToClaimEvents(
  supabase: any,
  claimId: string,
  fileId: string,
  fileName: string,
  documentType: string,
  documentClassification: string,
  intelligence: IntelligenceOutput,
  overallConfidence: number,
) {
  const timeline = intelligence.timeline_data as {
    dates?: Array<{ date?: string; label?: string; confidence?: number }>;
    deadlines?: Array<{ date?: string; label?: string; source_excerpt?: string }>;
  } | null;

  if (!timeline) return;

  type ClaimEventCandidate = {
    claim_id: string;
    event_type: string;
    occurred_at: string;
    summary: string;
    source_artifact_id: string | null;
    source_artifact_type: string;
    date_source: string;
    date_confidence: number;
    date_evidence: string | null;
    doc_type: string;
    metadata_json: Record<string, unknown>;
  };

  const candidates: ClaimEventCandidate[] = [];
  const seen = new Set<string>();

  // Process timeline dates
  if (Array.isArray(timeline.dates)) {
    for (const entry of timeline.dates) {
      if (!entry?.date) continue;
      const occurredAt = parseIntelDate(entry.date);
      if (!occurredAt) continue;

      const label = (entry.label || '').toLowerCase().replace(/\s+/g, '_');
      const eventType = INTEL_LABEL_TO_EVENT_TYPE[label] || 'date_mentioned';
      const confidence = typeof entry.confidence === 'number'
        ? Math.min(entry.confidence, overallConfidence)
        : overallConfidence * 0.8;

      if (confidence < 0.5) continue;

      const key = `${eventType}|${occurredAt}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        claim_id: claimId,
        event_type: eventType,
        occurred_at: occurredAt,
        summary: `${eventType.replace(/_/g, ' ')}: ${fileName}`,
        source_artifact_id: fileId,
        source_artifact_type: 'claim_file',
        date_source: 'document_extracted',
        date_confidence: confidence,
        date_evidence: entry.label || `Intelligence-extracted date from ${fileName}`,
        doc_type: documentClassification || documentType,
        metadata_json: {
          file_name: fileName,
          extraction_method: 'intelligence_worker',
          original_label: entry.label,
        },
      });
    }
  }

  // Process deadlines
  if (Array.isArray(timeline.deadlines)) {
    for (const dl of timeline.deadlines) {
      if (!dl?.date) continue;
      const occurredAt = parseIntelDate(dl.date);
      if (!occurredAt) continue;

      const key = `deadline|${occurredAt}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        claim_id: claimId,
        event_type: 'deadline',
        occurred_at: occurredAt,
        summary: dl.label || `Deadline from ${fileName}`,
        source_artifact_id: fileId,
        source_artifact_type: 'claim_file',
        date_source: 'document_extracted',
        date_confidence: overallConfidence * 0.85,
        date_evidence: dl.source_excerpt || dl.label || `Deadline extracted from ${fileName}`,
        doc_type: documentClassification || documentType,
        metadata_json: {
          file_name: fileName,
          extraction_method: 'intelligence_worker_deadline',
          original_label: dl.label,
        },
      });
    }
  }

  if (candidates.length === 0) return;

  // === BATCH PREFETCH: get all existing claim_events for this claim in one query ===
  const occurredAtValues = [...new Set(candidates.map(c => c.occurred_at))];
  const eventTypeValues = [...new Set(candidates.map(c => c.event_type))];

  const { data: existingEvents } = await supabase
    .from('claim_events')
    .select('id, event_type, occurred_at, date_confidence')
    .eq('claim_id', claimId)
    .in('event_type', eventTypeValues)
    .in('occurred_at', occurredAtValues);

  // Build lookup: event_type|occurred_at → { id, date_confidence }
  const existingMap = new Map<string, { id: string; date_confidence: number }>();
  for (const row of existingEvents || []) {
    const key = `${row.event_type}|${row.occurred_at}`;
    existingMap.set(key, { id: row.id, date_confidence: row.date_confidence ?? 0 });
  }

  // Partition into inserts vs updates
  const toInsert: ClaimEventCandidate[] = [];
  const toUpdate: Array<{ id: string; patch: Partial<ClaimEventCandidate> }> = [];

  for (const evt of candidates) {
    const key = `${evt.event_type}|${evt.occurred_at}`;
    const existing = existingMap.get(key);

    if (!existing) {
      toInsert.push(evt);
    } else if (evt.date_confidence > existing.date_confidence) {
      // Stronger evidence → update the existing row
      toUpdate.push({
        id: existing.id,
        patch: {
          date_confidence: evt.date_confidence,
          date_evidence: evt.date_evidence,
          doc_type: evt.doc_type,
          metadata_json: evt.metadata_json,
        },
      });
    }
  }

  // Bulk insert new events
  let insertedCount = 0;
  if (toInsert.length > 0) {
    const { error, count } = await supabase
      .from('claim_events')
      .insert(toInsert, { count: 'exact' });
    if (error) {
      console.error(`[IntelTimeline] Bulk insert failed: ${error.message}`);
    } else {
      insertedCount = count ?? toInsert.length;
    }
  }

  // Update existing events with stronger evidence
  let updatedCount = 0;
  for (const upd of toUpdate) {
    const { error } = await supabase
      .from('claim_events')
      .update(upd.patch)
      .eq('id', upd.id);
    if (!error) updatedCount++;
  }

  if (insertedCount > 0 || updatedCount > 0) {
    console.log(`[IntelTimeline] file=${fileName} claim=${claimId}: inserted=${insertedCount} upgraded=${updatedCount} (of ${candidates.length} candidates)`);
  }
}

async function extractDocumentIntelligence(input: {
  fileName: string;
  documentType: string;
  documentClassification: string;
  summary: string;
  text: string;
}): Promise<IntelligenceOutput> {
  const { callOpenAI } = await import("../_shared/ai/openaiClient.ts");

  const prompt = `Extract structured claim intelligence from the document. Return only valid JSON with source_summary, extracted_entities, financial_data, timeline_data, action_items, coverage_signals, parties, and confidence_score.`;
  const content = `File: ${input.fileName}\nDocument type: ${input.documentType}\nClassification: ${input.documentClassification}\nSummary: ${input.summary}\n\nText:\n${input.text.slice(0, 60000)}`;

  const result = await callOpenAI({
    model: 'gpt-4o-mini',
    system: prompt,
    user: content,
    temperature: 0.1,
    jsonMode: true,
  });

  const raw = result.text;
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
  supabase: any,
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
  supabase: any,
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
