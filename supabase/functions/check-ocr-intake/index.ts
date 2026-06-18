import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { callVision } from "../_shared/ai/generate.ts";
import { MODEL_VISION, MODEL_VISION_STRONG } from "../_shared/ai/modelRouter.ts";
import { resolveTenantOpenAIKey } from "../_shared/ai/tenantKeyResolver.ts";

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
  routing_number: string | null;
  account_number: string | null;
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

interface AmountFallbackResult {
  amount: string | null;
  confidence: number | null;
  raw: string | null;
}

type VisionContentPart = { type: string; text?: string; image_url?: { url: string } };

const VALID_PAYEE_TYPES = new Set([
  "insured", "mortgage_company", "contractor", "public_adjuster", "unknown",
]);

const CRITICAL_FIELDS = ["amount", "check_number", "payee_line"] as const;
const CRITICAL_CONFIDENCE_THRESHOLD = 60;
const OVERALL_CONFIDENCE_THRESHOLD = 50;
const STALE_LOCK_MS = 5 * 60 * 1000; // increased from 2min — OCR can take 45s per pass, 2min caused duplicate payees on retry
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
  supabase: any,
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

function normalizeAmountValue(raw: string | null): string | null {
  if (!raw) return null;

  const direct = raw.replace(/[$,\s]/g, "");
  if (!isNaN(Number(direct)) && Number(direct) > 0) {
    return Number(direct).toFixed(2);
  }

  // Fallback: grab first numeric token from messy OCR output like
  // "Amount: USD 12,540.75" or "12 540.75 dollars"
  const match = raw.match(/\d[\d,]*(?:\.\d{1,2})?/);
  if (!match) return null;

  const token = match[0].replace(/,/g, "");
  const parsed = Number(token);
  if (isNaN(parsed) || parsed <= 0) return null;

  return parsed.toFixed(2);
}

async function extractAmountWithFocusedPass(
  tenantApiKey: string | null,
  frontImageUrl: string,
  backImageUrl: string | null,
): Promise<AmountFallbackResult> {
  const amountPrompt = `You are extracting ONLY the check amount from an insurance check image.
Return ONLY valid JSON:
{
  "amount": "1234.56" or null,
  "confidence": 0-100,
  "reason": "short explanation"
}

Rules:
- Check BOTH the numeric amount box and the written amount line ending with "dollars".
- If one is unclear, use the other.
- Convert written-out amount words to numeric.
- Amount must be numeric with optional decimals, no currency symbols.
- Return null ONLY if both locations are unreadable.`;

  const content: VisionContentPart[] = [
    { type: "text", text: amountPrompt },
    { type: "image_url", image_url: { url: frontImageUrl } },
  ];

  if (backImageUrl) {
    content.push(
      { type: "text", text: "Back image (for context if needed):" },
      { type: "image_url", image_url: { url: backImageUrl } },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const visionResult = await callVision({
      model: MODEL_VISION_STRONG,
      messages: [{ role: "user", content }],
      jsonMode: true,
      apiKey: tenantApiKey ?? undefined,
    });

    const rawText = visionResult.text;

    const rawObj = parseStrictJson(rawText) as Record<string, unknown>;
    const amount = normalizeAmountValue(typeof rawObj.amount === "string" ? rawObj.amount : null);
    const confidence = typeof rawObj.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(rawObj.confidence)))
      : null;

    return {
      amount,
      confidence,
      raw: rawText.slice(0, 1000),
    };
  } finally {
    clearTimeout(timeout);
  }
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
      name: typeof p.name === "string" ? toStandardCaps(p.name.trim()) : "",
      type: typeof p.type === "string" && VALID_PAYEE_TYPES.has(p.type) ? p.type : "unknown",
    }))
    .filter((p) => p.name.length > 0);

  const rawAmount = str("amount");
  const amount = normalizeAmountValue(rawAmount);

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

  // MICR digits-only normalization (strip everything except 0-9)
  const digitsOnly = (k: string): string | null => {
    const v = str(k);
    if (!v) return null;
    const d = v.replace(/[^0-9]/g, "");
    return d.length >= 4 ? d : null;
  };

  return {
    carrier_name: toStandardCaps(str("carrier_name")),
    check_number: str("check_number"),
    amount,
    issue_date: issueDate,
    claim_number: str("claim_number"),
    payee_line: toStandardCaps(str("payee_line")),
    routing_number: digitsOnly("routing_number"),
    account_number: digitsOnly("account_number"),
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

  // Mortgage on the check → always Loss Draft
  if (hasMortgage) {
    reasons.push("Mortgage company listed — routing to Loss Draft workflow");
    if (payees.length > 2) reasons.push("Complex multi-payee/mortgage structure");
    return { recommendation: "loss_draft_required", reasons, rules };
  }

  // Multi-payee (no mortgage) → endorsements must be collected before deposit
  if (payees.length > 2) {
    reasons.push("Complex multi-payee structure — collect endorsements before deposit");
    return { recommendation: "endorsements_pending", reasons, rules };
  }

  if (isMultiPayee || payees.length > 1) {
    reasons.push("Multi-payee check — all endorsements must be collected first");
    return { recommendation: "endorsements_pending", reasons, rules };
  }

  // Single-payee (no mortgage) → still goes to Needs Review.
  // A check is only ever moved to "Approved for Deposit" once all required
  // endorsements/signatures are confirmed received or waived — never directly
  // from OCR intake.
  reasons.push("OCR complete — manual review required before deposit");
  return { recommendation: "manual_review_required", reasons, rules };
}

function parseStrictJson(rawText: string): unknown {
  let trimmed = rawText.trim();

  // Strip markdown fences
  trimmed = trimmed
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  // Direct parse
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch { /* fall through to recovery */ }
  }

  // Fenced block extraction
  const fenceMatch = rawText.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch { /* fall through */ }
  }

  // Truncation recovery: find the outermost { and try to close truncated JSON
  const objStart = trimmed.indexOf("{");
  if (objStart !== -1) {
    let candidate = trimmed.slice(objStart);
    // Count unclosed braces/brackets and attempt to close them
    let openBraces = 0, openBrackets = 0;
    let inString = false, escape = false;
    for (const ch of candidate) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") openBraces++;
      if (ch === "}") openBraces--;
      if (ch === "[") openBrackets++;
      if (ch === "]") openBrackets--;
    }
    // Remove trailing incomplete key-value or array element
    candidate = candidate.replace(/,\s*"[^"]*"?\s*:?\s*(?:\{[^}]*)?$/, "");
    candidate = candidate.replace(/,\s*\{[^}]*$/, "");
    candidate = candidate.replace(/,\s*$/, "");
    // Close unclosed brackets/braces
    for (let i = 0; i < Math.max(0, openBrackets); i++) candidate += "]";
    for (let i = 0; i < Math.max(0, openBraces); i++) candidate += "}";
    try {
      return JSON.parse(candidate);
    } catch { /* fall through */ }
  }

  throw new Error("AI response is not valid JSON and contains no fenced JSON block");
}

function okResponse(body: Record<string, unknown>) {
  return new Response(
    JSON.stringify(body),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function errResponse(message: string, status: number, stage?: string) {
  return okResponse({
    success: false,
    error: message,
    stage: stage ?? null,
    http_status: status,
  });
}

function deriveFallbackCheckDate(issueDate: unknown, createdAt: unknown): string {
  if (typeof issueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    return issueDate;
  }

  const parsedCreatedAt = typeof createdAt === "string" && !isNaN(Date.parse(createdAt))
    ? new Date(createdAt)
    : new Date();

  return parsedCreatedAt.toISOString().split("T")[0];
}

async function ensureClaimCheckLinkOnFailure(
  supabase: any,
  check: Record<string, unknown>,
  userId: string,
  reason: string,
) {
  const checkId = typeof check.id === "string" ? check.id : null;
  const claimId = typeof check.claim_id === "string" && check.claim_id ? check.claim_id : null;

  if (!checkId || !claimId) return;

  const { data: existingCheck, error: existingErr } = await supabase
    .from("claim_checks")
    .select("id")
    .eq("check_intake_item_id", checkId)
    .maybeSingle();

  if (existingErr) {
    log("claim_check_link_fallback", "Lookup failed", { checkId, claimId, error: existingErr.message });
    return;
  }

  if (existingCheck) {
    const linkedCheck = existingCheck as { id: string };
    log("claim_check_link_fallback", "Linked claim check already exists", {
      checkId,
      claimId,
      claimCheckId: linkedCheck.id,
    });
    return;
  }

  const { error: insertErr } = await supabase.from("claim_checks").insert({
    claim_id: claimId,
    check_intake_item_id: checkId,
    check_date: deriveFallbackCheckDate(check.issue_date, check.created_at),
    amount: typeof check.amount === "number" && Number.isFinite(check.amount) ? check.amount : 0,
    check_type: "initial",
    created_by: userId,
    check_number: typeof check.check_number === "string" ? check.check_number : null,
    carrier_name: typeof check.carrier_name === "string" ? check.carrier_name : null,
    payee_line: typeof check.payee_line === "string" ? check.payee_line : null,
    source: "check_center_upload",
    notes: reason,
  });

  if (insertErr) {
    log("claim_check_link_fallback", "Insert failed", { checkId, claimId, error: insertErr.message });
    return;
  }

  log("claim_check_link_fallback", "Created linked claim check placeholder", { checkId, claimId });
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
    const lovableKey = "_shared_layer"; // kept for signature compat; shared AI layer handles keys
    log("env_check", "All env vars present");

    // ---- Auth ----
    stage = "auth";
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) return errResponse("Unauthorized", 401, stage);

    if (!supabaseUrl || !serviceKey || !anonKey) return errResponse("Missing backend configuration", 500, stage);

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

    // ---- Tenant OpenAI key resolution (Pure BYOK) ----
    // White-label tenants must bring their own OpenAI key (billed to their OpenAI account).
    // Freedom Claims (system tenant) continues to use the platform OPENAI_API_KEY.
    stage = "tenant_key";
    const tenantId = (check as Record<string, unknown>).tenant_id as string | null;
    const keyResult = await resolveTenantOpenAIKey(supabase, tenantId);
    const tenantApiKey: string | null = keyResult.key;
    log("tenant_key", "Resolved", {
      tenantId,
      isSystemTenant: keyResult.isSystemTenant,
      status: keyResult.status,
      hasKey: !!tenantApiKey,
    });

    if (!keyResult.isSystemTenant && !tenantApiKey) {
      const reason =
        keyResult.status === "missing"
          ? "No OpenAI API key configured for this tenant. Add one in Settings → AI Key."
          : keyResult.status === "invalid"
          ? "Stored OpenAI API key is invalid. Re-enter it in Settings → AI Key."
          : "OpenAI API key not active. Verify it in Settings → AI Key.";
      await logAudit(supabase, checkId, "byok_key_missing",
        `Check OCR blocked: ${reason}`,
        { tenant_id: tenantId, status: keyResult.status }, userId);
      return errResponse(reason, 402, stage);
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
  "routing_number": "9-digit bank routing number from the MICR line at the bottom of the check, digits only, or null",
  "account_number": "bank account number from the MICR line at the bottom of the check, digits only, or null",
  "payees": [
    { "name": "payee name", "type": "insured|mortgage_company|contractor|public_adjuster|unknown" }
  ],
  "confidence": 85,
  "field_confidence": { "amount": 95, "check_number": 90, "payee_line": 80, "carrier_name": 70, "routing_number": 95, "account_number": 90 },
  "low_confidence_fields": ["carrier_name"]
}

Rules:
- "confidence" is 0-100 for overall extraction quality.
- "field_confidence" gives per-field confidence for: amount, check_number, payee_line, carrier_name, issue_date, routing_number, account_number.
- "low_confidence_fields" lists fields where text was unclear.
- Payee type: mortgage_company (banks/lending/mortgage), contractor (construction/roofing/restoration), public_adjuster (adjusting/PA), insured (individuals/homeowners), unknown otherwise.
- CRITICAL: "payees" should ONLY contain the names of people or organizations the check is payable to. Do NOT include mailing addresses, street addresses, city/state/zip, suite numbers, PO boxes, or any address components as payees. The "payee_line" field captures the full text, but "payees" must be only the entity names (e.g. "Freedom Adjustment" and "Ildefonso Rosas", NOT "865 Route 33 Business Ste 3 Unit #231 Freehold NJ 07728").
- Amount must be numeric only. Date must be YYYY-MM-DD.
- CRITICAL for amount: The check amount appears in TWO places — a numeric box (usually right side) AND written out in words on the "dollars" line. Check BOTH locations. Even if one is partially obscured, use the other. The amount should almost NEVER be null for a valid check. If you can read the written-out amount (e.g. "Two thousand five hundred ten and 27/100"), convert it to numeric (2510.27). Only return null if BOTH the numeric and written amounts are completely unreadable.
- CRITICAL for MICR (routing/account): Look at the bottom edge of the check for the magnetic ink line printed in the special MICR font. The format is typically: ⑆ROUTING⑆ ACCOUNT⑈ CHECK#  (transit/routing is 9 digits flanked by ⑆ symbols, then the account number, then the check number flanked by ⑈). Extract routing_number as the 9-digit number, account_number as the variable-length account digits. Return digits only — strip the special MICR symbols (⑆ ⑇ ⑈ ⑉) and any spaces. If the MICR line is not visible or unreadable, return null for both.
- Return ONLY the JSON object, no markdown, no explanation.`;

      const content: VisionContentPart[] = [
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

      let visionResult;
      try {
        // Use the STRONG vision model for check OCR. The cheap model
        // (gpt-4o-mini) frequently returns blank/incorrect fields on dense
        // check images (amount box, payee line, MICR check number).
        visionResult = await callVision({
          model: MODEL_VISION_STRONG,
          messages: [{ role: "user", content }],
          jsonMode: true,
          temperature: 0,
          maxTokens: 4000,
          apiKey: tenantApiKey ?? undefined,
        });
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        throw new Error(`OCR fetch failed: ${msg}`);
      }

      stage = "ocr_response_received";
      log("ocr_response_received", "AI responded via shared layer");

      stage = "ocr_parse";
      const rawText = visionResult.text;

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
            check_stage: "review",
            ocr_needs_verification: true,
            raw_ocr_front: { raw: rawText.substring(0, 2000), parse_error: (parseErr as Error).message },
          })
          .eq("id", checkId);

        await ensureClaimCheckLinkOnFailure(
          supabase,
          check as Record<string, unknown>,
          userId,
          "OCR failed before extraction. Complete the check details manually from the claim.",
        );

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

      // If primary OCR misses amount, do a focused second pass just for amount.
      if (!parsed.amount) {
        stage = "amount_fallback";
        try {
          const fallback = await extractAmountWithFocusedPass(tenantApiKey, frontImageUrl, backImageUrl);
          if (fallback.amount) {
            parsed.amount = fallback.amount;
            if (fallback.confidence !== null) {
              parsed.field_confidence.amount = Math.max(parsed.field_confidence.amount ?? 0, fallback.confidence);
            }
            parsed.low_confidence_fields = parsed.low_confidence_fields.filter((f) => f !== "amount");
            log("amount_fallback", "Recovered amount with focused pass", {
              amount: fallback.amount,
              confidence: fallback.confidence,
            });

            await logAudit(
              supabase,
              checkId,
              "ocr_amount_recovered",
              "Recovered missing amount using focused OCR fallback pass",
              { amount: fallback.amount, confidence: fallback.confidence, raw: fallback.raw },
              userId,
            );
          } else {
            log("amount_fallback", "Focused pass still could not extract amount");
          }
        } catch (fallbackErr) {
          log("amount_fallback", "Focused amount extraction failed", {
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      }

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
          check_stage: "review",
          ocr_needs_verification: true,
          raw_ocr_front: { ocr_error: ocrError, stage },
        })
        .eq("id", checkId);

      await ensureClaimCheckLinkOnFailure(
        supabase,
        check as Record<string, unknown>,
        userId,
        "OCR failed before extraction. Complete the check details manually from the claim.",
      );

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
    const amountMissing = parsedAmount === null || Number.isNaN(parsedAmount);

    const criticalFailed = CRITICAL_FIELDS.some((f) => {
      const fc = fieldConfidence[f];
      return fc !== undefined && fc < CRITICAL_CONFIDENCE_THRESHOLD;
    });
    const overallFailed = ocrConfidence !== null && ocrConfidence < OVERALL_CONFIDENCE_THRESHOLD;
    const needsManualReview = criticalFailed || overallFailed || amountMissing;

    const eligibility = evaluateEligibility(payees, isMultiPayee, ocrConfidence, fieldConfidence);
    if (amountMissing) {
      eligibility.recommendation = "manual_review_required";
      eligibility.rules.amount_missing = true;
      if (!eligibility.reasons.some((r) => r.toLowerCase().includes("amount"))) {
        eligibility.reasons.unshift("Check amount could not be extracted automatically — manual review required");
      }
    }
    // Always land checks in Review first — never auto-advance to Endorsing/Deposit.
    // The reviewer explicitly decides the next stage via the Review console.
    // The deposit_recommendation is still persisted so the reviewer sees the AI suggestion.
    const checkStatus = needsManualReview ? "needs_review" : "needs_review";

    // ---- Auto-link to existing claim by claim_number ----
    // If this check isn't already linked to a claim and OCR detected a claim number,
    // try to find an existing claim (real CRM record or tracking-only ledger) and
    // link this check to it so all checks for the same claim aggregate together.
    stage = "auto_link_claim";
    let autoLinkedClaimId: string | null = check.claim_id ?? null;
    if (!autoLinkedClaimId && parsed.claim_number) {
      try {
        const trimmed = String(parsed.claim_number).trim();
        if (trimmed) {
          const { data: matches, error: lookupErr } = await supabase
            .from("claims")
            .select("id, claim_number")
            .ilike("claim_number", trimmed)
            .limit(2);
          if (lookupErr) {
            log("auto_link_claim", "Lookup failed", { error: lookupErr.message });
          } else if (matches && matches.length === 1) {
            autoLinkedClaimId = matches[0].id;
            log("auto_link_claim", "Linked to existing claim", { claimId: autoLinkedClaimId, claimNumber: trimmed });
          } else if (matches && matches.length > 1) {
            log("auto_link_claim", "Ambiguous — multiple claims match", { claimNumber: trimmed, count: matches.length });
          } else {
            log("auto_link_claim", "No matching claim", { claimNumber: trimmed });
          }
        }
      } catch (e) {
        log("auto_link_claim", "Exception", { error: e instanceof Error ? e.message : String(e) });
      }
    }

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
        p_claim_id: autoLinkedClaimId,
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
            routing_number: parsed.routing_number,
            account_number: parsed.account_number,
            is_multi_payee: isMultiPayee,
            detected_claim_number: parsed.claim_number ?? null,
            claim_id: autoLinkedClaimId,

            raw_ocr_front: {
              ...parsed,
              ocr_confidence: ocrConfidence,
              field_confidence: fieldConfidence,
              needs_manual_review: needsManualReview,
              rpc_error: rpcError,
            },
            ocr_status: "completed",
            ocr_heartbeat_at: null,
            status: checkStatus,
            check_stage: "review",
            ocr_needs_verification: needsManualReview || parsedAmount == null,
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

    // ---- Persist MICR (routing/account) — RPC signature doesn't include them ----
    if (parsed.routing_number || parsed.account_number) {
      try {
        await supabase.from("check_intake_items")
          .update({
            routing_number: parsed.routing_number,
            account_number: parsed.account_number,
          })
          .eq("id", checkId);
        log("micr_persist", "Routing/account saved to intake", {
          routing: parsed.routing_number ? "***" + parsed.routing_number.slice(-4) : null,
          account: parsed.account_number ? "***" + parsed.account_number.slice(-4) : null,
        });
        // Mirror to claim_checks if linked
        await supabase.from("claim_checks")
          .update({
            routing_number: parsed.routing_number,
            account_number: parsed.account_number,
          })
          .eq("check_intake_item_id", checkId);
      } catch (micrErr) {
        log("micr_persist", "Failed to persist MICR", {
          error: micrErr instanceof Error ? micrErr.message : String(micrErr),
        });
      }
    }

    // ---- Always make sure the check is linked into claim_checks ----
    // The RPC's Step 5 swallows errors silently, so a check could end up
    // attached to a claim_intake row but missing from claim_checks (which is
    // what makes the check appear under the claim's Accounting/Checks tabs).
    // This call is idempotent — it no-ops if a link already exists.
    stage = "claim_check_link_ensure";
    try {
      const { data: refreshedCheck } = await supabase
        .from("check_intake_items")
        .select("*")
        .eq("id", checkId)
        .maybeSingle();
      if (refreshedCheck) {
        await ensureClaimCheckLinkOnFailure(
          supabase,
          refreshedCheck,
          userId,
          rpcError
            ? `Auto-linked after RPC failure: ${rpcError}`
            : "Auto-linked post-OCR (safety net)",
        );
      }
    } catch (linkErr) {
      log("claim_check_link_ensure", "Safety-net link failed (non-fatal)", {
        error: linkErr instanceof Error ? linkErr.message : String(linkErr),
      });
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
