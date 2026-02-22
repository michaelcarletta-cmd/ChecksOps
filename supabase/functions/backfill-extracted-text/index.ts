import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 20;
const MAX_TEXT_LENGTH = 100000;
const MIN_TEXT_THRESHOLD = 50; // files with fewer chars are treated as "missing"

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

// === OCR VIA VISION AI ===
async function ocrViaVision(bytes: Uint8Array, fileName: string): Promise<string | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    console.error("[OCR] LOVABLE_API_KEY not set");
    return null;
  }

  try {
    const chunks: string[] = [];
    const chunkSize = 32768;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode(...chunk));
    }
    const base64 = btoa(chunks.join(""));

    const isPdf = fileName.toLowerCase().endsWith(".pdf");
    const mimeType = isPdf
      ? "application/pdf"
      : fileName.toLowerCase().match(/\.(png)$/)
      ? "image/png"
      : fileName.toLowerCase().match(/\.(webp)$/)
      ? "image/webp"
      : "image/jpeg";

    console.log(`[OCR] Sending ${fileName} (${bytes.length} bytes, mime=${mimeType}) to vision API`);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "Extract ALL text content from this document image. Return the raw text exactly as it appears, preserving dates, numbers, names, and addresses. Do not summarize or interpret.",
          },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
              { type: "text", text: "Extract all text from this document. Return only the raw text content." },
            ],
          },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[OCR] Vision API error: ${response.status} - ${errBody.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || null;
    console.log(`[OCR] Vision returned ${text ? text.length : 0} chars for ${fileName}`);
    return text;
  } catch (error) {
    console.error("[OCR] Error:", error);
    return null;
  }
}

// === Process a single file ===
async function processFile(
  supabase: any,
  file: { id: string; file_name: string; file_path: string; file_type: string | null; extracted_text: string | null }
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
    // Download file from storage
    console.log(`[Process] Downloading ${file.file_name} from path: ${file.file_path}`);
    const { data: blob, error: dlErr } = await supabase.storage
      .from("claim-files")
      .download(file.file_path);

    if (dlErr || !blob) {
      entry.reason = `download_failed: ${dlErr?.message || "no blob returned"}`;
      console.error(`[Process] ${entry.reason} for ${file.file_name}`);
      return entry;
    }

    entry.download_ok = true;
    const arrayBuffer = await blob.arrayBuffer();
    entry.bytes = arrayBuffer.byteLength;
    console.log(`[Process] Downloaded ${file.file_name}: ${entry.bytes} bytes`);

    const fileType = file.file_type || "";
    const fileName = file.file_name || "";
    let textContent = "";

    // Text files
    if (fileType.includes("text") || fileName.endsWith(".txt")) {
      textContent = await blob.text();
      entry.method = "plain_text";
      console.log(`[Process] Plain text extraction: ${textContent.length} chars`);
    }
    // PDF files
    else if (fileType.includes("pdf") || fileName.toLowerCase().endsWith(".pdf")) {
      const pdfBytes = new Uint8Array(arrayBuffer);
      textContent = extractPdfText(pdfBytes);
      entry.method = "pdf_text";
      console.log(`[Process] PDF text extraction: ${textContent.length} chars`);

      // If PDF text extraction yields < 300 chars, try OCR
      if (textContent.length < 300) {
        console.log(`[Process] PDF text < 300 chars, falling back to OCR for ${fileName}`);
        const ocrText = await ocrViaVision(pdfBytes, fileName);
        if (ocrText && ocrText.length > textContent.length) {
          textContent = ocrText;
          entry.method = "ocr";
          console.log(`[Process] OCR improved to ${textContent.length} chars`);
        }
      }
    }
    // Image files
    else if (/\.(png|jpg|jpeg|webp|gif|bmp|tiff?)$/i.test(fileName)) {
      const imgBytes = new Uint8Array(arrayBuffer);
      console.log(`[Process] Image file, running OCR for ${fileName}`);
      const ocrText = await ocrViaVision(imgBytes, fileName);
      if (ocrText) {
        textContent = ocrText;
        entry.method = "image_ocr";
        console.log(`[Process] Image OCR: ${textContent.length} chars`);
      } else {
        entry.reason = "ocr_returned_null";
      }
    }
    // Unknown file types
    else {
      entry.reason = `unsupported_type: ${fileType} / ${fileName}`;
      console.log(`[Process] Skipping unsupported: ${entry.reason}`);
      return entry;
    }

    // Save extracted text
    if (textContent && textContent.length > 10) {
      // Sanitize: remove null bytes and invalid Unicode escape sequences that Postgres rejects
      let sanitized = textContent
        .replace(/\0/g, "")
        .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, "") // incomplete unicode escapes
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); // control chars except \t \n \r
      const capped = sanitized.substring(0, MAX_TEXT_LENGTH);
      const { error: updateErr } = await supabase
        .from("claim_files")
        .update({ extracted_text: capped, ocr_processed_at: new Date().toISOString() })
        .eq("id", file.id);

      if (updateErr) {
        entry.reason = `update_failed: ${updateErr.message}`;
        console.error(`[Process] DB update failed for ${file.id}: ${updateErr.message}`);
      } else {
        entry.chars = capped.length;
        entry.success = true;
        console.log(`[Process] ✅ Saved ${capped.length} chars for ${file.file_name}`);
      }
    } else {
      entry.reason = `extraction_yielded_${textContent?.length || 0}_chars`;
      console.log(`[Process] ❌ Insufficient text for ${file.file_name}: ${textContent?.length || 0} chars`);
    }
  } catch (err) {
    entry.reason = `error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Process] Exception for ${file.file_name}: ${entry.reason}`);
  }

  return entry;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const fileId = body.fileId || null; // single-file debug mode
    const cursor = body.cursor || null;
    const dryRun = body.dryRun || false;
    const release = body.release || false; // force-release a stuck lock

    const JOB_TYPE = "backfill_extracted_text";

    // Force-release lock if requested
    if (release) {
      await supabase.from("darwin_jobs").update({ status: "idle", completed_at: new Date().toISOString() }).eq("job_type", JOB_TYPE);
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Skip lock for single-file debug mode
    if (!fileId) {
      // Acquire lock — only if status is 'idle'
      const { data: lockRow, error: lockErr } = await supabase
        .from("darwin_jobs")
        .update({ status: "running", started_at: new Date().toISOString(), claimed_by: "backfill-extracted-text", error_message: null })
        .eq("job_type", JOB_TYPE)
        .eq("status", "idle")
        .select()
        .maybeSingle();

      if (lockErr || !lockRow) {
        // Check if already running
        const { data: existing } = await supabase.from("darwin_jobs").select("status, started_at, claimed_by").eq("job_type", JOB_TYPE).single();
        return new Response(
          JSON.stringify({ success: false, error: "Job already running", job: existing }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // === SINGLE FILE DEBUG MODE ===
    if (fileId) {
      console.log(`[Debug] Single-file mode for fileId: ${fileId}`);
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

      const result = await processFile(supabase, file);
      return new Response(
        JSON.stringify({ success: result.success, mode: "debug_single_file", log: [result] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // === BATCH MODE ===
    // Find files needing text: NULL, empty string, or short text (< threshold)
    // PostgREST doesn't support length() easily, so we fetch null/empty first,
    // then separately fetch short-text files
    console.log(`[Batch] Starting batch mode, cursor=${cursor}, dryRun=${dryRun}`);

    let candidates: any[] = [];

    // Group 1: null or empty extracted_text
    let q1 = supabase
      .from("claim_files")
      .select("id, file_name, file_path, file_type, extracted_text")
      .or("extracted_text.is.null,extracted_text.eq.")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);
    if (cursor) q1 = q1.gt("id", cursor);
    const { data: nullFiles, error: e1 } = await q1;
    if (e1) {
      return new Response(JSON.stringify({ success: false, error: e1.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (nullFiles) candidates.push(...nullFiles);

    // Group 2: short text (has text but < threshold) — only if we have room in batch
    if (candidates.length < BATCH_SIZE) {
      const remaining = BATCH_SIZE - candidates.length;
      const existingIds = candidates.map((c: any) => c.id);
      let q2 = supabase
        .from("claim_files")
        .select("id, file_name, file_path, file_type, extracted_text")
        .not("extracted_text", "is", null)
        .neq("extracted_text", "")
        .order("id", { ascending: true })
        .limit(remaining * 3); // over-fetch to filter in code
      if (cursor) q2 = q2.gt("id", cursor);
      const { data: shortFiles } = await q2;
      if (shortFiles) {
        const shortOnes = shortFiles
          .filter((f: any) => !existingIds.includes(f.id) && (f.extracted_text?.length || 0) < MIN_TEXT_THRESHOLD)
          .slice(0, remaining);
        candidates.push(...shortOnes);
      }
    }

    // Sort by id for consistent cursor
    candidates.sort((a: any, b: any) => a.id.localeCompare(b.id));
    candidates = candidates.slice(0, BATCH_SIZE);

    console.log(`[Batch] Found ${candidates.length} files to process`);

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, remaining: 0, message: "No more files to process", cursor: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Count total remaining (null + empty)
    const { count: nullCount } = await supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .or("extracted_text.is.null,extracted_text.eq.");

    const log: any[] = [];

    for (const file of candidates) {
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

      const result = await processFile(supabase, file);
      log.push(result);
    }

    const lastId = candidates[candidates.length - 1].id;
    const successCount = log.filter((l: any) => l.success).length;
    const totalRemaining = (nullCount || 0) - candidates.filter((c: any) => !c.extracted_text || c.extracted_text === "").length;

    // Release lock if no more remaining
    if (Math.max(0, totalRemaining) === 0 && !fileId) {
      await supabase.from("darwin_jobs").update({ status: "idle", completed_at: new Date().toISOString() }).eq("job_type", "backfill_extracted_text");
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: candidates.length,
        extracted: successCount,
        failed: candidates.length - successCount,
        remaining: Math.max(0, totalRemaining),
        cursor: lastId,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("backfill-extracted-text error:", e);
    // Release lock on error
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, serviceKey);
      await sb.from("darwin_jobs").update({ status: "idle", completed_at: new Date().toISOString(), error_message: e instanceof Error ? e.message : "Unknown error" }).eq("job_type", "backfill_extracted_text");
    } catch { /* best effort */ }
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
