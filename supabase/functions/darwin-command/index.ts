import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { parseIntent } from "../_shared/darwin-command-contracts.ts";
import { redactForPublic, redactionReport } from "../_shared/darwin-redact.ts";

async function getClaimFinancialSummary(supabase: any, claimId: string): Promise<string> {
  try {
    const { data: settlement } = await supabase
      .from("claim_settlements")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: payments } = await supabase
      .from("claim_payments")
      .select("amount, payment_date, payment_method")
      .eq("claim_id", claimId);

    const { data: checks } = await supabase
      .from("claim_checks")
      .select("amount, check_type, check_date")
      .eq("claim_id", claimId);

    let totalPaid = 0;
    if (payments?.length) {
      totalPaid += payments.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
    }
    if (checks?.length) {
      totalPaid += checks.reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
    }

    const rcv = settlement?.replacement_cost_value != null ? Number(settlement.replacement_cost_value) : 0;
    const recDep = settlement?.recoverable_depreciation != null ? Number(settlement.recoverable_depreciation) : 0;
    const nonRecDep = settlement?.non_recoverable_depreciation != null ? Number(settlement.non_recoverable_depreciation) : 0;
    const deductible = settlement?.deductible != null ? Number(settlement.deductible) : 0;
    const totalOutstanding = Math.max(0, rcv - totalPaid);

    const lines: string[] = [];
    lines.push("Total paid: $" + totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    lines.push("Total outstanding: $" + totalOutstanding.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    if (recDep > 0 || nonRecDep > 0) {
      lines.push("Recoverable depreciation: $" + recDep.toLocaleString("en-US", { minimumFractionDigits: 2 }));
      lines.push("Non-recoverable depreciation: $" + nonRecDep.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    }
    if (deductible > 0) {
      lines.push("Deductible: $" + deductible.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    }
    if (settlement?.other_structures_rcv > 0 || settlement?.personal_property_rcv > 0 || settlement?.pwi_rcv > 0) {
      lines.push("");
      lines.push("By coverage (RCV):");
      if (rcv > 0) lines.push("  Dwelling: $" + rcv.toLocaleString("en-US", { minimumFractionDigits: 2 }));
      if (settlement?.other_structures_rcv > 0) lines.push("  Other structures: $" + Number(settlement.other_structures_rcv).toLocaleString("en-US", { minimumFractionDigits: 2 }));
      if (settlement?.personal_property_rcv > 0) lines.push("  Contents: $" + Number(settlement.personal_property_rcv).toLocaleString("en-US", { minimumFractionDigits: 2 }));
      if (settlement?.pwi_rcv > 0) lines.push("  PWI / Ordinance: $" + Number(settlement.pwi_rcv).toLocaleString("en-US", { minimumFractionDigits: 2 }));
    }
    return lines.join("\n");
  } catch (e) {
    console.error("getClaimFinancialSummary error:", e);
    return "Unable to load financial summary for this claim.";
  }
}

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
      if (!claimId) {
        return new Response(
          JSON.stringify({
            intent: "financial_qa",
            error: "This command requires a claim context. Open a claim and try again.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const answer = await getClaimFinancialSummary(supabase, claimId);
      return new Response(
        JSON.stringify({
          intent: "financial_qa",
          answer,
          dataComplete: true,
          source: "claim_settlements, claim_payments, claim_checks",
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

    // ── Send Client SMS ──
    if (intent === "send_client_sms") {
      if (!claimId) {
        return new Response(
          JSON.stringify({ intent, error: "This command requires a claim context. Open a claim and try again." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Extract message body
      const msgBody = text
        .replace(/^(text\s+(the\s+)?client[:\s]*|send\s+(a\s+)?(text|sms|message)\s+(to\s+)?(the\s+)?client[:\s]*|sms\s+(the\s+)?client[:\s]*)/i, '')
        .trim();
      if (!msgBody) {
        return new Response(
          JSON.stringify({ intent, error: "Please include a message after the command. Example: Text client: We're scheduled Tuesday" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Look up claim phone
      const { data: claim, error: claimErr } = await supabase
        .from("claims")
        .select("policyholder_phone, policyholder_name")
        .eq("id", claimId)
        .single();

      if (claimErr || !claim?.policyholder_phone) {
        return new Response(
          JSON.stringify({ intent, error: "No phone number found on this claim. Add a policyholder phone first." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Send SMS directly via Telnyx (service-to-service, no user auth needed)
      const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
      const TELNYX_PHONE_NUMBER = Deno.env.get("TELNYX_PHONE_NUMBER");
      const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

      if (!TELNYX_API_KEY || !TELNYX_PHONE_NUMBER) {
        return new Response(
          JSON.stringify({ intent, error: "SMS not configured. Missing Telnyx credentials." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Normalize phone to E.164
      const digits = claim.policyholder_phone.replace(/\D/g, "");
      const toE164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : `+${digits}`;

      const telnyxResp = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: TELNYX_PHONE_NUMBER,
          to: toE164,
          text: msgBody,
          messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
        }),
      });
      const telnyxData = await telnyxResp.json().catch(() => ({}));
      const smsData: Record<string, any> = {};

      if (!telnyxResp.ok) {
        smsData.error = telnyxData.errors?.[0]?.detail || "Telnyx API error";
      } else {
        smsData.messageId = telnyxData.data?.id;
        // Insert into sms_messages
        await supabase.from("sms_messages").insert({
          claim_id: claimId,
          from_number: TELNYX_PHONE_NUMBER,
          to_number: toE164,
          message_body: msgBody,
          status: telnyxData.data?.to?.[0]?.status || "queued",
          direction: "outbound",
          telnyx_message_id: smsData.messageId,
          user_id: createdBy || null,
        });
      }

      if (smsData.error) {
        return new Response(
          JSON.stringify({ intent, error: smsData.error || "Failed to send SMS" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Log to claim_updates
      await supabase.from("claim_updates").insert({
        claim_id: claimId,
        update_type: "communication_log",
        content: `SMS sent to ${claim.policyholder_name || claim.policyholder_phone}: ${msgBody}`,
        user_id: createdBy || null,
      });

      return new Response(
        JSON.stringify({
          intent,
          result: `SMS sent to ${claim.policyholder_name || claim.policyholder_phone}: "${msgBody}"`,
          messageId: smsData.messageId || null,
          message: "SMS sent successfully.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Send Client Email ──
    if (intent === "send_client_email") {
      if (!claimId) {
        return new Response(
          JSON.stringify({ intent, error: "This command requires a claim context. Open a claim and try again." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Strip command prefix and generic phrases so we get the real message or trigger draft
      const stripped = text
        .replace(/^(email\s+(the\s+)?client[:\s]*|send\s+(an?\s+)?email\s+(to\s+)?(the\s+)?client[:\s]*|draft\s+(an?\s+)?email\s+(to\s+)?(the\s+)?client[:\s]*)/i, '')
        .replace(/^(update\s+(the\s+)?client\s*(on\s+claim\s+)?(via\s+)?email[:\s]*|update\s+client\s+via\s+email[:\s]*|email\s+client\s+with\s+(an?\s+)?update[:\s]*|send\s+client\s+(an?\s+)?email\s+with\s+(an?\s+)?update[:\s]*)/i, '')
        .trim();
      const isGenericUpdate = !stripped || /^(update\s+(the\s+)?client|with\s+(an?\s+)?update|(with\s+)?(a\s+)?status\s+update|about\s+the\s+claim|on\s+claim\s+via\s+email|recent\s+status|claim\s+update)$/i.test(stripped);
      let emailBody: string;
      if (isGenericUpdate) {
        const draftResp = await fetch(`${supabaseUrl}/functions/v1/draft-client-update`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ claimId }),
        });
        const draftData = await draftResp.json().catch(() => ({}));
        if (!draftResp.ok || !draftData.body) {
          return new Response(
            JSON.stringify({ intent, error: draftData.error || "Could not generate update. Try: Email client: [your message]." }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        emailBody = draftData.body;
      } else {
        emailBody = stripped;
      }

      // Look up claim email
      const { data: claimData, error: claimEmailErr } = await supabase
        .from("claims")
        .select("policyholder_email, policyholder_name, claim_number")
        .eq("id", claimId)
        .single();

      if (claimEmailErr || !claimData?.policyholder_email) {
        return new Response(
          JSON.stringify({ intent, error: "No email address found on this claim. Add a policyholder email first." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Call send-email edge function
      const emailResp = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: claimData.policyholder_email,
          recipientName: claimData.policyholder_name || claimData.policyholder_email,
          subject: `Claim Update – ${claimData.claim_number || "Your Claim"}`,
          body: emailBody,
          claimId,
        }),
      });
      const emailData = await emailResp.json().catch(() => ({}));

      if (!emailResp.ok || emailData.error) {
        return new Response(
          JSON.stringify({ intent, error: emailData.error || "Failed to send email" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Log to claim_updates
      await supabase.from("claim_updates").insert({
        claim_id: claimId,
        update_type: "communication_log",
        content: `Email sent to ${claimData.policyholder_name || claimData.policyholder_email}: ${emailBody}`,
        user_id: createdBy || null,
      });

      return new Response(
        JSON.stringify({
          intent,
          result: `Email sent to ${claimData.policyholder_name || claimData.policyholder_email}: "${emailBody}"`,
          messageId: emailData.messageId || null,
          message: "Email sent successfully.",
        }),
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
