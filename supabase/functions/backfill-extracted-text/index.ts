import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 20; // files per invocation
const MAX_TEXT_LENGTH = 100000;

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
  if (!LOVABLE_API_KEY) return null;

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
      console.error(`[OCR] Vision API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("[OCR] Error:", error);
    return null;
  }
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
    const cursor = body.cursor || null; // last processed file_id for pagination
    const dryRun = body.dryRun || false;

    // Find files that need text extraction
    let query = supabase
      .from("claim_files")
      .select("id, file_name, file_path, file_type, extracted_text")
      .or("extracted_text.is.null,extracted_text.eq.")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data: files, error: fetchError } = await query;

    if (fetchError) {
      return new Response(JSON.stringify({ success: false, error: fetchError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!files || files.length === 0) {
      // Check how many still need processing (might have short text)
      const { count: shortTextCount } = await supabase
        .from("claim_files")
        .select("id", { count: "exact", head: true })
        .not("extracted_text", "is", null)
        .neq("extracted_text", "");

      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          remaining: 0,
          message: "No more files to process",
          cursor: null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Count remaining
    const { count: totalRemaining } = await supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .or("extracted_text.is.null,extracted_text.eq.");

    const log: any[] = [];

    for (const file of files) {
      const entry: any = {
        file_id: file.id,
        file_name: file.file_name,
        chars: 0,
        method: "none",
        success: false,
        reason: "",
      };

      try {
        if (dryRun) {
          entry.reason = "dry_run";
          log.push(entry);
          continue;
        }

        // Download file from storage
        const { data: blob, error: dlErr } = await supabase.storage
          .from("claim-files")
          .download(file.file_path);

        if (dlErr || !blob) {
          entry.reason = `download_failed: ${dlErr?.message || "no blob"}`;
          log.push(entry);
          continue;
        }

        const fileType = file.file_type || "";
        const fileName = file.file_name || "";
        let textContent = "";

        // Text files
        if (fileType.includes("text") || fileName.endsWith(".txt")) {
          textContent = await blob.text();
          entry.method = "plain_text";
        }
        // PDF files
        else if (fileType.includes("pdf") || fileName.toLowerCase().endsWith(".pdf")) {
          const pdfBytes = new Uint8Array(await blob.arrayBuffer());
          textContent = extractPdfText(pdfBytes);
          entry.method = "pdf_text";

          // If PDF text extraction yields < 300 chars, try OCR
          if (textContent.length < 300) {
            console.log(`[Backfill] PDF text < 300 chars for ${fileName}, trying OCR...`);
            const ocrText = await ocrViaVision(pdfBytes, fileName);
            if (ocrText && ocrText.length > textContent.length) {
              textContent = ocrText;
              entry.method = "ocr";
            }
          }
        }
        // Image files
        else if (/\.(png|jpg|jpeg|webp|gif|bmp|tiff?)$/i.test(fileName)) {
          const imgBytes = new Uint8Array(await blob.arrayBuffer());
          const ocrText = await ocrViaVision(imgBytes, fileName);
          if (ocrText) {
            textContent = ocrText;
            entry.method = "ocr";
          }
        }
        // Unknown file types — skip
        else {
          entry.reason = `unsupported_type: ${fileType}`;
          log.push(entry);
          continue;
        }

        // Save extracted text
        if (textContent && textContent.length > 10) {
          const capped = textContent.substring(0, MAX_TEXT_LENGTH);
          await supabase
            .from("claim_files")
            .update({ extracted_text: capped, ocr_processed_at: new Date().toISOString() })
            .eq("id", file.id);
          entry.chars = capped.length;
          entry.success = true;
        } else {
          entry.reason = "extraction_yielded_no_text";
        }
      } catch (err) {
        entry.reason = `error: ${err instanceof Error ? err.message : String(err)}`;
      }

      log.push(entry);
    }

    const lastId = files[files.length - 1].id;
    const successCount = log.filter((l) => l.success).length;
    const remaining = (totalRemaining || 0) - files.length;

    return new Response(
      JSON.stringify({
        success: true,
        processed: files.length,
        extracted: successCount,
        failed: files.length - successCount,
        remaining: Math.max(0, remaining),
        cursor: lastId,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("backfill-extracted-text error:", e);
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
