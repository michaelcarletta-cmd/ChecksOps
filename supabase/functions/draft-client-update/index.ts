import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { callOpenAIText, getModelForTask } from "../_shared/ai-router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const { claimId } = body as { claimId?: string };
    if (!claimId) {
      return new Response(JSON.stringify({ error: "claimId required" }), { status: 400, headers: jsonHeaders });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── 1. Gather all claim context in parallel ──────────────────────────
    const [claimRes, updatesRes, emailsRes, diaryRes, eventsRes, filesRes] = await Promise.all([
      supabase
        .from("claims")
        .select("id, claim_number, policyholder_name, status, insurance_company, loss_type, loss_date, policyholder_email, policyholder_address")
        .eq("id", claimId)
        .single(),
      supabase
        .from("claim_updates")
        .select("content, update_type, created_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(15),
      supabase
        .from("emails")
        .select("subject, body, recipient_type, recipient_name, sent_at, send_status")
        .eq("claim_id", claimId)
        .order("sent_at", { ascending: false })
        .limit(10),
      supabase
        .from("claim_communications_diary")
        .select("communication_date, communication_type, direction, contact_name, contact_company, summary, promises_made, follow_up_required, follow_up_date")
        .eq("claim_id", claimId)
        .order("communication_date", { ascending: false })
        .limit(10),
      supabase
        .from("claim_events")
        .select("event_type, occurred_at, summary, actor, doc_type")
        .eq("claim_id", claimId)
        .order("occurred_at", { ascending: false })
        .limit(15),
      supabase
        .from("claim_files")
        .select("file_name, document_type, document_subtype, document_summary, uploaded_at")
        .eq("claim_id", claimId)
        .order("uploaded_at", { ascending: false })
        .limit(10),
    ]);

    const claim = claimRes.data;
    if (claimRes.error || !claim) {
      return new Response(JSON.stringify({ error: "Claim not found" }), { status: 404, headers: jsonHeaders });
    }

    // ── 2. Build structured data payloads ────────────────────────────────
    const claimSummary = {
      claim_number: claim.claim_number || "N/A",
      policyholder_name: claim.policyholder_name || "Policyholder",
      insurance_company: claim.insurance_company || "N/A",
      status: claim.status || "N/A",
      loss_type: claim.loss_type || "N/A",
      loss_date: claim.loss_date || "N/A",
      property_address: claim.policyholder_address || "N/A",
    };

    const recentNotes = (updatesRes.data ?? []).map((u: any) => ({
      date: new Date(u.created_at).toLocaleDateString(),
      type: u.update_type,
      content: (u.content || "").slice(0, 300),
    }));

    const recentActivity = [
      ...(diaryRes.data ?? []).map((d: any) => ({
        date: d.communication_date,
        type: d.communication_type,
        direction: d.direction,
        contact: [d.contact_name, d.contact_company].filter(Boolean).join(" / "),
        summary: (d.summary || "").slice(0, 300),
        promises: d.promises_made || null,
        follow_up: d.follow_up_required ? d.follow_up_date : null,
      })),
      ...(eventsRes.data ?? []).map((e: any) => ({
        date: e.occurred_at,
        type: e.event_type,
        summary: (e.summary || "").slice(0, 200),
        actor: e.actor || null,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 15);

    const recentEmails = (emailsRes.data ?? []).map((e: any) => ({
      date: e.sent_at,
      subject: e.subject,
      to: e.recipient_name || e.recipient_type,
      body_preview: (e.body || "").slice(0, 300),
    }));

    const recentDocuments = (filesRes.data ?? []).map((f: any) => ({
      name: f.file_name,
      type: f.document_type,
      subtype: f.document_subtype,
      summary: (f.document_summary || "").slice(0, 200),
      date: f.uploaded_at,
    }));

    // ── 3. Phase 1: Extract structured facts ─────────────────────────────
    const extractionSystem = `You are extracting claim-update facts for a client email.
Return only structured JSON.
Only include information that is appropriate to communicate to the client.
Ignore duplicate notes, internal-only commentary, weak speculation, and irrelevant logs.
Prefer recent and meaningful events.`.trim();

    const extractionUser = `Review the claim information below and extract the best possible client update.

CLAIM SUMMARY
${JSON.stringify(claimSummary, null, 2)}

RECENT NOTES
${JSON.stringify(recentNotes, null, 2)}

RECENT ACTIVITY
${JSON.stringify(recentActivity, null, 2)}

RECENT EMAILS
${JSON.stringify(recentEmails, null, 2)}

RECENT DOCUMENTS
${JSON.stringify(recentDocuments, null, 2)}

Return:
- recent_developments
- current_status
- pending_items
- next_step
- client_action_needed
- do_not_mention
- confidence_note`.trim();

    const jsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        recent_developments: { type: "array", items: { type: "string" } },
        current_status: { type: "string" },
        pending_items: { type: "array", items: { type: "string" } },
        next_step: { type: "string" },
        client_action_needed: { type: "string" },
        do_not_mention: { type: "array", items: { type: "string" } },
        confidence_note: { type: "string" },
      },
      required: [
        "recent_developments", "current_status", "pending_items",
        "next_step", "client_action_needed", "do_not_mention", "confidence_note",
      ],
    };

    const extractConfig = getModelForTask("copilot_reasoning");
    const extractionResult = await callOpenAIText({
      system: extractionSystem,
      user: extractionUser,
      model: extractConfig.model,
      reasoningEffort: "high",
      temperature: 0.2,
      maxOutputTokens: 1500,
      jsonSchema,
    });

    let extractedUpdate: Record<string, unknown>;
    try {
      extractedUpdate = JSON.parse(extractionResult.text);
    } catch {
      console.error("Extraction JSON parse failed:", extractionResult.text?.slice(0, 500));
      // Fallback: pass raw data directly to drafting
      extractedUpdate = {
        recent_developments: recentNotes.slice(0, 3).map((n: any) => `[${n.date}] ${n.content}`),
        current_status: claimSummary.status,
        pending_items: [],
        next_step: "We will continue working on your claim and keep you updated.",
        client_action_needed: "No action needed at this time.",
        do_not_mention: [],
        confidence_note: "Limited data available.",
      };
    }

    // ── 4. Phase 2: Draft from extracted facts ───────────────────────────
    const firstName = (claim.policyholder_name || "").split(/\s+/)[0] || "there";

    const draftingSystem = `You draft professional client update emails for a public adjusting firm.
Use only the provided structured update facts.
Do not add facts.
Do not mention items listed under do_not_mention.
Keep the tone clear, calm, and confident.

EXTERNAL CONTENT WRITING RULES:
1. AUTHORSHIP: Never refer to Darwin, AI, or any automated system. Write as if authored by the claims team.
2. PLAIN TEXT: Use clean professional prose with paragraph formatting. No bullet points, emoji, markdown, or special symbols.
3. TONE: Warm, professional, reassuring language for policyholder communication.
4. ADDRESS: Address the client as "${firstName}".`.trim();

    const draftingUser = `Draft a client update email from this structured update data:

${JSON.stringify(extractedUpdate, null, 2)}

Requirements:
- return only the email body
- no markdown
- no bullet points
- professional but human
- 2 to 5 short paragraphs
- explain the current status and next step clearly
- include only concrete updates supported by the data
- if there is little meaningful movement, say so professionally and explain what is pending
- if no client action is needed, say we will continue to keep them updated
- end with a warm closing such as "Regards," or "Sincerely,"
- do NOT include any team name or signature line after the closing
- do NOT include a subject line`.trim();

    const draftConfig = getModelForTask("client_update");
    const draftResult = await callOpenAIText({
      system: draftingSystem,
      user: draftingUser,
      model: draftConfig.model,
      reasoningEffort: "medium",
      temperature: 0.4,
      maxOutputTokens: 1200,
    });

    const emailBody = (draftResult.text || "").trim();
    if (!emailBody) {
      return new Response(JSON.stringify({ error: "Empty draft returned" }), { status: 502, headers: jsonHeaders });
    }

    return new Response(
      JSON.stringify({
        body: emailBody,
        extractedFacts: extractedUpdate,
      }),
      { headers: jsonHeaders }
    );
  } catch (e) {
    console.error("draft-client-update error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders }
    );
  }
});
