import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OcrParsedResult {
  carrier_name: string | null;
  check_number: string | null;
  amount: string | null;
  issue_date: string | null;
  claim_number: string | null;
  payee_line: string | null;
  payees: Array<{ name: string; type: string }>;
  confidence: number | null; // 0-100 from AI
  low_confidence_fields: string[];
}

interface EligibilityResult {
  recommendation: string;
  reasons: string[];
  rules: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function safeBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return base64Encode(buf);
}

async function logAuditIdempotent(
  supabase: ReturnType<typeof createClient>,
  checkId: string,
  eventType: string,
  description: string,
  data: Record<string, unknown>,
  actorId: string | null,
) {
  // Use upsert-like approach: only insert if no matching recent entry exists
  const { data: existing } = await supabase
    .from("check_audit_log")
    .select("id")
    .eq("check_id", checkId)
    .eq("event_type", eventType)
    .gte("created_at", new Date(Date.now() - 5000).toISOString())
    .limit(1);

  if (existing && existing.length > 0) return;

  await supabase.from("check_audit_log").insert({
    check_id: checkId,
    event_type: eventType,
    event_description: description,
    event_data: data,
    actor_id: actorId,
  });
}

function evaluateEligibility(
  payees: Array<{ name: string; type: string }>,
  isMultiPayee: boolean,
  ocrConfidence: number | null,
): EligibilityResult {
  const rules: Record<string, unknown> = {};
  const reasons: string[] = [];

  rules.payee_count = payees.length;
  const hasMortgage = payees.some((p) => p.type === "mortgage_company");
  rules.mortgage_involved = hasMortgage;

  const hasInsured = payees.some((p) => p.type === "insured");
  const hasPa = payees.some((p) => p.type === "public_adjuster");
  rules.has_insured = hasInsured;
  rules.has_pa = hasPa;

  // Low OCR confidence triggers manual review
  if (ocrConfidence !== null && ocrConfidence < 70) {
    reasons.push("OCR confidence below 70% — manual verification recommended");
    rules.low_ocr_confidence = true;
  }

  if (payees.length === 0) {
    reasons.push("No payees detected from OCR — manual review needed");
    return { recommendation: "manual_review_required", reasons, rules };
  }

  if (payees.length > 2 || (hasMortgage && payees.length > 1)) {
    reasons.push("Complex multi-payee/mortgage structure — branch deposit required");
    if (hasMortgage) reasons.push("Mortgage company listed — separate endorsement process may apply");
    return { recommendation: "branch_deposit_recommended", reasons, rules };
  }

  if (isMultiPayee) {
    reasons.push("Multi-payee check — all endorsements must be collected first");
    return { recommendation: "endorsements_pending", reasons, rules };
  }

  // Single-payee logic: insured-only check is fine for deposit
  // PA not being listed is NOT a blocker for single-payee insured checks
  if (payees.length === 1 && hasInsured) {
    // Single insured payee — straightforward
    if (ocrConfidence !== null && ocrConfidence < 70) {
      return { recommendation: "manual_review_required", reasons, rules };
    }
    return { recommendation: "ready_for_deposit", reasons, rules };
  }

  if (payees.length === 1 && !hasInsured && !hasPa) {
    reasons.push("Single payee is not insured or PA — verify deposit authority");
    return { recommendation: "manual_review_required", reasons, rules };
  }

  // Default single-payee
  if (ocrConfidence !== null && ocrConfidence < 70) {
    return { recommendation: "manual_review_required", reasons, rules };
  }
  return { recommendation: "ready_for_deposit", reasons, rules };
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");

  try {
    /* ---- Auth (anon client, not service-role) ---- */
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) return err("Unauthorized", 401);

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: claimsData, error: authErr } =
      await anonClient.auth.getUser(token);
    if (authErr || !claimsData?.user) return err("Unauthorized", 401);
    const userId = claimsData.user.id;

    /* ---- Service client for storage / writes ---- */
    const supabase = createClient(supabaseUrl, serviceKey);

    /* ---- Body ---- */
    const { checkId } = (await req.json().catch(() => ({}))) as {
      checkId?: string;
    };
    if (!checkId) return err("checkId required", 400);

    /* ---- Fetch check ---- */
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("*")
      .eq("id", checkId)
      .single();

    if (checkErr || !check) return err("Check not found", 404);

    // Prevent concurrent processing
    if (check.ocr_status === "processing") {
      return err("OCR already in progress for this check", 409);
    }

    /* ---- Mark processing ---- */
    await supabase
      .from("check_intake_items")
      .update({ ocr_status: "processing" })
      .eq("id", checkId);

    // Wrap everything in try/catch for compensating rollback on failure
    try {
      await logAuditIdempotent(supabase, checkId, "ocr_started", "OCR processing initiated", {}, userId);

      /* ---- Download front image ---- */
      const { data: frontBlob, error: frontErr } = await supabase.storage
        .from("claim-files")
        .download(check.front_image_path);
      if (frontErr || !frontBlob) {
        throw new Error("Could not download front image: " + (frontErr?.message ?? "blob null"));
      }
      const frontBase64 = await safeBase64(frontBlob);

      /* ---- Download back image (optional) ---- */
      let backBase64: string | null = null;
      if (check.back_image_path) {
        const { data: backBlob, error: backErr } = await supabase.storage
          .from("claim-files")
          .download(check.back_image_path);
        if (!backErr && backBlob) {
          backBase64 = await safeBase64(backBlob);
        }
      }

      /* ---- AI OCR ---- */
      if (!lovableKey) throw new Error("LOVABLE_API_KEY not configured");

      const ocrPrompt = `You are an insurance check OCR specialist. Analyze this check image and extract structured data.
Return ONLY valid JSON with these fields:
{
  "carrier_name": "the insurance company name on the check",
  "check_number": "the check number",
  "amount": "numeric amount (no $ or commas)",
  "issue_date": "YYYY-MM-DD format",
  "claim_number": "claim/policy number if visible, null if not",
  "payee_line": "the full payee/pay-to-the-order-of line exactly as written",
  "payees": [
    { "name": "payee name", "type": "insured|mortgage_company|contractor|public_adjuster|unknown" }
  ],
  "confidence": 85,
  "low_confidence_fields": ["amount"]
}
Set "confidence" 0-100 reflecting how sure you are about the overall extraction.
List any fields where text was unclear or partially readable in "low_confidence_fields".
Classify: mortgage (banks, lending, mortgage), contractor (construction, roofing, restoration), public_adjuster (adjusting, PA), insured (individuals/homeowners), unknown otherwise.`;

      const content: Array<Record<string, unknown>> = [
        { type: "text", text: ocrPrompt },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${frontBase64}` },
        },
      ];
      if (backBase64) {
        content.push(
          { type: "text", text: "Here is the back of the check:" },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${backBase64}` },
          },
        );
      }

      const aiResp = await fetch("https://ai.lovable.dev/api/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content }],
        }),
      });

      if (!aiResp.ok) {
        const detail = await aiResp.text().catch(() => "");
        throw new Error(`AI OCR failed [${aiResp.status}]: ${detail}`);
      }

      const aiData = (await aiResp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = aiData.choices?.[0]?.message?.content ?? "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        await supabase
          .from("check_intake_items")
          .update({ ocr_status: "failed", raw_ocr_front: { raw } })
          .eq("id", checkId);
        return err("Could not parse OCR output", 500);
      }

      let parsed: OcrParsedResult;
      try {
        parsed = JSON.parse(jsonMatch[0]) as OcrParsedResult;
      } catch {
        await supabase
          .from("check_intake_items")
          .update({ ocr_status: "failed", raw_ocr_front: { raw } })
          .eq("id", checkId);
        return err("Invalid JSON in OCR output", 500);
      }

      const payees = parsed.payees ?? [];
      const isMultiPayee = payees.length > 1;
      const parsedAmount = parsed.amount ? Number(parsed.amount) : null;
      const ocrConfidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
      const lowConfidenceFields = Array.isArray(parsed.low_confidence_fields) ? parsed.low_confidence_fields : [];
      const needsManualReview = ocrConfidence !== null && ocrConfidence < 70;

      /* ---- Step 1: Update check record ---- */
      await supabase
        .from("check_intake_items")
        .update({
          carrier_name: parsed.carrier_name ?? null,
          check_number: parsed.check_number ?? null,
          amount: parsedAmount,
          issue_date: parsed.issue_date ?? null,
          detected_claim_number: parsed.claim_number ?? null,
          payee_line: parsed.payee_line ?? null,
          is_multi_payee: isMultiPayee,
          raw_ocr_front: {
            ...(parsed as unknown as Record<string, unknown>),
            ocr_confidence: ocrConfidence,
            low_confidence_fields: lowConfidenceFields,
            needs_manual_review: needsManualReview,
          },
          ocr_status: "completed",
          status: needsManualReview ? "needs_review" : "ocr_complete",
        })
        .eq("id", checkId);

      /* ---- Step 2: Replace payees (delete + insert for idempotency) ---- */
      await supabase.from("check_payees").delete().eq("check_id", checkId);

      for (const p of payees) {
        const endorseToken = crypto.randomUUID();
        await supabase.from("check_payees").insert({
          check_id: checkId,
          payee_name: p.name,
          payee_type: p.type || "unknown",
          endorsement_token: endorseToken,
          endorsement_token_expires_at: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });
      }

      await logAuditIdempotent(
        supabase, checkId, "ocr_completed",
        `OCR extracted ${payees.length} payee(s), amount: $${parsedAmount ?? "N/A"}, confidence: ${ocrConfidence ?? "N/A"}%`,
        { ...(parsed as unknown as Record<string, unknown>), ocr_confidence: ocrConfidence },
        userId,
      );

      /* ---- Step 3: Eligibility ---- */
      const eligibility = evaluateEligibility(payees, isMultiPayee, ocrConfidence);

      // Upsert eligibility: delete old results for this check then insert
      await supabase.from("check_eligibility_results").delete().eq("check_id", checkId);
      await supabase.from("check_eligibility_results").insert({
        check_id: checkId,
        recommendation: eligibility.recommendation,
        reasons: eligibility.reasons,
        rule_results: eligibility.rules,
        evaluated_by: userId,
      });

      await supabase
        .from("check_intake_items")
        .update({
          deposit_recommendation: eligibility.recommendation,
          deposit_recommendation_reasons: eligibility.reasons,
        })
        .eq("id", checkId);

      await logAuditIdempotent(
        supabase, checkId, "eligibility_evaluated",
        `Recommendation: ${eligibility.recommendation}`,
        eligibility as unknown as Record<string, unknown>,
        userId,
      );

      /* ---- Step 4: Claim wallet insertion (idempotent via upsert) ---- */
      if (check.claim_id && parsedAmount && parsedAmount > 0) {
        // Check for existing payment linked to this check
        const refNum = parsed.check_number ?? `check-${checkId}`;
        const { data: existingPayment } = await supabase
          .from("claim_payments")
          .select("id")
          .eq("claim_id", check.claim_id)
          .eq("reference_number", refNum)
          .limit(1);

        if (!existingPayment || existingPayment.length === 0) {
          await supabase.from("claim_payments").insert({
            claim_id: check.claim_id,
            amount: parsedAmount,
            payment_type: "check",
            payment_method: "insurance_check",
            description: `Insurance check #${parsed.check_number ?? "N/A"} from ${parsed.carrier_name ?? "Unknown carrier"}`,
            reference_number: refNum,
            payment_date: parsed.issue_date ?? new Date().toISOString().split("T")[0],
            status: "pending",
          });
          await logAuditIdempotent(
            supabase, checkId, "claim_wallet_entry_created",
            `Payment of $${parsedAmount} linked to claim`,
            { claim_id: check.claim_id, amount: parsedAmount },
            userId,
          );
        } else {
          // Update existing payment amount if changed
          await supabase
            .from("claim_payments")
            .update({
              amount: parsedAmount,
              description: `Insurance check #${parsed.check_number ?? "N/A"} from ${parsed.carrier_name ?? "Unknown carrier"}`,
            })
            .eq("id", existingPayment[0].id);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          parsed: { ...parsed, ocr_confidence: ocrConfidence, needs_manual_review: needsManualReview },
          payees,
          eligibility,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (innerErr) {
      // Compensating logic: reset check to previous state on failure
      await supabase
        .from("check_intake_items")
        .update({ ocr_status: "failed", status: check.status ?? "uploaded" })
        .eq("id", checkId);

      await logAuditIdempotent(
        supabase, checkId, "ocr_failed",
        `OCR processing failed: ${innerErr instanceof Error ? innerErr.message : "Unknown"}`,
        { error: innerErr instanceof Error ? innerErr.message : String(innerErr) },
        userId,
      );

      throw innerErr;
    }
  } catch (e) {
    console.error("check-ocr-intake error:", e);
    return err(e instanceof Error ? e.message : "Unknown error", 500);
  }
});

function err(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
