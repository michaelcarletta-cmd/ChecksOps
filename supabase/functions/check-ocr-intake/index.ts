import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OcrPayee {
  name: string;
  type: string;
}

interface OcrParsedResult {
  carrier_name: string | null;
  check_number: string | null;
  amount: string | null;
  issue_date: string | null;
  claim_number: string | null;
  payee_line: string | null;
  payees: OcrPayee[];
  confidence: number | null;
  field_confidence: Record<string, number>;
  low_confidence_fields: string[];
}

interface EligibilityResult {
  recommendation: string;
  reasons: string[];
  rules: Record<string, unknown>;
}

const VALID_PAYEE_TYPES = new Set([
  "insured", "mortgage_company", "contractor", "public_adjuster", "unknown",
]);

const CRITICAL_FIELDS = ["amount", "check_number", "payee_line"] as const;
const CRITICAL_CONFIDENCE_THRESHOLD = 60;
const OVERALL_CONFIDENCE_THRESHOLD = 50;
const STALE_LOCK_MS = 2 * 60 * 1000;
const OCR_TIMEOUT_MS = 45_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function logAudit(
  supabase: ReturnType<typeof createClient>,
  checkId: string,
  eventType: string,
  description: string,
  data: Record<string, unknown>,
  actorId: string | null,
) {
  return supabase.from("check_audit_log").insert({
    check_id: checkId,
    event_type: eventType,
    event_description: description,
    event_data: data,
    actor_id: actorId,
  });
}

function validateOcrOutput(raw: unknown): OcrParsedResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("OCR output is not an object");
  }
  const obj = raw as Record<string, unknown>;

  const str = (k: string): string | null => {
    const v = obj[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  const rawPayees = Array.isArray(obj.payees) ? obj.payees : [];
  const payees: OcrPayee[] = rawPayees
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      name: typeof p.name === "string" ? p.name.trim() : "",
      type: typeof p.type === "string" && VALID_PAYEE_TYPES.has(p.type) ? p.type : "unknown",
    }))
    .filter((p) => p.name.length > 0);

  const rawAmount = str("amount");
  let amount: string | null = null;
  if (rawAmount !== null) {
    const cleaned = rawAmount.replace(/[$,\s]/g, "");
    if (!isNaN(Number(cleaned)) && Number(cleaned) > 0) {
      amount = cleaned;
    }
  }

  const rawDate = str("issue_date");
  let issueDate: string | null = null;
  if (rawDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    issueDate = rawDate;
  }

  const rawConf = typeof obj.confidence === "number" ? obj.confidence : null;
  const confidence = rawConf !== null ? Math.max(0, Math.min(100, Math.round(rawConf))) : null;

  const rawFieldConf = typeof obj.field_confidence === "object" && obj.field_confidence !== null
    ? obj.field_confidence as Record<string, unknown>
    : {};
  const fieldConfidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawFieldConf)) {
    if (typeof v === "number") fieldConfidence[k] = Math.max(0, Math.min(100, Math.round(v)));
  }

  const lowConfidenceFields = Array.isArray(obj.low_confidence_fields)
    ? obj.low_confidence_fields.filter((f): f is string => typeof f === "string")
    : [];

  return {
    carrier_name: str("carrier_name"),
    check_number: str("check_number"),
    amount,
    issue_date: issueDate,
    claim_number: str("claim_number"),
    payee_line: str("payee_line"),
    payees,
    confidence,
    field_confidence: fieldConfidence,
    low_confidence_fields: lowConfidenceFields,
  };
}

function evaluateEligibility(
  payees: OcrPayee[],
  isMultiPayee: boolean,
  ocrConfidence: number | null,
  fieldConfidence: Record<string, number>,
): EligibilityResult {
  const rules: Record<string, unknown> = {};
  const reasons: string[] = [];

  rules.payee_count = payees.length;
  const hasMortgage = payees.some((p) => p.type === "mortgage_company");
  const hasInsured = payees.some((p) => p.type === "insured");
  const hasPa = payees.some((p) => p.type === "public_adjuster");
  rules.mortgage_involved = hasMortgage;
  rules.has_insured = hasInsured;
  rules.has_pa = hasPa;

  let criticalFieldFailed = false;
  for (const field of CRITICAL_FIELDS) {
    const fc = fieldConfidence[field];
    if (fc !== undefined && fc < CRITICAL_CONFIDENCE_THRESHOLD) {
      reasons.push(`Critical field "${field}" has low confidence (${fc}%) — manual review needed`);
      criticalFieldFailed = true;
    }
  }
  if (criticalFieldFailed) {
    rules.critical_field_low_confidence = true;
  }

  if (ocrConfidence !== null && ocrConfidence < OVERALL_CONFIDENCE_THRESHOLD) {
    reasons.push(`Overall OCR confidence ${ocrConfidence}% is below threshold — manual review`);
    rules.low_ocr_confidence = true;
  }

  if (criticalFieldFailed || (ocrConfidence !== null && ocrConfidence < OVERALL_CONFIDENCE_THRESHOLD)) {
    return { recommendation: "manual_review_required", reasons, rules };
  }

  if (payees.length === 0) {
    reasons.push("No payees detected from OCR — manual review needed");
    return { recommendation: "manual_review_required", reasons, rules };
  }

  // Mortgage company detected — route to loss draft workflow
  if (hasMortgage) {
    reasons.push("Mortgage company listed — routing to Loss Draft workflow");
    if (payees.length > 2) reasons.push("Complex multi-payee/mortgage structure");
    return { recommendation: "loss_draft_required", reasons, rules };
  }

  if (payees.length > 2) {
    reasons.push("Complex multi-payee structure — branch deposit required");
    return { recommendation: "branch_deposit_recommended", reasons, rules };
  }

  if (isMultiPayee) {
    reasons.push("Multi-payee check — all endorsements must be collected first");
    return { recommendation: "endorsements_pending", reasons, rules };
  }

  if (payees.length === 1 && hasInsured) return { recommendation: "ready_for_deposit", reasons, rules };
  if (payees.length === 1 && hasPa) return { recommendation: "ready_for_deposit", reasons, rules };
  if (payees.length === 1) {
    reasons.push("Single payee type unclear — verify deposit authority");
    return { recommendation: "manual_review_required", reasons, rules };
  }

  return { recommendation: "ready_for_deposit", reasons, rules };
}

function parseStrictJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch { /* fall through */ }
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch { /* fall through */ }
  }

  throw new Error("AI response is not valid JSON and contains no fenced JSON block");
}

function errResponse(message: string, status: number, stage?: string) {
  return new Response(
    JSON.stringify({ success: false, error: message, stage: stage ?? null }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/* ------------------------------------------------------------------ */
/*  Main handler — everything inside Deno.serve, no top-level throws  */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let stage = "init";

  try {
    console.log("check-ocr-intake: entered handler");

    // ---- Env ----
    stage = "env";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    if (!supabaseUrl || !serviceKey || !anonKey) {
      console.error("check-ocr-intake: missing env vars", {
        SUPABASE_URL: !!supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: !!serviceKey,
        SUPABASE_ANON_KEY: !!anonKey,
      });
      return errResponse("Missing required environment variables", 500, stage);
    }
    if (!lovableKey) {
      console.error("check-ocr-intake: LOVABLE_API_KEY missing");
      return errResponse("Missing LOVABLE_API_KEY", 500, stage);
    }
    console.log("check-ocr-intake: env ok");

    // ---- Auth ----
    stage = "auth";
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) return errResponse("Unauthorized", 401, stage);

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authErr } = await anonClient.auth.getUser(token);
    if (authErr || !authData?.user) return errResponse("Unauthorized", 401, stage);
    const userId = authData.user.id;

    // ---- Supabase service client ----
    stage = "supabase_client";
    const supabase = createClient(supabaseUrl, serviceKey);
    console.log("check-ocr-intake: supabase client created");

    // ---- Parse request ----
    stage = "parse_request";
    const { checkId } = (await req.json().catch(() => ({}))) as { checkId?: string };
    if (!checkId) return errResponse("checkId required", 400, stage);
    console.log("check-ocr-intake: request parsed, checkId=" + checkId);

    // ---- Fetch check ----
    stage = "fetch_check";
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("*")
      .eq("id", checkId)
      .single();
    if (checkErr || !check) return errResponse("Check not found", 404, stage);

    // ---- Stale lock handling ----
    stage = "stale_lock";
    if (check.ocr_status === "processing") {
      const heartbeat = (check as Record<string, unknown>).ocr_heartbeat_at;
      const heartbeatMs = heartbeat ? new Date(heartbeat as string).getTime() : 0;
      const lockAge = Date.now() - heartbeatMs;
      if (heartbeatMs > 0 && lockAge < STALE_LOCK_MS) {
        return errResponse("OCR already in progress for this check", 409, stage);
      }
      await logAudit(supabase, checkId, "stale_lock_cleared",
        "Stale OCR processing lock cleared after timeout",
        { stale_since: heartbeat, lock_age_ms: lockAge }, userId);
    }

    // ---- Check active endorsements ----
    stage = "check_endorsements";
    const { data: activePayees } = await supabase
      .from("check_payees")
      .select("id, endorsement_status")
      .eq("check_id", checkId)
      .neq("endorsement_status", "pending");
    const hasActiveEndorsements = (activePayees?.length ?? 0) > 0;

    // ---- Mark processing ----
    stage = "mark_processing";
    const now = new Date().toISOString();
    await supabase
      .from("check_intake_items")
      .update({ ocr_status: "processing", ocr_heartbeat_at: now, updated_at: now })
      .eq("id", checkId);
    await logAudit(supabase, checkId, "ocr_started", "OCR processing initiated", {}, userId);

    try {
      // ---- Signed URLs ----
      stage = "signed_url";
      const { data: frontUrlData, error: frontUrlErr } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check.front_image_path, 300);
      if (frontUrlErr || !frontUrlData?.signedUrl) {
        throw new Error("Could not create signed URL for front image: " + (frontUrlErr?.message ?? "no URL"));
      }
      const frontImageUrl = frontUrlData.signedUrl;
      console.log("check-ocr-intake: signed url created");

      let backImageUrl: string | null = null;
      if (check.back_image_path) {
        const { data: backUrlData, error: backUrlErr } = await supabase.storage
          .from("claim-files")
          .createSignedUrl(check.back_image_path, 300);
        if (!backUrlErr && backUrlData?.signedUrl) {
          backImageUrl = backUrlData.signedUrl;
        }
      }

      // ---- AI OCR request ----
      stage = "ocr_request";
      const ocrPrompt = `You are an insurance check OCR specialist. Analyze this check image and extract structured data.
Return ONLY a valid JSON object with these exact fields:
{
  "carrier_name": "the insurance company name on the check or null",
  "check_number": "the check number or null",
  "amount": "numeric amount only, no $ or commas, or null",
  "issue_date": "YYYY-MM-DD format or null",
  "claim_number": "claim/policy number if visible or null",
  "payee_line": "the full pay-to-the-order-of line exactly as written or null",
  "payees": [
    { "name": "payee name", "type": "insured|mortgage_company|contractor|public_adjuster|unknown" }
  ],
  "confidence": 85,
  "field_confidence": { "amount": 95, "check_number": 90, "payee_line": 80, "carrier_name": 70 },
  "low_confidence_fields": ["carrier_name"]
}

Rules:
- "confidence" is 0-100 for overall extraction quality.
- "field_confidence" gives per-field confidence for: amount, check_number, payee_line, carrier_name, issue_date.
- "low_confidence_fields" lists fields where text was unclear.
- Payee type: mortgage_company (banks/lending/mortgage), contractor (construction/roofing/restoration), public_adjuster (adjusting/PA), insured (individuals/homeowners), unknown otherwise.
- Amount must be numeric only. Date must be YYYY-MM-DD.
- Return ONLY the JSON object, no markdown, no explanation.`;

      const content: Array<Record<string, unknown>> = [
        { type: "text", text: ocrPrompt },
        { type: "image_url", image_url: { url: frontImageUrl } },
      ];
      if (backImageUrl) {
        content.push(
          { type: "text", text: "Here is the back of the check:" },
          { type: "image_url", image_url: { url: backImageUrl } },
        );
      }

      console.log("check-ocr-intake: lovable request starting");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

      let aiResp: Response;
      try {
        aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            response_format: { type: "json_object" },
            messages: [{ role: "user", content }],
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const isTimeout = msg.includes("abort");
        throw new Error(isTimeout ? `OCR request timed out after ${OCR_TIMEOUT_MS / 1000}s` : `OCR fetch failed: ${msg}`);
      }
      clearTimeout(timeout);

      console.log("check-ocr-intake: lovable response received, status=" + aiResp.status);

      if (!aiResp.ok) {
        const detail = await aiResp.text().catch(() => "");
        throw new Error(`AI OCR failed [${aiResp.status}]: ${detail}`);
      }

      stage = "ocr_parse";
      let aiData: { choices?: Array<{ message?: { content?: string } }> };
      try {
        aiData = await aiResp.json();
      } catch {
        throw new Error("AI response is not valid JSON");
      }
      const rawText = aiData.choices?.[0]?.message?.content ?? "";

      let rawObj: unknown;
      try {
        rawObj = parseStrictJson(rawText);
      } catch (parseErr) {
        console.error("check-ocr-intake: JSON parse failed", rawText.substring(0, 500));
        await supabase.from("check_intake_items")
          .update({
            ocr_status: "failed",
            ocr_heartbeat_at: null,
            raw_ocr_front: { raw: rawText.substring(0, 2000), parse_error: (parseErr as Error).message },
          })
          .eq("id", checkId);
        return errResponse("Could not parse OCR output as valid JSON", 500, stage);
      }

      // ---- Validate & process ----
      stage = "ocr_validate";
      const parsed = validateOcrOutput(rawObj);
      const payees = parsed.payees;
      const isMultiPayee = payees.length > 1;

      // Normalize issue_date: must be a valid YYYY-MM-DD string or null
      let normalizedIssueDate: string | null = null;
      if (parsed.issue_date) {
        const dateStr = String(parsed.issue_date).trim();
        // Accept YYYY-MM-DD format only
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr))) {
          normalizedIssueDate = dateStr;
        } else {
          // Try to parse other formats
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) {
            normalizedIssueDate = d.toISOString().split("T")[0];
          } else {
            console.warn("check-ocr-intake: unparseable issue_date, setting null:", dateStr);
          }
        }
      }
      const parsedAmount = parsed.amount ? Number(parsed.amount) : null;
      const ocrConfidence = parsed.confidence;
      const fieldConfidence = parsed.field_confidence;

      const criticalFailed = CRITICAL_FIELDS.some((f) => {
        const fc = fieldConfidence[f];
        return fc !== undefined && fc < CRITICAL_CONFIDENCE_THRESHOLD;
      });
      const overallFailed = ocrConfidence !== null && ocrConfidence < OVERALL_CONFIDENCE_THRESHOLD;
      const needsManualReview = criticalFailed || overallFailed;

      const eligibility = evaluateEligibility(payees, isMultiPayee, ocrConfidence, fieldConfidence);
      const checkStatus = needsManualReview ? "needs_review" : "ocr_complete";

      // ---- Commit via RPC ----
      stage = "rpc_commit";
      const { data: rpcResult, error: rpcErr } = await supabase.rpc("ocr_commit_results", {
        p_check_id: checkId,
        p_carrier_name: parsed.carrier_name,
        p_check_number: parsed.check_number,
        p_amount: parsedAmount,
        p_issue_date: normalizedIssueDate,
        p_claim_number: parsed.claim_number,
        p_payee_line: parsed.payee_line,
        p_is_multi_payee: isMultiPayee,
        p_raw_ocr: {
          ...parsed,
          ocr_confidence: ocrConfidence,
          field_confidence: fieldConfidence,
          needs_manual_review: needsManualReview,
        },
        p_ocr_status: "completed",
        p_check_status: checkStatus,
        p_payees: payees,
        p_recommendation: eligibility.recommendation,
        p_reasons: eligibility.reasons,
        p_rules: eligibility.rules,
        p_evaluated_by: userId,
        p_claim_id: check.claim_id ?? null,
        p_has_active_endorsements: hasActiveEndorsements,
      });

      if (rpcErr) {
        throw new Error(`Transaction failed: ${rpcErr.message}`);
      }

      // ---- Auto-create endorsement records from payees ----
      if (!hasActiveEndorsements && payees.length > 0) {
        try {
          const { data: endorsementResult, error: endorseErr } = await supabase.rpc(
            "create_endorsements_from_payees",
            { p_check_id: checkId },
          );
          if (endorseErr) {
            console.error("check-ocr-intake: endorsement creation failed:", endorseErr.message);
          } else {
            console.log("check-ocr-intake: endorsements created:", endorsementResult);
          }
        } catch (endorseEx) {
          console.error("check-ocr-intake: endorsement creation exception:", endorseEx);
        }
      }

      console.log("check-ocr-intake: completed successfully");

      return new Response(
        JSON.stringify({
          success: true,
          parsed: { ...parsed, needs_manual_review: needsManualReview },
          payees,
          eligibility,
          payees_preserved: hasActiveEndorsements,
          transaction: rpcResult,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (innerErr) {
      // OCR failed — mark as failed but don't crash the upload
      console.error("check-ocr-intake: OCR inner error at stage=" + stage, innerErr);
      await supabase
        .from("check_intake_items")
        .update({
          ocr_status: "failed",
          ocr_heartbeat_at: null,
          status: check.status ?? "uploaded",
          raw_ocr_front: { ocr_error: innerErr instanceof Error ? innerErr.message : String(innerErr), stage },
        })
        .eq("id", checkId);

      await logAudit(supabase, checkId, "ocr_failed",
        `OCR failed: ${innerErr instanceof Error ? innerErr.message : "Unknown"}`,
        { error: innerErr instanceof Error ? innerErr.message : String(innerErr), stage },
        userId);

      // Return success for the upload, but indicate OCR failed
      return new Response(
        JSON.stringify({
          success: true,
          ocr_success: false,
          stage,
          error: innerErr instanceof Error ? innerErr.message : String(innerErr),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : null;
    console.error("check-ocr-intake fatal:", { stage, message, stack });
    return errResponse(message, 500, stage);
  }
});
