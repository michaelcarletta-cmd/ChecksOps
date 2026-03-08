import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");
    const supabase = createClient(supabaseUrl, serviceKey);

    // Auth
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { checkId } = await req.json();
    if (!checkId) {
      return new Response(JSON.stringify({ error: "checkId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get check record
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("*")
      .eq("id", checkId)
      .single();

    if (checkErr || !check) {
      return new Response(JSON.stringify({ error: "Check not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update status
    await supabase.from("check_intake_items").update({ ocr_status: "processing" }).eq("id", checkId);
    await logAudit(supabase, checkId, "ocr_started", "OCR processing initiated", {}, user.id);

    // Download front image
    const { data: frontBlob } = await supabase.storage.from("claim-files").download(check.front_image_path);
    if (!frontBlob) {
      await supabase.from("check_intake_items").update({ ocr_status: "failed" }).eq("id", checkId);
      return new Response(JSON.stringify({ error: "Could not download front image" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const frontBase64 = btoa(String.fromCharCode(...new Uint8Array(await frontBlob.arrayBuffer())));

    // Download back image if present
    let backBase64: string | null = null;
    if (check.back_image_path) {
      const { data: backBlob } = await supabase.storage.from("claim-files").download(check.back_image_path);
      if (backBlob) {
        backBase64 = btoa(String.fromCharCode(...new Uint8Array(await backBlob.arrayBuffer())));
      }
    }

    // OCR via Lovable AI
    if (!lovableKey) {
      await supabase.from("check_intake_items").update({ ocr_status: "failed" }).eq("id", checkId);
      return new Response(JSON.stringify({ error: "AI key not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
  ]
}
Classify payees: mortgage companies (banks, lending, mortgage in name), contractors (construction, roofing, restoration), public adjusters (adjusting, PA firm), insured (individuals/homeowners), unknown otherwise.`;

    const messages: any[] = [
      {
        role: "user",
        content: [
          { type: "text", text: ocrPrompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frontBase64}` } },
        ],
      },
    ];

    if (backBase64) {
      messages[0].content.push(
        { type: "text", text: "Here is the back of the check:" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${backBase64}` } }
      );
    }

    const aiResp = await fetch("https://ai.lovable.dev/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.5-flash", messages }),
    });

    if (!aiResp.ok) {
      await supabase.from("check_intake_items").update({ ocr_status: "failed" }).eq("id", checkId);
      return new Response(JSON.stringify({ error: "AI OCR failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResp.json();
    const raw = aiData.choices?.[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      await supabase.from("check_intake_items").update({ ocr_status: "failed", raw_ocr_front: { raw } }).eq("id", checkId);
      return new Response(JSON.stringify({ error: "Could not parse OCR output", raw }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const payees = parsed.payees || [];
    const isMultiPayee = payees.length > 1;

    // Update check record
    await supabase.from("check_intake_items").update({
      carrier_name: parsed.carrier_name || null,
      check_number: parsed.check_number || null,
      amount: parsed.amount ? Number(parsed.amount) : null,
      issue_date: parsed.issue_date || null,
      detected_claim_number: parsed.claim_number || null,
      payee_line: parsed.payee_line || null,
      is_multi_payee: isMultiPayee,
      raw_ocr_front: parsed,
      ocr_status: "completed",
      status: "ocr_complete",
    }).eq("id", checkId);

    // Create payee records
    for (const p of payees) {
      const token = crypto.randomUUID();
      await supabase.from("check_payees").insert({
        check_id: checkId,
        payee_name: p.name,
        payee_type: p.type || "unknown",
        endorsement_token: token,
        endorsement_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    await logAudit(supabase, checkId, "ocr_completed", `OCR extracted ${payees.length} payee(s), amount: $${parsed.amount}`, parsed, user.id);
    await logAudit(supabase, checkId, "payees_detected", `${payees.length} payees detected${isMultiPayee ? " (multi-payee)" : ""}`, { payees }, user.id);

    // Run eligibility check
    const eligibility = evaluateEligibility(payees, check);
    await supabase.from("check_eligibility_results").insert({
      check_id: checkId,
      recommendation: eligibility.recommendation,
      reasons: eligibility.reasons,
      rule_results: eligibility.rules,
      evaluated_by: user.id,
    });
    await supabase.from("check_intake_items").update({
      deposit_recommendation: eligibility.recommendation,
      deposit_recommendation_reasons: eligibility.reasons,
    }).eq("id", checkId);
    await logAudit(supabase, checkId, "eligibility_evaluated", `Recommendation: ${eligibility.recommendation}`, eligibility, user.id);

    return new Response(JSON.stringify({ success: true, parsed, payees, eligibility }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-ocr-intake error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function evaluateEligibility(payees: any[], check: any) {
  const rules: Record<string, any> = {};
  const reasons: string[] = [];

  // Rule 1: Number of payees
  rules.payee_count = payees.length;
  if (payees.length > 2) {
    reasons.push("More than 2 payees detected — branch deposit likely required");
  }

  // Rule 2: Mortgage involvement
  const hasMortgage = payees.some((p: any) => p.type === "mortgage_company");
  rules.mortgage_involved = hasMortgage;
  if (hasMortgage) {
    reasons.push("Mortgage company listed as payee — may require separate endorsement process");
  }

  // Rule 3: All endorsements pending
  rules.all_endorsements_pending = true;
  if (payees.length > 1) {
    reasons.push("Multi-payee check — all endorsements must be collected before deposit");
  }

  // Rule 4: Depositing entity check
  const hasPa = payees.some((p: any) => p.type === "public_adjuster");
  rules.depositing_entity_listed = hasPa;
  if (!hasPa && payees.length > 0) {
    reasons.push("Public adjuster not listed as payee — verify deposit authority");
  }

  // Determine recommendation
  let recommendation: string;
  if (payees.length === 0) {
    recommendation = "needs_review";
    reasons.push("No payees detected from OCR");
  } else if (payees.length > 2 || (hasMortgage && payees.length > 1)) {
    recommendation = "branch_deposit_recommended";
  } else if (payees.length > 1) {
    recommendation = "endorsements_pending";
  } else {
    recommendation = "ready_for_deposit";
  }

  return { recommendation, reasons, rules };
}

async function logAudit(supabase: any, checkId: string, eventType: string, description: string, data: any, actorId: string) {
  await supabase.from("check_audit_log").insert({
    check_id: checkId,
    event_type: eventType,
    event_description: description,
    event_data: data,
    actor_id: actorId,
  });
}
