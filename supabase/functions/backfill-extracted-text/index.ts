import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { ocrImageViaVision, extractPdfWithOcrFallback } from "../_shared/ai/pdfVisionOcr.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 20;
const MAX_TEXT_LENGTH = 100000;
const MIN_TEXT_THRESHOLD = 50;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // 8 MB — skip files larger than this to avoid OOM
const JOB_TYPE = "backfill_extracted_text";
const TTL_SECONDS = 120;
const BATCH_MAX_RUNTIME_MS = 50_000;

// === PDF TEXT EXTRACTION (raw byte parsing) ===
function extractPdfText(bytes: Uint8Array): string {
  const rawText = new TextDecoder("latin1").decode(bytes);
  const textParts: string[] = [];

  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(rawText)) !== null) {
    const block = match[1];
    const strRegex = /\(([^)]*)\)/g;
    let strMatch;
    while ((strMatch = strRegex.exec(block)) !== null) {
      const decoded = strMatch[1]
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
      if (decoded.trim()) textParts.push(decoded);
    }
  }

  if (textParts.length < 5) {
    const asciiRegex = /[A-Za-z0-9][A-Za-z0-9 ,.\-\/#:@$%&()]{4,}/g;
    let asciiMatch;
    while ((asciiMatch = asciiRegex.exec(rawText)) !== null) {
      textParts.push(asciiMatch[0].trim());
    }
  }

  return textParts.join(" ");
}

const FILE_TIMEOUT_MS = 90_000; // 90 seconds per file

// === OCR VIA VISION AI ===
async function ocrViaVision(bytes: Uint8Array, fileName: string, _signal?: AbortSignal): Promise<string | null> {
  const isPdf = fileName.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    const result = await extractPdfWithOcrFallback(bytes, fileName, { embeddedTextThreshold: 300 });
    console.log(`[OCR] PDF pipeline: method=${result.method}, status=${result.diagnostics.status}, chars=${result.text.length}, failure=${result.diagnostics.failureReason || 'none'}`);
    return result.text.length > 10 ? result.text : null;
  }

  // Image files
  const { text, diagnostics } = await ocrImageViaVision(bytes, fileName);
  console.log(`[OCR] Image OCR: status=${diagnostics.status}, chars=${diagnostics.ocrResultLength}, failure=${diagnostics.failureReason || 'none'}`);
  return text;
}

// === Wrap processFile with a hard timeout ===
async function processFileWithTimeout(
  supabase: any,
  file: { id: string; file_name: string; file_path: string; file_type: string | null; extracted_text: string | null }
): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

  try {
    const result = await processFile(supabase, file, controller.signal);
    return result;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn(`[Timeout] File ${file.file_name} (${file.id}) exceeded ${FILE_TIMEOUT_MS / 1000}s — skipping`);
      return {
        file_id: file.id, file_name: file.file_name, file_type: file.file_type || "unknown",
        file_path: file.file_path, existing_text_length: file.extracted_text?.length || 0,
        download_ok: false, bytes: 0, method: "none", chars: 0, success: false, reason: "timeout",
      };
    }
    return {
      file_id: file.id, file_name: file.file_name, file_type: file.file_type || "unknown",
      file_path: file.file_path, existing_text_length: file.extracted_text?.length || 0,
      download_ok: false, bytes: 0, method: "none", chars: 0, success: false,
      reason: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// === Process a single file ===
async function processFile(
  supabase: any,
  file: { id: string; file_name: string; file_path: string; file_type: string | null; extracted_text: string | null },
  signal?: AbortSignal
): Promise<Record<string, any>> {
  const entry: Record<string, any> = {
    file_id: file.id,
    file_name: file.file_name,
    file_type: file.file_type || "unknown",
    file_path: file.file_path,
    existing_text_length: file.extracted_text?.length || 0,
    download_ok: false,
    bytes: 0,
    method: "none",
    chars: 0,
    success: false,
    reason: "",
  };

  try {
    // Pre-flight size check to avoid downloading huge files that blow memory
    const { data: fileList, error: listErr } = await supabase.storage
      .from("claim-files")
      .list(file.file_path.substring(0, file.file_path.lastIndexOf("/")), {
        search: file.file_path.substring(file.file_path.lastIndexOf("/") + 1),
        limit: 1,
      });

    const fileMeta = fileList?.[0];
    if (fileMeta?.metadata?.size && fileMeta.metadata.size > MAX_DOWNLOAD_BYTES) {
      entry.reason = `file_too_large: ${(fileMeta.metadata.size / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit`;
      console.warn(`[Process] ${entry.reason} for ${file.file_name}`);
      await supabase.from("claim_files").update({ needs_text_backfill: false }).eq("id", file.id);
      return entry;
    }

    console.log(`[Process] Downloading ${file.file_name} from path: ${file.file_path}`);
    const { data: blob, error: dlErr } = await supabase.storage
      .from("claim-files")
      .download(file.file_path);

    if (dlErr || !blob) {
      entry.reason = `download_failed: ${dlErr?.message || "no blob returned"}`;
      console.error(`[Process] ${entry.reason} for ${file.file_name}`);
      await supabase.from("claim_files").update({ needs_text_backfill: false }).eq("id", file.id);
      return entry;
    }

    entry.download_ok = true;
    const arrayBuffer = await blob.arrayBuffer();
    entry.bytes = arrayBuffer.byteLength;

    // Double-check after download in case metadata was unavailable
    if (entry.bytes > MAX_DOWNLOAD_BYTES) {
      entry.reason = `file_too_large_post_download: ${(entry.bytes / 1024 / 1024).toFixed(1)} MB`;
      console.warn(`[Process] ${entry.reason} for ${file.file_name}`);
      await supabase.from("claim_files").update({ needs_text_backfill: false }).eq("id", file.id);
      return entry;
    }

    console.log(`[Process] Downloaded ${file.file_name}: ${entry.bytes} bytes`);

    const fileType = file.file_type || "";
    const fileName = file.file_name || "";
    let textContent = "";

    if (fileType.includes("text") || fileName.endsWith(".txt")) {
      textContent = await blob.text();
      entry.method = "plain_text";
    } else if (fileType.includes("pdf") || fileName.toLowerCase().endsWith(".pdf")) {
      const pdfBytes = new Uint8Array(arrayBuffer);
      textContent = extractPdfText(pdfBytes);
      entry.method = "pdf_text";
      if (textContent.length < 300) {
      const ocrText = await ocrViaVision(pdfBytes, fileName, signal);
        if (ocrText && ocrText.length > textContent.length) {
          textContent = ocrText;
          entry.method = "ocr";
        }
      }
    } else if (/\.(png|jpg|jpeg|webp|gif|bmp|tiff?)$/i.test(fileName)) {
      const imgBytes = new Uint8Array(arrayBuffer);
      const ocrText = await ocrViaVision(imgBytes, fileName, signal);
      if (ocrText) {
        textContent = ocrText;
        entry.method = "image_ocr";
      } else {
        entry.reason = "ocr_returned_null";
        // Image with no extractable text — stop retrying
        await supabase.from("claim_files").update({ needs_text_backfill: false }).eq("id", file.id);
      }
    } else {
      entry.reason = `unsupported_type: ${fileType} / ${fileName}`;
      // Mark as done so it won't be retried forever
      await supabase.from("claim_files").update({ needs_text_backfill: false }).eq("id", file.id);
      return entry;
    }

    if (textContent && textContent.length > 10) {
      let sanitized = textContent
        .replace(/\0/g, "")
        .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, "")
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
      const capped = sanitized.substring(0, MAX_TEXT_LENGTH);
      const needsBackfill = capped.length < MIN_TEXT_THRESHOLD;
      const { error: updateErr } = await supabase
        .from("claim_files")
        .update({
          extracted_text: capped,
          ocr_processed_at: new Date().toISOString(),
          needs_text_backfill: needsBackfill,
        })
        .eq("id", file.id);

      if (updateErr) {
        entry.reason = `update_failed: ${updateErr.message}`;
      } else {
        entry.chars = capped.length;
        entry.success = true;
      }
    } else {
      entry.reason = `extraction_yielded_${textContent?.length || 0}_chars`;
      // Not enough text to be useful — stop retrying
      await supabase.from("claim_files").update({ needs_text_backfill: false }).eq("id", file.id);
    }
  } catch (err) {
    entry.reason = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return entry;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const fileId = body.fileId || null;
    const cursor = body.cursor || null;
    const dryRun = body.dryRun || false;
    const release = body.release || false;

    // Force-release lock if requested
    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Skip lock for single-file debug mode
    if (!fileId) {
      // Atomic acquire via RPC (handles TTL-based steal)
      const { data: lockResult, error: lockErr } = await supabase.rpc("acquire_darwin_job", {
        p_job_type: JOB_TYPE,
        p_claimed_by: "backfill-extracted-text",
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
    }

    // === SINGLE FILE DEBUG MODE ===
    if (fileId) {
      const { data: file, error: fileErr } = await supabase
        .from("claim_files")
        .select("id, file_name, file_path, file_type, extracted_text")
        .eq("id", fileId)
        .single();

      if (fileErr || !file) {
        return new Response(
          JSON.stringify({ success: false, error: `File not found: ${fileErr?.message || "no result"}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (dryRun) {
        return new Response(
          JSON.stringify({ success: true, mode: "debug_dry_run", file: { id: file.id, file_name: file.file_name, file_path: file.file_path, file_type: file.file_type, existing_text_length: file.extracted_text?.length || 0 } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const result = await processFileWithTimeout(supabase, file);
      return new Response(
        JSON.stringify({ success: result.success, mode: "debug_single_file", log: [result] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // === BATCH MODE ===
    console.log(`[Batch] Starting batch mode, cursor=${cursor}, dryRun=${dryRun}`);

    let q = supabase
      .from("claim_files")
      .select("id, file_name, file_path, file_type, extracted_text")
      .eq("needs_text_backfill", true)
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);
    if (cursor) q = q.gt("id", cursor);
    const { data: candidates, error: e1 } = await q;
    if (e1) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: e1.message });
      return new Response(JSON.stringify({ success: false, error: e1.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[Batch] Found ${candidates?.length || 0} files to process`);

    if (!candidates || candidates.length === 0) {
      // Done — release lock
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({ success: true, processed: 0, remaining: 0, message: "No more files to process", cursor: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Remaining = exact same predicate, same cursor
    let rq = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .eq("needs_text_backfill", true);
    if (cursor) rq = rq.gt("id", cursor);
    const { count: totalRemainingCount } = await rq;

    const log: any[] = [];
    const batchStart = Date.now();
    let earlyExit = false;
    let consecutiveFailures = 0;
    const RETRY_PATTERN = /timeout|429|rate|503/i;

    for (const file of candidates) {
      // Check if we're approaching the edge function timeout
      if (Date.now() - batchStart > BATCH_MAX_RUNTIME_MS) {
        console.warn(`[Batch] Approaching edge timeout after ${((Date.now() - batchStart) / 1000).toFixed(1)}s — exiting safely with ${log.length} files processed`);
        earlyExit = true;
        break;
      }

      if (dryRun) {
        log.push({
          file_id: file.id,
          file_name: file.file_name,
          file_type: file.file_type,
          existing_text_length: file.extracted_text?.length || 0,
          reason: "dry_run",
          success: false,
        });
        continue;
      }

      let result = await processFileWithTimeout(supabase, file);

      // If ≥3 recent failures match timeout/rate-limit pattern, back off and retry once
      if (!result.success && RETRY_PATTERN.test(result.reason || "")) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          const delayMs = Math.min(5000, 1000 * consecutiveFailures);
          console.warn(`[Batch] ${consecutiveFailures} consecutive retryable failures — backing off ${delayMs}ms before retry for ${file.file_name}`);
          await new Promise((r) => setTimeout(r, delayMs));

          // Check we still have time after the delay
          if (Date.now() - batchStart > BATCH_MAX_RUNTIME_MS) {
            log.push(result);
            earlyExit = true;
            break;
          }

          const retryResult = await processFileWithTimeout(supabase, file);
          if (retryResult.success || (retryResult.reason && !RETRY_PATTERN.test(retryResult.reason))) {
            consecutiveFailures = 0; // reset on non-retryable outcome
          }
          result = retryResult;
        }
      } else if (result.success) {
        consecutiveFailures = 0;
      }

      log.push(result);

      // Heartbeat + cursor after EACH file so progress is never lost
      await supabase.rpc("heartbeat_darwin_job", { p_job_type: JOB_TYPE, p_claimed_by: "backfill-extracted-text" });
      console.log(`[Batch] Completed file ${file.id} (${result.success ? 'OK' : result.reason}), heartbeat sent, elapsed=${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
    }

    // Guarantee cursor always advances when we had candidates
    const lastProcessedId = candidates.length > 0
      ? candidates[Math.min(log.length, candidates.length) - 1].id
      : (cursor || null);
    const successCount = log.filter((l: any) => l.success).length;

    // Re-count remaining using the same predicate + advanced cursor
    let finalRq = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .eq("needs_text_backfill", true);
    if (lastProcessedId) finalRq = finalRq.gt("id", lastProcessedId);
    const { count: finalRemaining } = await finalRq;
    const totalRemaining = Math.max(0, finalRemaining || 0);

    // Always release the lock at end of batch — the UI loop handles chaining
    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });


    return new Response(
      JSON.stringify({
        success: true,
        processed: log.length,
        extracted: successCount,
        failed: log.length - successCount,
        remaining: Math.max(0, totalRemaining),
        cursor: lastProcessedId,
        early_exit: earlyExit,
        elapsed_ms: Date.now() - batchStart,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("backfill-extracted-text error:", e);
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
