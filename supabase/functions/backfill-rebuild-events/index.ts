import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 10;
const JOB_TYPE = "backfill_rebuild_events";
const TTL_SECONDS = 120;
const BATCH_MAX_RUNTIME_MS = 50_000; // 50s safe exit

// ================================================================
// DATE PARSING + REGEX EXTRACTION (inlined from darwin-process-document)
// ================================================================

const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDateStrict(raw: string): string | null {
  const cleaned = raw.replace(/^[.,;:\s]+|[.,;:\s]+$/g, '').trim();
  if (!cleaned) return null;

  let yyyy: string, mm: string, dd: string;

  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    mm = slashMatch[1].padStart(2, '0');
    dd = slashMatch[2].padStart(2, '0');
    let yr = slashMatch[3];
    if (yr.length === 2) yr = `20${yr}`;
    yyyy = yr;
    return validateAndReturn(yyyy, mm, dd);
  }

  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    yyyy = isoMatch[1]; mm = isoMatch[2]; dd = isoMatch[3];
    return validateAndReturn(yyyy, mm, dd);
  }

  const wordMatch = cleaned.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (wordMatch) {
    const monthKey = wordMatch[1].toLowerCase().replace('.', '');
    mm = MONTH_MAP[monthKey];
    if (!mm) return null;
    dd = wordMatch[2].padStart(2, '0');
    yyyy = wordMatch[3];
    return validateAndReturn(yyyy, mm, dd);
  }

  return null;
}

function validateAndReturn(yyyy: string, mm: string, dd: string): string | null {
  const y = parseInt(yyyy), m = parseInt(mm), d = parseInt(dd);
  if (y < 2000 || y > new Date().getFullYear() + 1) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${yyyy}-${mm}-${dd}T12:00:00.000Z`;
}

const DATE_CAPTURE = `((?:\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})|(?:\\d{4}-\\d{2}-\\d{2})|(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}))`;

interface ClaimEventRow {
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
}

function classifyByFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (/estimate|xactimate|symbility|rcv|acv|scope/i.test(lower)) return 'estimate';
  if (/denial|denied|decline/i.test(lower)) return 'denial';
  if (/approval|approved|payment|settlement/i.test(lower)) return 'approval';
  if (/rfi|request.*info|additional.*info/i.test(lower)) return 'rfi';
  if (/engineer|structural|report/i.test(lower)) return 'engineering_report';
  if (/policy|coverage|dec.*page|declaration/i.test(lower)) return 'policy';
  if (/invoice|bill|receipt/i.test(lower)) return 'invoice';
  if (/\.(jpg|jpeg|png|gif|heic|webp)$/i.test(lower)) return 'photo';
  return 'correspondence';
}

function extractDatesFromTextRegex(
  text: string,
  claimId: string,
  fileId: string,
  fileName: string,
  docType: string,
): ClaimEventRow[] {
  const events: ClaimEventRow[] = [];
  const PRIOR_LOSS_CONTEXT = /\b(prior|previous|history|past|prior\s+claim|previous\s+claim|prior\s+loss|previous\s+loss)\b/i;

  const labelPatterns: Array<{ regex: RegExp; eventType: string; confidence: number }> = [
    { regex: new RegExp(`(?:date\\s+of\\s+loss|DOL|loss\\s+date|loss\\s+occurred\\s+on)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'loss_event', confidence: 0.9 },
    { regex: new RegExp(`(?:prior\\s+loss|previous\\s+loss|past\\s+loss|prior\\s+claim|previous\\s+claim)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'prior_loss_mentioned', confidence: 0.85 },
    { regex: new RegExp(`(?:date\\s+reported|reported\\s+to\\s+us|notice\\s+of\\s+loss\\s+received|date\\s+of\\s+claim|claim\\s+reported)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'fnol_received', confidence: 0.9 },
    { regex: new RegExp(`(?:acknowledgement|acknowledgment|acknowledge)\\s*(?:date|letter)?\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'acknowledgement_issued', confidence: 0.85 },
    { regex: new RegExp(`(?:reservation\\s+of\\s+rights|ROR)\\s*(?:date|letter)?\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'ror_issued', confidence: 0.9 },
    { regex: new RegExp(`(?:denial\\s+date|date\\s+(?:of\\s+)?denial|denied\\s+on|decline\\s+date)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'denial_issued', confidence: 0.9 },
    { regex: new RegExp(`(?:inspection\\s+date|inspected\\s+on|site\\s+visit\\s+(?:on|date))\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'inspection', confidence: 0.85 },
    { regex: new RegExp(`(?:check\\s+date|payment\\s+date|EFT\\s+date|draft\\s+date|payment\\s+issued)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'payment_issued', confidence: 0.85 },
    { regex: new RegExp(`(?:received\\s+on|date\\s+received)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'document_received', confidence: 0.8 },
    { regex: new RegExp(`(?:estimate\\s+date|prepared\\s+on|scope\\s+date)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'estimate_issued', confidence: 0.85 },
    { regex: new RegExp(`(?:issued|dated)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: `${docType}_issued`, confidence: 0.7 },
  ];

  const standalonePatterns = [
    /(\d{1,2}\/\d{1,2}\/\d{2,4})/g,
    /(\d{4}-\d{2}-\d{2})/g,
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi,
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4})/gi,
  ];

  const seen = new Set<string>();

  function getSnippet(matchIndex: number): string {
    const start = Math.max(0, matchIndex - 40);
    const end = Math.min(text.length, matchIndex + 60);
    return text.substring(start, end).replace(/\n/g, ' ').trim();
  }

  // Pass 1: labeled dates
  let labeledFound = 0;
  for (const lp of labelPatterns) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(lp.regex.source, lp.regex.flags);
    while ((match = regex.exec(text)) !== null) {
      const rawDate = match[1];
      const occurredAt = parseDateStrict(rawDate);
      if (!occurredAt) continue;

      let effectiveEventType = lp.eventType;
      const snippet = getSnippet(match.index);

      if (effectiveEventType === 'loss_event') {
        const contextWindow = text.substring(Math.max(0, match.index - 50), Math.min(text.length, match.index + match[0].length + 50));
        if (PRIOR_LOSS_CONTEXT.test(contextWindow)) {
          effectiveEventType = 'prior_loss_mentioned';
        }
      }

      const key = `${effectiveEventType}|${occurredAt}|${fileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labeledFound++;

      events.push({
        claim_id: claimId,
        event_type: effectiveEventType,
        occurred_at: occurredAt,
        summary: `${effectiveEventType.replace(/_/g, ' ')}: ${rawDate} (regex from ${fileName})`,
        source_artifact_id: fileId,
        source_artifact_type: 'claim_file',
        date_source: 'document_text_regex',
        date_confidence: lp.confidence,
        date_evidence: snippet,
        doc_type: docType,
        metadata_json: { file_name: fileName, extraction_method: 'text_regex_labeled', label: effectiveEventType },
      });
    }
  }

  // Pass 2: unlabeled standalone dates (only if < 3 labeled found)
  if (labeledFound < 3) {
    for (const dp of standalonePatterns) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(dp.source, dp.flags);
      while ((match = regex.exec(text)) !== null) {
        const rawDate = match[1];
        const occurredAt = parseDateStrict(rawDate);
        if (!occurredAt) continue;
        const key = `date_mentioned|${occurredAt}|${fileId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        events.push({
          claim_id: claimId,
          event_type: 'date_mentioned',
          occurred_at: occurredAt,
          summary: `Date found in ${fileName}: ${rawDate}`,
          source_artifact_id: fileId,
          source_artifact_type: 'claim_file',
          date_source: 'document_text_regex',
          date_confidence: 0.6,
          date_evidence: getSnippet(match.index),
          doc_type: docType,
          metadata_json: { file_name: fileName, extraction_method: 'text_regex_unlabeled' },
        });

        if (events.length >= 15) break;
      }
      if (events.length >= 15) break;
    }
  }

  return events;
}

// ================================================================
// MAIN HANDLER
// ================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const batchStart = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const cursor = body.cursor || null;
    const release = body.release || false;

    // Force-release lock
    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Check that Step 1 is not running (heartbeat-aware)
    const { data: step1Row } = await supabase.from("darwin_jobs").select("status, heartbeat_at, ttl_seconds").eq("job_type", "backfill_extracted_text").single();
    if (step1Row?.status === "running") {
      const heartbeatAge = step1Row.heartbeat_at
        ? (Date.now() - new Date(step1Row.heartbeat_at).getTime()) / 1000
        : Infinity;
      if (heartbeatAge < (step1Row.ttl_seconds || 120)) {
        return new Response(
          JSON.stringify({ success: false, error: "Step 1 (text extraction) is still running. Wait for it to finish." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Atomic acquire via RPC
    const { data: lockResult, error: lockErr } = await supabase.rpc("acquire_darwin_job", {
      p_job_type: JOB_TYPE,
      p_claimed_by: "backfill-rebuild-events",
      p_ttl_seconds: TTL_SECONDS,
    });

    if (lockErr) {
      return new Response(JSON.stringify({ success: false, error: `Lock RPC error: ${lockErr.message}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!lockResult?.acquired) {
      return new Response(
        JSON.stringify({ success: false, error: "Job already running", job: lockResult }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find claims to process
    let query = supabase
      .from("claims")
      .select("id, claim_number")
      .eq("is_closed", false)
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data: claims, error: claimError } = await query;

    if (claimError) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: claimError.message });
      return new Response(JSON.stringify({ success: false, error: claimError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!claims || claims.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({ success: true, processed: 0, remaining: 0, cursor: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Count remaining
    const { count: totalRemaining } = await supabase
      .from("claims")
      .select("id", { count: "exact", head: true })
      .eq("is_closed", false);

    const derivedSources = ["document_extracted", "document_text_regex", "system_upload"];
    const log: any[] = [];
    let processedCount = 0;

    for (const claim of claims) {
      // === 50s early-exit guard ===
      if (Date.now() - batchStart > BATCH_MAX_RUNTIME_MS) {
        console.log(`[RebuildEvents] 50s guard hit after ${processedCount} claims, yielding`);
        break;
      }

      try {
        // 1) Delete only derived events for this claim
        const { count: deletedEvents } = await supabase
          .from("claim_events")
          .delete({ count: "exact" })
          .eq("claim_id", claim.id)
          .in("date_source", derivedSources);

        // 2) Fetch all files with extracted_text for this claim
        const { data: files } = await supabase
          .from("claim_files")
          .select("id, file_name, extracted_text, document_classification")
          .eq("claim_id", claim.id)
          .not("extracted_text", "is", null);

        const allEvents: ClaimEventRow[] = [];
        const fileCount = files?.length || 0;

        if (files && files.length > 0) {
          for (const file of files) {
            const text = file.extracted_text;
            if (!text || text.length < 50) continue;

            const docType = file.document_classification || classifyByFilename(file.file_name || '');
            const fileEvents = extractDatesFromTextRegex(text, claim.id, file.id, file.file_name || 'unknown', docType);
            allEvents.push(...fileEvents);
          }
        }

        // 3) Deduplicate by event_type + occurred_at + source_artifact_id
        const deduped = new Map<string, ClaimEventRow>();
        for (const evt of allEvents) {
          const key = `${evt.event_type}|${evt.occurred_at}|${evt.source_artifact_id}`;
          if (!deduped.has(key)) {
            deduped.set(key, evt);
          }
        }

        // 4) Bulk insert
        const toInsert = Array.from(deduped.values());
        let insertedCount = 0;
        if (toInsert.length > 0) {
          // Insert in chunks of 50 to avoid payload limits
          for (let i = 0; i < toInsert.length; i += 50) {
            const batch = toInsert.slice(i, i + 50);
            const { error: insertErr, count } = await supabase.from("claim_events").insert(batch, { count: "exact" });
            if (insertErr) {
              console.error(`[RebuildEvents] Insert error for claim ${claim.claim_number}: ${insertErr.message}`);
            } else {
              insertedCount += count || batch.length;
            }
          }
        }

        log.push({
          claim_id: claim.id,
          claim_number: claim.claim_number,
          events_deleted: deletedEvents || 0,
          files_with_text: fileCount,
          events_inserted: insertedCount,
          success: true,
        });

        processedCount++;

        // Heartbeat after each claim
        await supabase.rpc("heartbeat_darwin_job", { p_job_type: JOB_TYPE, p_claimed_by: "backfill-rebuild-events" });

      } catch (err) {
        log.push({
          claim_id: claim.id,
          claim_number: claim.claim_number,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        processedCount++;
      }
    }

    const lastId = claims[processedCount > 0 ? processedCount - 1 : 0].id;
    const remaining = Math.max(0, (totalRemaining || 0) - (cursor ? 0 : processedCount));

    // Always release the lock after each batch so the UI can immediately re-invoke
    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        remaining,
        cursor: lastId,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("backfill-rebuild-events error:", e);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, serviceKey);
      await sb.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: e instanceof Error ? e.message : "Unknown error" });
    } catch { /* best effort */ }
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
