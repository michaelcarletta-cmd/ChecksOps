import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { parseIntent, type DarwinIntent } from "../_shared/darwin-command-contracts.ts";
import { redactForPublic, redactionReport } from "../_shared/darwin-redact.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const { commandText, claimId, route, createdBy } = body as { commandText?: string; claimId?: string; route?: string; createdBy?: string };
    const text = (commandText ?? "").trim();
    if (!text) {
      return new Response(
        JSON.stringify({ error: "commandText required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const intent = parseIntent(text);

    if (intent === "financial_qa") {
      const finResp = await fetch(`${supabaseUrl}/functions/v1/darwin-financials`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "answerFinancialQuestion",
          claimId: claimId || null,
          questionText: text,
        }),
      });
      const finData = await finResp.json().catch(() => ({}));
      if (!finResp.ok) {
        return new Response(
          JSON.stringify({ intent: "financial_qa", error: finData.error || "Financial service error" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          intent: "financial_qa",
          answer: finData.answer,
          dataComplete: finData.dataComplete,
          source: finData.source,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (intent === "unknown" || !claimId) {
      if (intent === "unknown") {
        return new Response(
          JSON.stringify({
            intent: "unknown",
            message: "I didn’t recognize that command. Try: “Run an analysis on this claim”, “Turn this into an operating manual”, “Write a case study, remove identifying details”, “Turn the case study into a blog and social posts”, or ask a financial question like “What’s been paid and what hasn’t?”",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          intent,
          error: "This command requires a claim context. Open a claim and try again.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const analysisTypeMap: Record<string, string> = {
      analyze: "claim_analysis",
      operating_manual: "operating_manual",
      case_study: "case_study",
      marketing: "marketing_assets",
    };
    const analysisType = analysisTypeMap[intent];
    if (!analysisType) {
      return new Response(
        JSON.stringify({ intent, message: "This action is not yet implemented." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const analysisResp = await fetch(`${supabaseUrl}/functions/v1/darwin-ai-analysis`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseServiceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        claimId,
        analysisType,
        additionalContext: { trigger: "darwin_command", commandText: text },
      }),
    });

    const analysisJson = await analysisResp.json().catch(() => ({}));
    const rawResult = analysisJson.result ?? analysisJson.analysis ?? "";

    let contentToStore = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult, null, 2);
    let redacted = false;
    let redactionNotes = "";

    if (intent === "case_study" || intent === "marketing") {
      const redactedContent = redactForPublic(contentToStore);
      const report = redactionReport(contentToStore, redactedContent);
      redacted = report.redacted;
      redactionNotes = report.notes;
      contentToStore = redactedContent;
    }

    const userId = createdBy ?? null;

    const titleMap: Record<string, string> = {
      claim_analysis: "Claim Analysis",
      operating_manual: "Operating Manual",
      case_study: "Case Study (Redacted)",
      marketing_assets: "Marketing Assets",
    };
    const { data: inserted, error: insertErr } = await supabase
      .from("generated_assets")
      .insert({
        claim_id: claimId,
        asset_type: analysisType,
        title: titleMap[analysisType] ?? analysisType,
        content_md: contentToStore,
        redacted: redacted,
        created_by: userId || null,
        metadata_json: { redaction_notes: redactionNotes, command_text: text },
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("generated_assets insert error:", insertErr);
    }

    return new Response(
      JSON.stringify({
        intent,
        result: contentToStore.slice(0, 5000),
        assetId: inserted?.id ?? null,
        redacted,
        message: "Saved to knowledge base.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("darwin-command error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
