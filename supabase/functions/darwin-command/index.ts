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

    // ── Financial QA ──
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

    // ── Create Task (web UI callers) ──
    if (intent === "create_task") {
      if (!claimId) {
        return new Response(
          JSON.stringify({ intent, error: "This command requires a claim context. Open a claim and try again." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // Parse title from text (strip prefixes)
      let title = text
        .replace(/^(task[:\s]+|create\s+task[:\s]*|add\s+task[:\s]*|remind\s+me\s+(to\s+)?)/i, '')
        .trim();
      if (!title) title = "Untitled task";

      // Simple due date: default tomorrow
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 1);

      const { data: task, error: taskErr } = await supabase.from("tasks").insert({
        claim_id: claimId,
        title,
        due_date: dueDate.toISOString().split('T')[0],
        status: "pending",
        created_by: createdBy || null,
      }).select("id, title, due_date").single();

      if (taskErr) {
        return new Response(
          JSON.stringify({ intent, error: taskErr.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          intent,
          result: `Task created: "${task.title}" due ${task.due_date}`,
          taskId: task.id,
          message: "Task created successfully.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Send Client Email (web UI callers) ──
    if (intent === "send_client_email" || intent === "send_client_sms") {
      if (!claimId) {
        return new Response(
          JSON.stringify({ intent, error: "This command requires a claim context. Open a claim and try again." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ intent, message: "Client messaging via the command bar is coming soon. Use SMS commands for now." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (intent === "unknown" || !claimId) {
      if (intent === "unknown") {
        return new Response(
          JSON.stringify({
            intent: "unknown",
            message: "I didn't recognize that command. Try: \"Run an analysis on this claim\", \"Task: call adjuster tomorrow\", \"Text client: we're scheduled Tuesday\", \"Email client: update on your claim\", or ask a financial question like \"What's been paid?\"",
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

    // --- Robust extraction: try many common response shapes ---
    const extractContent = (json: any): string => {
      const paths = [
        json?.result,
        json?.analysis,
        json?.output,
        json?.data?.result,
        json?.data?.analysis,
        json?.content,
        json?.text,
      ];
      for (const val of paths) {
        if (val == null) continue;
        const s = typeof val === "string" ? val : JSON.stringify(val, null, 2);
        if (s.trim()) return s;
      }
      // Last resort: if json itself has meaningful keys beyond meta, stringify it
      const keys = Object.keys(json || {}).filter(k => !["success", "analysisType", "claimId", "suggestedActions", "carrierDismantler", "claimFactsPack", "error"].includes(k));
      if (keys.length > 0) {
        const subset: Record<string, any> = {};
        for (const k of keys) subset[k] = json[k];
        const s = JSON.stringify(subset, null, 2);
        if (s.length > 10) return s;
      }
      return "";
    };

    console.log("darwin-command analysisJson keys:", Object.keys(analysisJson), "result length:", String(analysisJson.result ?? "").length, "analysis length:", String(analysisJson.analysis ?? "").length);

    let contentToStore = extractContent(analysisJson);
    let redacted = false;
    let redactionNotes = "";

    if (intent === "case_study" || intent === "marketing") {
      const redactedContent = redactForPublic(contentToStore);
      const report = redactionReport(contentToStore, redactedContent);
      redacted = report.redacted;
      redactionNotes = report.notes;
      contentToStore = redactedContent;
    }

    // Guard: do not insert empty rows
    if (!contentToStore.trim()) {
      console.error("darwin-command: extracted content is empty, skipping generated_assets insert. analysisJson keys:", Object.keys(analysisJson));
      return new Response(
        JSON.stringify({
          intent,
          error: "Analysis completed but returned empty content. Please try again or check that the claim has sufficient data.",
          analysisKeys: Object.keys(analysisJson),
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
