import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const JOB_TYPE = "backfill_document_intelligence";
const TTL_SECONDS = 120;
const BATCH_MAX_RUNTIME_MS = 50_000;
const DEFAULT_BATCH_SIZE = 5;
const PER_FILE_TIMEOUT_MS = 45_000;

type CandidateFile = {
  id: string;
  claim_id: string;
  file_name: string;
  processed_by_darwin: boolean | null;
  needs_text_backfill: boolean;
};

async function requireStaffOrAdmin(supabase: any, req: Request) {
  const cronSecret = req.headers.get("x-cron-secret");
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (expectedSecret && cronSecret === expectedSecret) return;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user?.id) throw new Error("Unauthorized");

  const userId = userRes.user.id;
  const { data: roleRows, error: roleErr } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "staff"])
    .limit(1);

  if (roleErr) throw new Error("Unauthorized");
  if (!roleRows || roleRows.length === 0) throw new Error("Forbidden");
}

async function callDarwinProcessDocument(
  supabaseUrl: string,
  serviceKey: string,
  fileId: string,
  opts: { awaitIndexing?: boolean; awaitDeepAnalysisTrigger?: boolean },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_FILE_TIMEOUT_MS);
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/darwin-process-document`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        fileId,
        awaitIndexing: !!opts.awaitIndexing,
        awaitDeepAnalysisTrigger: !!opts.awaitDeepAnalysisTrigger,
      }),
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, body: json };
    }
    return { ok: true, status: res.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const batchStart = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json().catch(() => ({}));
    const cursor = body.cursor || null;
    const dryRun = !!body.dryRun;
    const release = !!body.release;
    const fileId = body.fileId || null;
    const claimId = body.claimId || null;
    const batchSize = Math.max(1, Math.min(Number(body.batchSize || DEFAULT_BATCH_SIZE), 20));
    const awaitIndexing = body.awaitIndexing !== false; // default true
    const awaitDeepAnalysisTrigger = !!body.awaitDeepAnalysisTrigger; // default false (expensive)

    await requireStaffOrAdmin(supabase, req);

    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Skip lock for single-file debug
    if (!fileId) {
      const { data: lockResult, error: lockErr } = await supabase.rpc("acquire_darwin_job", {
        p_job_type: JOB_TYPE,
        p_claimed_by: "backfill-document-intelligence",
        p_ttl_seconds: TTL_SECONDS,
      });

      if (lockErr) {
        return new Response(JSON.stringify({ success: false, error: `Lock RPC error: ${lockErr.message}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!lockResult?.acquired) {
        return new Response(JSON.stringify({ success: false, error: "Job already running", job: lockResult }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // === SINGLE FILE MODE ===
    if (fileId) {
      if (dryRun) {
        return new Response(JSON.stringify({ success: true, mode: "debug_dry_run", fileId }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await callDarwinProcessDocument(supabaseUrl, serviceKey, fileId, {
        awaitIndexing,
        awaitDeepAnalysisTrigger,
      });
      return new Response(JSON.stringify({ success: result.ok, mode: "debug_single_file", result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // === BATCH MODE ===
    let q = supabase
      .from("claim_files")
      .select("id, claim_id, file_name, processed_by_darwin, needs_text_backfill")
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false")
      .eq("needs_text_backfill", false)
      .order("id", { ascending: true })
      .limit(batchSize);
    if (cursor) q = q.gt("id", cursor);
    if (claimId) q = q.eq("claim_id", claimId);

    const { data: candidates, error: candErr } = await q;
    if (candErr) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: candErr.message });
      return new Response(JSON.stringify({ success: false, error: candErr.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!candidates || candidates.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, processed: 0, succeeded: 0, failed: 0, remaining: 0, cursor: null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const log: any[] = [];
    let succeeded = 0;
    let failed = 0;
    let earlyExit = false;

    for (const f of candidates as CandidateFile[]) {
      if (Date.now() - batchStart > BATCH_MAX_RUNTIME_MS) {
        earlyExit = true;
        break;
      }

      if (dryRun) {
        log.push({ file_id: f.id, claim_id: f.claim_id, file_name: f.file_name, success: false, reason: "dry_run" });
        continue;
      }

      const res = await callDarwinProcessDocument(supabaseUrl, serviceKey, f.id, {
        awaitIndexing,
        awaitDeepAnalysisTrigger,
      });

      if (res.ok && res.body?.success) {
        succeeded++;
        log.push({
          file_id: f.id,
          claim_id: f.claim_id,
          file_name: f.file_name,
          success: true,
          classification: res.body.classification,
          confidence: res.body.confidence,
          indexing: res.body.indexing ?? null,
          deep_analysis_triggered: res.body.deep_analysis_triggered ?? false,
        });
      } else {
        failed++;
        log.push({
          file_id: f.id,
          claim_id: f.claim_id,
          file_name: f.file_name,
          success: false,
          status: res.status,
          error: res.body?.error || res.body || "unknown_error",
        });
      }

      await supabase.rpc("heartbeat_darwin_job", { p_job_type: JOB_TYPE, p_claimed_by: "backfill-document-intelligence" });
    }

    const lastProcessedId = candidates[Math.min(log.length, candidates.length) - 1].id;

    // Remaining count using same predicate + advanced cursor
    let rq = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false")
      .eq("needs_text_backfill", false);
    if (claimId) rq = rq.eq("claim_id", claimId);
    if (lastProcessedId) rq = rq.gt("id", lastProcessedId);
    const { count: remainingCount } = await rq;

    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });

    return new Response(
      JSON.stringify({
        success: true,
        processed: log.length,
        succeeded,
        failed,
        remaining: Math.max(0, remainingCount || 0),
        cursor: lastProcessedId,
        early_exit: earlyExit,
        elapsed_ms: Date.now() - batchStart,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("backfill-document-intelligence error:", e);
    try {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: e instanceof Error ? e.message : "Unknown error" });
    } catch {
      // best effort
    }
    return new Response(JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

