import { createClient } from "npm:@supabase/supabase-js@2.39.3";

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

function log(stage: string, msg: string, data?: Record<string, unknown>) {
  const entry = { stage, msg, ...(data ?? {}), ts: new Date().toISOString() };
  console.log(`[check-ocr-intake][${stage}] ${msg}`, data ? JSON.stringify(data) : "");
  return entry;
}

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

function okResponse(body: Record<string, unknown>) {
  return new Response(
    JSON.stringify(body),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function errResponse(message: string, status: number, stage?: string) {
  return new Response(
    JSON.stringify({ success: false, error: message, stage: stage ?? null }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let stage = "init";

  try {
    log("init", "Handler entered");

    // ---- Env ----
    stage = "env_check";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    if (!supabaseUrl || !serviceKey || !anonKey) {
      log("env_check", "MISSING env vars", { url: !!supabaseUrl, svc: !!serviceKey, anon: !!anonKey });
      return errResponse("Missing required environment variables", 500, stage);
    }
    if (!lovableKey) {
      log("env_check", "MISSING LOVABLE_API_KEY");
      return errResponse("Missing LOVABLE_API_KEY", 500, stage);
    }
    log("env_check", "All env vars present");

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
    log("auth", "Authenticated", { userId });

    // ---- Supabase service client ----
    const supabase = createClient(supabaseUrl, serviceKey);

    // ---- Parse request ----
    stage = "parse_request";
    const { checkId } = (await req.json().catch(() => ({}))) as { checkId?: string };
    if (!checkId) return errResponse("checkId required", 400, stage);
    log("parse_request", "Parsed", { checkId });

    // ---- Fetch check ----
    stage = "fetch_check";
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("*")
      .eq("id", checkId)
      .single();
    if (checkErr || !check) {
      log("fetch_check", "Not found", { error: checkErr?.message });
      return errResponse("Check not found", 404, stage);
    }
    log("fetch_check", "Found", { status: check.status, ocr_status: check.ocr_status, claim_id: check.claim_id });

    // ---- Stale lock handling ----
    stage = "stale_lock_check";
    if (check.ocr_status === "processing") {
      const heartbeat = (check as Record<string, unknown>).ocr_heartbeat_at;
      const heartbeatMs = heartbeat ? new Date(heartbeat as string).getTime() : 0;
      const lockAge = Date.now() - heartbeatMs;
      if (heartbeatMs > 0 && lockAge < STALE_LOCK_MS) {
        log("stale_lock_check", "Active lock — rejecting", { lockAge });
        return errResponse("OCR already in progress for this check", 409, stage);
      }
      log("stale_lock_check", "Stale lock cleared", { lockAge });
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
    log("check_endorsements", "Checked", { hasActiveEndorsements, count: activePayees?.length ?? 0 });

    // ---- Mark processing ----
    stage = "mark_processing";
    const now = new Date().toISOString();
    await supabase
      .from("check_intake_items")
      .update({ ocr_status: "processing", ocr_heartbeat_at: now, updated_at: now })
      .eq("id", checkId);
    await logAudit(supabase, checkId, "ocr_started", "OCR processing initiated", {}, userId);
    log("mark_processing", "Marked as processing");

    // ======================================================================
    // OCR PIPELINE — errors here should NOT lose OCR data if we got results
    // ======================================================================

    let parsed: OcrParsedResult | null = null;
    let ocrError: string | null = null;

    try {
      // ---- Signed URLs ----
      stage = "signed_url_create";
      const { data: frontUrlData, error: frontUrlErr } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check.front_image_path, 300);
      if (frontUrlErr || !frontUrlData?.signedUrl) {
        throw new Error("Could not create signed URL for front image: " + (frontUrlErr?.message ?? "no URL"));
      }
      const frontImageUrl = frontUrlData.signedUrl;
      log("signed_url_create", "Front URL created");

      let backImageUrl: string | null = null;
      if (check.back_image_path) {
        const { data: backUrlData, error: backUrlErr } = await supabase.storage
          .from("claim-files")
          .createSignedUrl(check.back_image_path, 300);
        if (!backUrlErr && backUrlData?.signedUrl) {
          backImageUrl = backUrlData.signedUrl;
          log("signed_url_create", "Back URL created");
        }
      }

      // ---- AI OCR request ----
      stage = "ocr_request_sent";
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
- CRITICAL: "payees" should ONLY contain the names of people or organizations the check is payable to. Do NOT include mailing addresses, street addresses, city/state/zip, suite numbers, PO boxes, or any address components as payees. The "payee_line" field captures the full text, but "payees" must be only the entity names (e.g. "Freedom Adjustment" and "Ildefonso Rosas", NOT "865 Route 33 Business Ste 3 Unit #231 Freehold NJ 07728").
- Amount must be numeric only. Date must be YYYY-MM-DD.
- CRITICAL for amount: The check amount appears in TWO places — a numeric box (usually right side) AND written out in words on the "dollars" line. Check BOTH locations. Even if one is partially obscured, use the other. The amount should almost NEVER be null for a valid check. If you can read the written-out amount (e.g. "Two thousand five hundred ten and 27/100"), convert it to numeric (2510.27). Only return null if BOTH the numeric and written amounts are completely unreadable.
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

      log("ocr_request_sent", "Sending to AI gateway");

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

      stage = "ocr_response_received";
      log("ocr_response_received", "AI responded", { status: aiResp.status });

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
        log("ocr_parse", "JSON parse failed", { preview: rawText.substring(0, 300) });
        // Save raw OCR even though parse failed
        await supabase.from("check_intake_items")
          .update({
            ocr_status: "failed",
            ocr_heartbeat_at: null,
            raw_ocr_front: { raw: rawText.substring(0, 2000), parse_error: (parseErr as Error).message },
          })
          .eq("id", checkId);
        return errResponse("Could not parse OCR output as valid JSON", 500, stage);
      }

      // ---- Validate ----
      stage = "ocr_validate";
      parsed = validateOcrOutput(rawObj);
      log("ocr_validate", "Validated", {
        carrier: parsed.carrier_name,
        amount: parsed.amount,
        payeeCount: parsed.payees.length,
        confidence: parsed.confidence,
      });

    } catch (ocrErr) {
      // OCR pipeline itself failed (signed URL, AI request, parse)
      ocrError = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
      log(stage, "OCR pipeline error", { error: ocrError });
    }

    // ======================================================================
    // If OCR failed (no parsed result), mark failed and return
    // ======================================================================
    if (!parsed) {
      log("ocr_failed", "No OCR result — marking failed");
      await supabase.from("check_intake_items")
        .update({
          ocr_status: "failed",
          ocr_heartbeat_at: null,
          status: check.status ?? "uploaded",
          raw_ocr_front: { ocr_error: ocrError, stage },
        })
        .eq("id", checkId);
      await logAudit(supabase, checkId, "ocr_failed",
        `OCR failed at ${stage}: ${ocrError}`,
        { error: ocrError, stage }, userId);

      return okResponse({
        success: true,
        ocr_success: false,
        stage,
        error: ocrError,
      });
    }

    // ======================================================================
    // OCR SUCCEEDED — now commit results. Post-OCR errors are non-fatal.
    // ======================================================================

    const payees = parsed.payees;
    const isMultiPayee = payees.length > 1;

    let normalizedIssueDate: string | null = null;
    if (parsed.issue_date) {
      const dateStr = String(parsed.issue_date).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr))) {
        normalizedIssueDate = dateStr;
      } else {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          normalizedIssueDate = d.toISOString().split("T")[0];
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
    const checkStatus = needsManualReview
      ? "needs_review"
      : eligibility.recommendation === "loss_draft_required"
        ? "loss_draft_required"
        : "ocr_complete";

    // ---- Commit via RPC (non-fatal wrapper) ----
    stage = "rpc_commit";
    let rpcResult: unknown = null;
    let rpcError: string | null = null;

    try {
      log("rpc_commit", "Starting RPC commit");
      const { data, error: rpcErr } = await supabase.rpc("ocr_commit_results", {
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
        rpcError = rpcErr.message;
        log("rpc_commit", "RPC FAILED — falling back to direct update", { error: rpcError });
        throw new Error(rpcError);
      }

      rpcResult = data;
      log("rpc_commit", "RPC committed successfully");
    } catch (commitErr) {
      // RPC failed — do a minimal direct update so OCR data is not lost
      rpcError = commitErr instanceof Error ? commitErr.message : String(commitErr);
      log("rpc_commit_fallback", "Applying direct fallback update", { error: rpcError });

      try {
        // Save OCR data to check_intake_items
        await supabase.from("check_intake_items")
          .update({
            carrier_name: parsed.carrier_name,
            check_number: parsed.check_number,
            amount: parsedAmount,
            issue_date: normalizedIssueDate,
            payee_line: parsed.payee_line,
            is_multi_payee: isMultiPayee,
            raw_ocr_front: {
              ...parsed,
              ocr_confidence: ocrConfidence,
              field_confidence: fieldConfidence,
              needs_manual_review: needsManualReview,
              rpc_error: rpcError,
            },
            ocr_status: "completed",
            ocr_heartbeat_at: null,
            status: needsManualReview ? "needs_review" : "ocr_complete",
            deposit_recommendation: eligibility.recommendation === "loss_draft_required"
              ? "loss_draft_required"
              : eligibility.recommendation,
            deposit_recommendation_reasons: eligibility.reasons,
            updated_at: new Date().toISOString(),
          })
          .eq("id", checkId);
        log("rpc_commit_fallback", "Direct check update succeeded");

        // CRITICAL: Also insert payees — the RPC rollback wiped them
        if (!hasActiveEndorsements && payees.length > 0) {
          // Delete any stale payees first
          await supabase.from("check_payees").delete().eq("check_id", checkId);

          const payeeRows = payees.map((p) => ({
            check_id: checkId,
            payee_name: p.name,
            payee_type: p.type || "unknown",
            endorsement_token: crypto.randomUUID(),
            endorsement_token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          }));

          const { error: payeeErr } = await supabase.from("check_payees").insert(payeeRows);
          if (payeeErr) {
            log("rpc_commit_fallback", "Payee insert failed", { error: payeeErr.message });
          } else {
            log("rpc_commit_fallback", `Inserted ${payeeRows.length} payees via fallback`);
          }
        }

        // Also insert eligibility results
        await supabase.from("check_eligibility_results").delete().eq("check_id", checkId);
        await supabase.from("check_eligibility_results").insert({
          check_id: checkId,
          recommendation: eligibility.recommendation,
          reasons: eligibility.reasons,
          rule_results: eligibility.rules,
          evaluated_by: userId,
        });

        log("rpc_commit_fallback", "Full fallback succeeded — OCR data + payees + eligibility saved");
      } catch (fallbackErr) {
        log("rpc_commit_fallback", "Direct update also failed", {
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }

      await logAudit(supabase, checkId, "ocr_rpc_failed",
        `RPC commit failed but OCR data saved directly: ${rpcError}`,
        { error: rpcError, stage: "rpc_commit" }, userId);
    }

    // ---- Auto-create endorsement records (non-fatal) ----
    stage = "endorsement_create";
    if (!hasActiveEndorsements && payees.length > 0) {
      try {
        const { data: endorsementResult, error: endorseErr } = await supabase.rpc(
          "create_endorsements_from_payees",
          { p_check_id: checkId },
        );
        if (endorseErr) {
          log("endorsement_create", "Endorsement creation failed (non-fatal)", { error: endorseErr.message });
        } else {
          log("endorsement_create", "Endorsements created", { result: endorsementResult });
        }
      } catch (endorseEx) {
        log("endorsement_create", "Endorsement exception (non-fatal)", {
          error: endorseEx instanceof Error ? endorseEx.message : String(endorseEx),
        });
      }
    }

    stage = "complete";
    log("complete", "OCR pipeline finished", {
      ocr_success: true,
      rpc_success: !rpcError,
      checkStatus,
      recommendation: eligibility.recommendation,
    });

    return okResponse({
      success: true,
      ocr_success: true,
      rpc_success: !rpcError,
      rpc_error: rpcError,
      parsed: { ...parsed, needs_manual_review: needsManualReview },
      payees,
      eligibility,
      payees_preserved: hasActiveEndorsements,
      transaction: rpcResult,
    });

  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : null;
    log(stage, "FATAL unhandled error", { message, stack });
    return errResponse(message, 500, stage);
  }
});
