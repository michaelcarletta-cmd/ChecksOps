import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 5;
const JOB_TYPE = "bulk_document_intelligence";
const TTL_SECONDS = 180;
const BATCH_MAX_RUNTIME_MS = 50_000;

// ── Document Classification Types ──────────────────────────────────────────
type DocumentClassification =
  | "estimate"
  | "denial"
  | "approval"
  | "rfi"
  | "engineering_report"
  | "policy"
  | "correspondence"
  | "invoice"
  | "photo"
  | "other";

interface ClassificationResult {
  classification: DocumentClassification;
  confidence: number;
  metadata: {
    date_mentioned: string | null;
    deadline_mentioned: string | null;
    amounts: Array<{ description: string; amount: number }>;
    key_phrases: string[];
    sender:
      | "carrier"
      | "adjuster"
      | "contractor"
      | "policyholder"
      | "unknown";
    requires_action: boolean;
    urgency: "high" | "medium" | "low";
    summary: string;
    denial_reason?: string;
    denial_type?: "full" | "partial" | "coverage" | "causation" | "procedure";
    estimate_type?: "xactimate" | "symbility" | "contractor" | "unknown";
    gross_rcv?: number;
    approved_amount?: number;
    payment_type?: "initial" | "supplement" | "final";
    [key: string]: unknown;
  };
}

// ── Filename-based Classification Fallback ──────────────────────────────────

function classifyByFilename(filename: string): DocumentClassification {
  const lower = filename.toLowerCase();
  if (/estimate|xactimate|symbility|rcv|acv|scope/i.test(lower))
    return "estimate";
  if (/denial|denied|decline/i.test(lower)) return "denial";
  if (/approval|approved|payment|settlement/i.test(lower)) return "approval";
  if (/rfi|request.*info|additional.*info/i.test(lower)) return "rfi";
  if (/engineer|structural|report/i.test(lower)) return "engineering_report";
  const isPolicyKeyword = /policy|coverage|dec.*page|declaration/i.test(lower);
  const isPolicyNumberFormat =
    /^h[o0][-]?\d/i.test(lower) ||
    /^dp[-]?\d/i.test(lower) ||
    /^[a-z]{1,4}\d{4,}/i.test(lower);
  if (isPolicyKeyword || isPolicyNumberFormat) return "policy";
  if (/invoice|bill|receipt/i.test(lower)) return "invoice";
  if (/\.(jpg|jpeg|png|gif|heic|webp)$/i.test(lower)) return "photo";
  return "correspondence";
}

// ── AI Classification ──────────────────────────────────────────────────────

function validateExtractedDate(dateStr: string | null): {
  isValid: boolean;
  correctedDate: string | null;
  warning: string | null;
} {
  if (!dateStr || dateStr === "null")
    return { isValid: true, correctedDate: null, warning: null };
  const extracted = new Date(dateStr);
  if (isNaN(extracted.getTime()))
    return {
      isValid: false,
      correctedDate: null,
      warning: `Invalid date format: ${dateStr}`,
    };
  const now = new Date();
  const tenYearsAgo = new Date();
  tenYearsAgo.setFullYear(now.getFullYear() - 10);
  if (extracted < tenYearsAgo)
    return {
      isValid: false,
      correctedDate: null,
      warning: `Extracted date ${dateStr} appears too old`,
    };
  if (extracted > now)
    return {
      isValid: false,
      correctedDate: null,
      warning: `Extracted date ${dateStr} is in the future`,
    };
  return { isValid: true, correctedDate: dateStr, warning: null };
}

async function classifyDocument(
  textContent: string,
  filename: string,
): Promise<ClassificationResult> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return {
      classification: classifyByFilename(filename),
      confidence: 0.5,
      metadata: {
        date_mentioned: null,
        deadline_mentioned: null,
        amounts: [],
        key_phrases: [],
        sender: "unknown",
        requires_action: false,
        urgency: "low",
        summary: "Classified by filename pattern (AI unavailable)",
      },
    };
  }

  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const currentYear = now.getFullYear();

  const systemPrompt = `You are a document classifier for insurance claims.

IMPORTANT DATE CONTEXT:
- TODAY'S DATE: ${currentDate}
- CURRENT YEAR: ${currentYear}

Analyze the document and classify it.

DATE EXTRACTION RULES (CRITICAL):
1. Extract the DOCUMENT DATE - the date the letter/document was written or issued
2. This is typically found in the letterhead, header, or near the signature
3. Do NOT confuse this with loss dates, claim dates, or policy dates mentioned in the body
4. For 2-digit years: interpret based on current year (${currentYear}):
   - Years 00-29 are 2000-2029
   - Years 30-99 are 1930-1999
5. If no clear document date is found, return null

Return ONLY valid JSON with this structure:
{
  "classification": "estimate|denial|approval|rfi|engineering_report|policy|correspondence|invoice|photo|other",
  "confidence": 0.0-1.0,
  "metadata": {
    "document_date": "YYYY-MM-DD or null",
    "date_confidence": 0.0-1.0,
    "date_mentioned": "YYYY-MM-DD or null",
    "labeled_dates": {
      "letter_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "fnol_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "ack_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "ror_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "denial_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "inspection_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "payment_issue_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "received_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "loss_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "estimate_date": {"date": "YYYY-MM-DD or null", "snippet": "text"},
      "prior_loss_dates": []
    },
    "claim_numbers_found": [],
    "multi_claim_doc": false,
    "dates_found": [],
    "deadline_mentioned": "YYYY-MM-DD or null",
    "amounts": [{"description": "...", "amount": 0.00}],
    "key_phrases": ["up to 5 key phrases"],
    "sender": "carrier|adjuster|contractor|policyholder|unknown",
    "requires_action": true/false,
    "urgency": "high|medium|low",
    "summary": "One sentence summary"
  }
}

For DENIALS: include "denial_reason" and "denial_type".
For ESTIMATES: include "estimate_type" and "gross_rcv".
For APPROVALS: include "approved_amount" and "payment_type".`;

  try {
    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Filename: ${filename}\n\nDocument content:\n${textContent.substring(0, 15000)}`,
            },
          ],
          temperature: 0.1,
        }),
      },
    );

    if (!response.ok) throw new Error(`AI API error: ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in AI response");

    const result = JSON.parse(jsonMatch[0]) as ClassificationResult;

    const metadata = result.metadata as any;
    const documentDate = metadata.document_date || metadata.date_mentioned;
    const dateValidation = validateExtractedDate(documentDate);
    if (!dateValidation.isValid) {
      metadata.document_date = null;
      metadata.date_mentioned = null;
      metadata.date_confidence = 0;
    } else if (documentDate) {
      metadata.document_date = dateValidation.correctedDate;
      metadata.date_mentioned = dateValidation.correctedDate;
    }

    return result;
  } catch (error) {
    console.error("AI classification error:", error);
    return {
      classification: classifyByFilename(filename),
      confidence: 0.5,
      metadata: {
        date_mentioned: null,
        deadline_mentioned: null,
        amounts: [],
        key_phrases: [],
        sender: "unknown",
        requires_action: false,
        urgency: "low",
        summary: "Classification fallback due to AI error",
      },
    };
  }
}

// ── Cross-Claim Vector Indexing ─────────────────────────────────────────────

const EVIDENCE_TYPE_MAP: Record<string, string> = {
  estimate: "estimate",
  denial: "denial_letter",
  approval: "approval_letter",
  engineering_report: "engineer_report",
  policy: "policy",
  correspondence: "correspondence",
  invoice: "invoice",
  rfi: "correspondence",
  photo: "photo_analysis",
  other: "other",
};

const LOSS_TYPE_MAP: Record<string, string> = {
  wind: "wind",
  hail: "hail",
  water: "water",
  fire: "fire",
  lightning: "lightning",
  tornado: "tornado",
  hurricane: "hurricane",
  theft: "theft",
  vandalism: "vandalism",
  collapse: "collapse",
  mold: "mold",
  freeze: "freeze",
};

function detectLossType(text: string): string | null {
  const lower = (text || "").toLowerCase();
  for (const [keyword, type] of Object.entries(LOSS_TYPE_MAP)) {
    if (lower.includes(keyword)) return type;
  }
  return null;
}

function detectTrade(text: string): string | null {
  const lower = (text || "").toLowerCase();
  const tradeMap: Record<string, string> = {
    roof: "roof",
    shingle: "roof",
    siding: "siding",
    gutter: "gutters",
    window: "windows",
    door: "doors",
    interior: "interior",
    drywall: "interior",
    hvac: "hvac",
    plumbing: "plumbing",
    electrical: "electrical",
    foundation: "foundation",
    fence: "fence",
    deck: "deck",
    garage: "garage",
  };
  for (const [keyword, trade] of Object.entries(tradeMap)) {
    if (lower.includes(keyword)) return trade;
  }
  return null;
}

function detectDecisionType(classification: string, metadata: any): string {
  if (classification === "denial")
    return metadata?.denial_type === "partial" ? "deny_partial" : "deny_full";
  if (classification === "approval") return "accept";
  if (classification === "estimate") return "pending";
  return "unknown";
}

function chunkText(text: string, chunkSize = 600, overlap = 100): string[] {
  const chunks: string[] = [];
  const sections = text.split(/(?=^#{1,3}\s)/m);
  for (const section of sections) {
    if (section.length <= chunkSize) {
      if (section.trim().length > 20) chunks.push(section.trim());
      continue;
    }
    for (let i = 0; i < section.length; i += chunkSize - overlap) {
      const chunk = section.substring(i, i + chunkSize).trim();
      if (chunk.length > 20) chunks.push(chunk);
    }
  }
  return chunks;
}

async function indexDocumentForRetrieval(
  supabase: any,
  claimId: string,
  fileId: string,
  textContent: string,
  classificationResult: ClassificationResult,
  file: any,
): Promise<number> {
  const { data: claim } = await supabase
    .from("claims")
    .select("insurance_company, loss_type, loss_date, policyholder_address")
    .eq("id", claimId)
    .single();

  const carrierName = claim?.insurance_company || null;
  const claimLossType =
    detectLossType(claim?.loss_type || "") || detectLossType(textContent);
  const trade = detectTrade(textContent);
  const evidenceType =
    EVIDENCE_TYPE_MAP[classificationResult.classification] || "other";
  const decisionType = detectDecisionType(
    classificationResult.classification,
    classificationResult.metadata,
  );
  const denialRationale = classificationResult.metadata?.denial_reason || null;
  const citedReasons = classificationResult.metadata?.key_phrases || [];
  const stateMatch = (claim?.policyholder_address || "").match(
    /\b([A-Z]{2})\b\s*\d{5}/,
  );
  const stateCode = stateMatch ? stateMatch[1] : null;

  const chunks = chunkText(textContent);
  if (chunks.length === 0) return 0;

  await supabase.from("claim_document_chunks").delete().eq("file_id", fileId);

  const chunkRows = chunks.map((content, index) => ({
    claim_id: claimId,
    file_id: fileId,
    chunk_index: index,
    content,
    carrier_name: carrierName,
    loss_type: claimLossType,
    trade,
    decision_type: decisionType,
    evidence_type: evidenceType,
    denial_rationale: denialRationale,
    cited_denial_reasons: citedReasons.length > 0 ? citedReasons : null,
    state_code: stateCode,
    loss_date: claim?.loss_date || null,
  }));

  const { data: insertedChunks, error: insertError } = await supabase
    .from("claim_document_chunks")
    .insert(chunkRows)
    .select("id, content");

  if (insertError) {
    console.error(
      "[BulkIntel] Chunk insert error:",
      insertError.message,
    );
    return 0;
  }

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    console.log("[BulkIntel] No OPENAI_API_KEY, skipping embeddings");
    return insertedChunks.length;
  }

  const EMB_BATCH = 50;
  for (let i = 0; i < insertedChunks.length; i += EMB_BATCH) {
    const batchTexts = insertedChunks
      .slice(i, i + EMB_BATCH)
      .map((c: any) => c.content);
    const batchIds = insertedChunks
      .slice(i, i + EMB_BATCH)
      .map((c: any) => c.id);

    try {
      const embResponse = await fetch(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: batchTexts,
          }),
        },
      );

      if (!embResponse.ok) {
        console.error(
          "[BulkIntel] Embedding API error:",
          embResponse.status,
        );
        continue;
      }

      const embData = await embResponse.json();
      const embeddings = embData.data.map((item: any) => item.embedding);

      for (let j = 0; j < batchIds.length; j++) {
        await supabase
          .from("claim_document_chunks")
          .update({ embedding: embeddings[j] })
          .eq("id", batchIds[j]);
      }
    } catch (embErr) {
      console.error("[BulkIntel] Embedding batch error:", embErr);
    }
  }

  return insertedChunks.length;
}

// ── Date Extraction (regex fallback from text) ──────────────────────────────

const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09",
  oct: "10", nov: "11", dec: "12",
};

function parseDateStrict(raw: string): string | null {
  const cleaned = raw.replace(/^[.,;:\s]+|[.,;:\s]+$/g, "").trim();
  if (!cleaned) return null;
  let yyyy: string, mm: string, dd: string;

  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    mm = slashMatch[1].padStart(2, "0");
    dd = slashMatch[2].padStart(2, "0");
    let yr = slashMatch[3];
    if (yr.length === 2) yr = `20${yr}`;
    yyyy = yr;
    return validateDateAndReturn(yyyy, mm, dd);
  }

  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    yyyy = isoMatch[1];
    mm = isoMatch[2];
    dd = isoMatch[3];
    return validateDateAndReturn(yyyy, mm, dd);
  }

  const wordMatch = cleaned.match(
    /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/,
  );
  if (wordMatch) {
    const monthKey = wordMatch[1].toLowerCase().replace(".", "");
    mm = MONTH_MAP[monthKey];
    if (!mm) return null;
    dd = wordMatch[2].padStart(2, "0");
    yyyy = wordMatch[3];
    return validateDateAndReturn(yyyy, mm, dd);
  }

  return null;
}

function validateDateAndReturn(
  yyyy: string,
  mm: string,
  dd: string,
): string | null {
  const y = parseInt(yyyy),
    m = parseInt(mm),
    d = parseInt(dd);
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

const DOC_TYPE_TO_ANCHOR_EVENT: Record<string, string> = {
  denial: "denial_issued",
  approval: "payment",
  estimate: "estimate_issued",
  engineering_report: "engineer_report_issued",
  rfi: "ror_issued",
  policy: "policy_issued",
  invoice: "invoice_issued",
  correspondence: "correspondence_issued",
};

const LABELED_DATE_TO_EVENT: Record<string, string> = {
  letter_date: "",
  fnol_date: "fnol_received",
  ack_date: "acknowledgement_issued",
  ror_date: "ror_issued",
  denial_date: "denial_issued",
  inspection_date: "inspection",
  payment_issue_date: "payment_issued",
  received_date: "document_received",
  loss_date: "loss_event",
  estimate_date: "estimate_issued",
};

function extractDatesToEvents(
  claimId: string,
  fileId: string,
  fileName: string,
  classificationResult: ClassificationResult,
  textContent: string,
): ClaimEventRow[] {
  const metadata = classificationResult.metadata as any;
  const docType = classificationResult.classification;
  const events: ClaimEventRow[] = [];

  LABELED_DATE_TO_EVENT.letter_date =
    DOC_TYPE_TO_ANCHOR_EVENT[docType] || `${docType}_issued`;

  const labeledDates = metadata.labeled_dates;
  if (labeledDates && typeof labeledDates === "object") {
    for (const [labelKey, entry] of Object.entries(labeledDates)) {
      if (labelKey === "prior_loss_dates") continue;
      const dateEntry = entry as { date?: string; snippet?: string } | null;
      if (!dateEntry?.date) continue;
      const validation = validateExtractedDate(dateEntry.date);
      if (!validation.isValid || !validation.correctedDate) continue;

      let eventType = LABELED_DATE_TO_EVENT[labelKey] || labelKey;
      const snippet = dateEntry.snippet || null;

      if (eventType === "loss_event" && snippet) {
        const priorPattern =
          /\b(prior|previous|history|past|prior\s+claim|previous\s+claim)\b/i;
        const lossLabelPattern =
          /\b(date\s+of\s+loss|DOL|loss\s+date|loss\s+occurred\s+on)\b/i;
        if (priorPattern.test(snippet)) eventType = "prior_loss_mentioned";
        else if (!lossLabelPattern.test(snippet)) eventType = "date_mentioned";
      } else if (eventType === "loss_event" && !snippet) {
        eventType = "date_mentioned";
      }

      events.push({
        claim_id: claimId,
        event_type: eventType,
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: `${eventType.replace(/_/g, " ")}: ${fileName}`,
        source_artifact_id: fileId,
        source_artifact_type: "claim_file",
        date_source: "document_extracted",
        date_confidence:
          metadata.date_confidence ?? classificationResult.confidence,
        date_evidence: snippet || `${labelKey} extracted from ${fileName}`,
        doc_type: docType,
        metadata_json: {
          file_name: fileName,
          extraction_method: "ai_labeled_date",
          label: labelKey,
          evidence_snippet: snippet,
        },
      });
    }

    const priorLossDates = labeledDates.prior_loss_dates;
    if (Array.isArray(priorLossDates)) {
      for (const pl of priorLossDates) {
        const plEntry = pl as { date?: string; snippet?: string } | null;
        if (!plEntry?.date) continue;
        const validation = validateExtractedDate(plEntry.date);
        if (!validation.isValid || !validation.correctedDate) continue;
        events.push({
          claim_id: claimId,
          event_type: "prior_loss_mentioned",
          occurred_at: new Date(validation.correctedDate).toISOString(),
          summary: `Prior loss mentioned: ${fileName}`,
          source_artifact_id: fileId,
          source_artifact_type: "claim_file",
          date_source: "document_extracted",
          date_confidence: (metadata.date_confidence ?? 0.7) * 0.8,
          date_evidence: plEntry.snippet || `Prior loss date from ${fileName}`,
          doc_type: docType,
          metadata_json: {
            file_name: fileName,
            extraction_method: "ai_labeled_date",
            label: "prior_loss_date",
          },
        });
      }
    }
  }

  const documentDate = metadata.document_date || metadata.date_mentioned;
  const anchorType =
    DOC_TYPE_TO_ANCHOR_EVENT[docType] || `${docType}_issued`;
  const hasLetterDate = events.some((e) => e.event_type === anchorType);
  if (documentDate && !hasLetterDate) {
    const validation = validateExtractedDate(documentDate);
    if (validation.isValid && validation.correctedDate) {
      events.push({
        claim_id: claimId,
        event_type: anchorType,
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: `${docType.replace(/_/g, " ")} issued: ${fileName}`,
        source_artifact_id: fileId,
        source_artifact_type: "claim_file",
        date_source: "document_extracted",
        date_confidence:
          metadata.date_confidence ?? classificationResult.confidence,
        date_evidence: `Document date extracted from ${fileName}`,
        doc_type: docType,
        metadata_json: {
          file_name: fileName,
          extraction_method: "ai_classification_fallback",
        },
      });
    }
  }

  if (metadata.deadline_mentioned) {
    const validation = validateExtractedDate(metadata.deadline_mentioned);
    if (validation.isValid && validation.correctedDate) {
      events.push({
        claim_id: claimId,
        event_type: "deadline",
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: `Deadline mentioned in ${fileName}`,
        source_artifact_id: fileId,
        source_artifact_type: "claim_file",
        date_source: "document_extracted",
        date_confidence: metadata.date_confidence ?? 0.7,
        date_evidence: `Deadline extracted from ${fileName}`,
        doc_type: docType,
        metadata_json: {
          file_name: fileName,
          extraction_method: "ai_classification",
        },
      });
    }
  }

  // Regex fallback if no AI dates extracted
  if (events.length === 0 && textContent && textContent.length > 50) {
    const regexEvents = extractDatesFromTextRegex(
      textContent,
      claimId,
      fileId,
      fileName,
      docType,
    );
    events.push(...regexEvents);
  }

  return events;
}

function extractDatesFromTextRegex(
  text: string,
  claimId: string,
  fileId: string,
  fileName: string,
  docType: string,
): ClaimEventRow[] {
  const events: ClaimEventRow[] = [];
  const PRIOR_LOSS_CONTEXT =
    /\b(prior|previous|history|past|prior\s+claim|previous\s+claim)\b/i;

  const labelPatterns: Array<{
    regex: RegExp;
    eventType: string;
    confidence: number;
  }> = [
    {
      regex: new RegExp(
        `(?:date\\s+of\\s+loss|DOL|loss\\s+date|loss\\s+occurred\\s+on)\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "loss_event",
      confidence: 0.9,
    },
    {
      regex: new RegExp(
        `(?:prior\\s+loss|previous\\s+loss|past\\s+loss|prior\\s+claim|previous\\s+claim)\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "prior_loss_mentioned",
      confidence: 0.85,
    },
    {
      regex: new RegExp(
        `(?:date\\s+reported|reported\\s+to\\s+us|notice\\s+of\\s+loss\\s+received)\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "fnol_received",
      confidence: 0.9,
    },
    {
      regex: new RegExp(
        `(?:denial\\s+date|date\\s+(?:of\\s+)?denial|denied\\s+on|decline\\s+date)\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "denial_issued",
      confidence: 0.9,
    },
    {
      regex: new RegExp(
        `(?:inspection\\s+date|inspected\\s+on|site\\s+visit\\s+(?:on|date))\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "inspection",
      confidence: 0.85,
    },
    {
      regex: new RegExp(
        `(?:check\\s+date|payment\\s+date|EFT\\s+date|payment\\s+issued)\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "payment_issued",
      confidence: 0.85,
    },
    {
      regex: new RegExp(
        `(?:estimate\\s+date|prepared\\s+on|scope\\s+date)\\s*[:\\-]?\\s*${DATE_CAPTURE}`,
        "gi",
      ),
      eventType: "estimate_issued",
      confidence: 0.85,
    },
  ];

  const seen = new Set<string>();

  function getSnippet(matchIndex: number): string {
    const start = Math.max(0, matchIndex - 40);
    const end = Math.min(text.length, matchIndex + 60);
    return text.substring(start, end).replace(/\n/g, " ").trim();
  }

  for (const lp of labelPatterns) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(lp.regex.source, lp.regex.flags);
    while ((match = regex.exec(text)) !== null) {
      const rawDate = match[1];
      const occurredAt = parseDateStrict(rawDate);
      if (!occurredAt) continue;

      let effectiveEventType = lp.eventType;
      const snippet = getSnippet(match.index);

      if (effectiveEventType === "loss_event") {
        const contextWindow = text.substring(
          Math.max(0, match.index - 50),
          Math.min(text.length, match.index + match[0].length + 50),
        );
        if (PRIOR_LOSS_CONTEXT.test(contextWindow))
          effectiveEventType = "prior_loss_mentioned";
      }

      const key = `${effectiveEventType}|${occurredAt}|${fileId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      events.push({
        claim_id: claimId,
        event_type: effectiveEventType,
        occurred_at: occurredAt,
        summary: `${effectiveEventType.replace(/_/g, " ")}: ${rawDate} (regex from ${fileName})`,
        source_artifact_id: fileId,
        source_artifact_type: "claim_file",
        date_source: "document_text_regex",
        date_confidence: lp.confidence,
        date_evidence: snippet,
        doc_type: docType,
        metadata_json: {
          file_name: fileName,
          extraction_method: "text_regex_labeled",
        },
      });

      if (events.length >= 10) break;
    }
    if (events.length >= 10) break;
  }

  return events;
}

// ── Deep Analysis Trigger ───────────────────────────────────────────────────

async function triggerDeepAnalysis(
  supabase: any,
  claimId: string,
  classification: DocumentClassification,
  fileId: string,
  filePath: string | undefined,
) {
  const analysisMap: Record<string, string> = {
    denial: "denial_rebuttal",
    engineering_report: "engineer_report_rebuttal",
    estimate: "estimate_gap_analysis",
  };

  const analysisType = analysisMap[classification];
  if (!analysisType || !filePath) return;

  const { data: recentAnalysis } = await supabase
    .from("darwin_analysis_results")
    .select("id")
    .eq("claim_id", claimId)
    .eq("analysis_type", analysisType)
    .gte(
      "created_at",
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    )
    .limit(1);

  if (recentAnalysis && recentAnalysis.length > 0) return;

  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from("claim-files")
    .download(filePath);

  if (downloadError || !fileBlob) return;

  const arrayBuffer = await fileBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  const base64 = btoa(binary);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  fetch(`${SUPABASE_URL}/functions/v1/darwin-ai-analysis`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      claimId,
      analysisType,
      pdfContent: base64,
      pdfFileName: filePath.split("/").pop(),
      additionalContext: {
        auto_triggered: true,
        source_file_id: fileId,
        trigger_reason: `Bulk intelligence pass — ${classification} detected`,
      },
    }),
  }).catch((err) =>
    console.error("[BulkIntel] Deep analysis call failed:", err),
  );

  await supabase.from("darwin_action_log").insert({
    claim_id: claimId,
    action_type: "auto_deep_analysis",
    action_details: {
      file_id: fileId,
      classification,
      analysis_type: analysisType,
      source: "bulk_document_intelligence",
    },
    was_auto_executed: true,
    result: `Bulk intelligence: triggered ${analysisType} for detected ${classification}`,
    trigger_source: "bulk_document_intelligence",
  });
}

// ── Process a single file ───────────────────────────────────────────────────

interface FileProcessResult {
  file_id: string;
  file_name: string;
  classification: string;
  confidence: number;
  chunks_created: number;
  events_created: number;
  deep_analysis_triggered: boolean;
  success: boolean;
  reason?: string;
}

async function processFile(
  supabase: any,
  file: {
    id: string;
    file_name: string;
    file_path: string;
    claim_id: string;
    extracted_text: string;
  },
): Promise<FileProcessResult> {
  const result: FileProcessResult = {
    file_id: file.id,
    file_name: file.file_name,
    classification: "unknown",
    confidence: 0,
    chunks_created: 0,
    events_created: 0,
    deep_analysis_triggered: false,
    success: false,
  };

  try {
    const textContent = file.extracted_text;
    if (!textContent || textContent.length < 50) {
      result.reason = "insufficient_text";
      await supabase
        .from("claim_files")
        .update({
          processed_by_darwin: true,
          darwin_processed_at: new Date().toISOString(),
          document_classification: classifyByFilename(file.file_name),
          classification_confidence: 0.4,
          classification_metadata: {
            method: "filename_pattern",
            summary: `Classified by filename (insufficient text: ${textContent?.length || 0} chars)`,
            source: "bulk_document_intelligence",
          },
        })
        .eq("id", file.id);
      return result;
    }

    // 1) Classify document via AI
    const classificationResult = await classifyDocument(
      textContent,
      file.file_name,
    );
    result.classification = classificationResult.classification;
    result.confidence = classificationResult.confidence;

    // 2) Update file record with classification
    await supabase
      .from("claim_files")
      .update({
        document_classification: classificationResult.classification,
        classification_confidence: classificationResult.confidence,
        classification_metadata: {
          ...classificationResult.metadata,
          source: "bulk_document_intelligence",
        },
        processed_by_darwin: true,
        darwin_processed_at: new Date().toISOString(),
      })
      .eq("id", file.id);

    // 3) Log classification action
    await supabase.from("darwin_action_log").insert({
      claim_id: file.claim_id,
      action_type: "document_classified",
      action_details: {
        file_id: file.id,
        file_name: file.file_name,
        classification: classificationResult.classification,
        confidence: classificationResult.confidence,
        source: "bulk_document_intelligence",
      },
      was_auto_executed: true,
      result: `Bulk classified as ${classificationResult.classification} (${Math.round(classificationResult.confidence * 100)}%): ${classificationResult.metadata.summary}`,
      trigger_source: "bulk_document_intelligence",
    });

    // 4) Cross-claim vector indexing (chunking + embedding)
    if (textContent.length >= 100) {
      try {
        result.chunks_created = await indexDocumentForRetrieval(
          supabase,
          file.claim_id,
          file.id,
          textContent,
          classificationResult,
          file,
        );
      } catch (err) {
        console.error(
          `[BulkIntel] Indexing error for ${file.file_name}:`,
          err,
        );
      }
    }

    // 5) Extract dates to claim_events
    if (classificationResult.confidence >= 0.6) {
      try {
        await supabase
          .from("claim_events")
          .delete()
          .eq("claim_id", file.claim_id)
          .eq("source_artifact_id", file.id);

        const events = extractDatesToEvents(
          file.claim_id,
          file.id,
          file.file_name,
          classificationResult,
          textContent,
        );

        let insertedCount = 0;
        for (const evt of events) {
          const { data: existing } = await supabase
            .from("claim_events")
            .select("id")
            .eq("claim_id", evt.claim_id)
            .eq("event_type", evt.event_type)
            .eq("occurred_at", evt.occurred_at)
            .eq("source_artifact_id", evt.source_artifact_id)
            .limit(1);

          if (!existing || existing.length === 0) {
            const { error } = await supabase.from("claim_events").insert(evt);
            if (!error) insertedCount++;
          }
        }
        result.events_created = insertedCount;
      } catch (err) {
        console.error(
          `[BulkIntel] Date extraction error for ${file.file_name}:`,
          err,
        );
      }
    }

    // 6) Trigger deep analysis for key document types
    if (classificationResult.confidence >= 0.8) {
      const triggerable = ["denial", "engineering_report", "estimate"];
      if (triggerable.includes(classificationResult.classification)) {
        result.deep_analysis_triggered = true;
        triggerDeepAnalysis(
          supabase,
          file.claim_id,
          classificationResult.classification,
          file.id,
          file.file_path,
        ).catch((err) =>
          console.error("[BulkIntel] Deep analysis error:", err),
        );
      }
    }

    result.success = true;
  } catch (err) {
    result.reason = err instanceof Error ? err.message : String(err);
    console.error(`[BulkIntel] Error processing ${file.file_name}:`, err);
  }

  return result;
}

// ── Main Handler ────────────────────────────────────────────────────────────

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
    const skipDeepAnalysis = body.skipDeepAnalysis || false;

    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({ success: true, message: "Lock released" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Acquire job lock
    const { data: lockResult, error: lockErr } = await supabase.rpc(
      "acquire_darwin_job",
      {
        p_job_type: JOB_TYPE,
        p_claimed_by: "bulk-document-intelligence",
        p_ttl_seconds: TTL_SECONDS,
      },
    );

    if (lockErr) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Lock RPC error: ${lockErr.message}`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!lockResult?.acquired) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Job already running",
          job: lockResult,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Find unprocessed files that have extracted text
    let query = supabase
      .from("claim_files")
      .select("id, file_name, file_path, claim_id, extracted_text")
      .not("extracted_text", "is", null)
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) query = query.gt("id", cursor);

    const { data: candidates, error: queryErr } = await query;
    if (queryErr) {
      await supabase.rpc("release_darwin_job", {
        p_job_type: JOB_TYPE,
        p_error_message: queryErr.message,
      });
      return new Response(
        JSON.stringify({ success: false, error: queryErr.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!candidates || candidates.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          remaining: 0,
          cursor: null,
          message: "All files have been processed",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Count total remaining
    let remainingQuery = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null)
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false");
    if (cursor) remainingQuery = remainingQuery.gt("id", cursor);
    const { count: totalRemaining } = await remainingQuery;

    const log: FileProcessResult[] = [];
    let earlyExit = false;

    for (const file of candidates) {
      if (Date.now() - batchStart > BATCH_MAX_RUNTIME_MS) {
        console.log(
          `[BulkIntel] Time guard hit after ${log.length} files, yielding`,
        );
        earlyExit = true;
        break;
      }

      const fileResult = await processFile(supabase, file);
      log.push(fileResult);

      await supabase.rpc("heartbeat_darwin_job", {
        p_job_type: JOB_TYPE,
        p_claimed_by: "bulk-document-intelligence",
      });

      console.log(
        `[BulkIntel] ${file.file_name}: ${fileResult.classification} (${Math.round(fileResult.confidence * 100)}%) — ${fileResult.chunks_created} chunks, ${fileResult.events_created} events`,
      );
    }

    const lastProcessedId =
      candidates[Math.min(log.length, candidates.length) - 1].id;
    const successCount = log.filter((l) => l.success).length;
    const totalChunks = log.reduce((s, l) => s + l.chunks_created, 0);
    const totalEvents = log.reduce((s, l) => s + l.events_created, 0);
    const deepAnalysisCount = log.filter(
      (l) => l.deep_analysis_triggered,
    ).length;

    // Re-count remaining using advanced cursor
    let finalRq = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null)
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false");
    if (lastProcessedId) finalRq = finalRq.gt("id", lastProcessedId);
    const { count: finalRemaining } = await finalRq;

    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });

    const classificationBreakdown: Record<string, number> = {};
    for (const entry of log) {
      if (entry.success) {
        classificationBreakdown[entry.classification] =
          (classificationBreakdown[entry.classification] || 0) + 1;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: log.length,
        classified: successCount,
        failed: log.length - successCount,
        remaining: Math.max(0, finalRemaining || 0),
        cursor: lastProcessedId,
        early_exit: earlyExit,
        elapsed_ms: Date.now() - batchStart,
        total_chunks_created: totalChunks,
        total_events_created: totalEvents,
        deep_analysis_triggered: deepAnalysisCount,
        classification_breakdown: classificationBreakdown,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[BulkIntel] Fatal error:", e);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, serviceKey);
      await sb.rpc("release_darwin_job", {
        p_job_type: JOB_TYPE,
        p_error_message: e instanceof Error ? e.message : "Unknown error",
      });
    } catch {
      /* best effort */
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
