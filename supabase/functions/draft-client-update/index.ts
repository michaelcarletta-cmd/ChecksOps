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
        .select("subject, body, recipient_type, recipient_name, sent_at")
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
        .select("event_type, occurred_at, summary, actor")
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

    // ── 2. Build structured context ──────────────────────────────────────
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

    const firstName = (claim.policyholder_name || "").split(/\s+/)[0] || "there";

    // ── 3. Single-pass: extract facts + draft in one call ────────────────
    const system = `You are Darwin Copilot for a public adjusting firm.
Your job is to draft client update emails based only on actual claim activity, notes, documents, and recent events.
You must first identify the most important update-worthy facts and ignore internal noise.

Rules:
- Only include facts supported by claim notes, claim activity, or documents.
- Prefer the most recent relevant developments.
- Do not invent progress.
- Do not mention internal strategy, litigation posture, or internal disagreements unless explicitly requested.
- Write clearly in plain English for a client.
- Be reassuring but do not overpromise.
- Focus on:
  1. what happened recently
  2. current status
  3. what we are doing next
  4. what the client should expect
If recent notes are vague, say that the claim remains under review and state the next confirmed action.

EXTERNAL CONTENT WRITING RULES:
1. AUTHORSHIP: Never refer to Darwin, AI, or any automated system. Write as if authored by the claims team.
2. PLAIN TEXT: Use clean professional prose with paragraph formatting. No bullet points, emoji, markdown, or special symbols.
3. TONE: Warm, professional, reassuring language for policyholder communication.
4. ADDRESS: Address the client as "${firstName}".`.trim();

    const user = `Draft a client claim update email using the information below.

CLAIM SUMMARY
${JSON.stringify(claimSummary, null, 2)}

RECENT NOTES
${JSON.stringify(recentNotes, null, 2)}

RECENT ACTIVITY (communications diary and events)
${JSON.stringify(recentActivity, null, 2)}

RECENT EMAILS
${JSON.stringify(recentEmails, null, 2)}

RECENT DOCUMENTS
${JSON.stringify(recentDocuments, null, 2)}

IMPORTANT:
Before drafting, determine:
- the most important recent developments
- the current claim status
- the next confirmed step
- any pending items
- any facts that should not be included because they are internal-only or unclear

Then draft the email.

Output requirements:
- return only the email body
- no markdown
- sound human and professional
- 2 to 5 short paragraphs
- include only concrete updates supported by the data
- if there is little meaningful movement, say so professionally and explain what is pending
- end with a warm closing such as "Regards," or "Sincerely,"
- do NOT include any team name or signature line after the closing
- do NOT include a subject line — output only the email body`.trim();

    const config = getModelForTask("client_update");
    const result = await callOpenAIText({
      system,
      user,
      model: config.model,
      reasoningEffort: "medium",
      temperature: 0.4,
      maxOutputTokens: 1500,
    });

    const emailBody = (result.text || "").trim();
    if (!emailBody) {
      return new Response(JSON.stringify({ error: "Empty draft returned" }), { status: 502, headers: jsonHeaders });
    }

    return new Response(
      JSON.stringify({ body: emailBody }),
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
