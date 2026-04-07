import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { callOpenAIText, getModelForTask } from "../_shared/ai-router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function isGenericClientUpdateDraft(text: string, context: {
  claimNumber?: string;
  carrier?: string;
  recentDocuments?: Array<{ name?: string; type?: string; subtype?: string }>;
  recentActivity?: Array<{ summary?: string; type?: string; date?: string }>;
}) {
  const lower = (text || "").toLowerCase();
  const genericPhrases = [
    "we wanted to update you",
    "latest communication regarding your claim",
    "we will continue to advocate on your behalf",
    "we will let you know of any new developments",
    "please call us if you have any questions",
  ];
  const genericHits = genericPhrases.filter((p) => lower.includes(p)).length;

  const hasClaimNumber =
    !!context.claimNumber && text.includes(context.claimNumber);
  const hasCarrier =
    !!context.carrier && lower.includes(String(context.carrier).toLowerCase());
  const hasActivityKeyword = (context.recentActivity || []).some((a) => {
    const s = `${a.type || ""} ${a.summary || ""}`.toLowerCase();
    return s && (
      lower.includes((a.type || "").toLowerCase()) ||
      (a.summary && lower.includes(a.summary.slice(0, 20).toLowerCase()))
    );
  });
  const hasDocumentKeyword = (context.recentDocuments || []).some((d) => {
    const s = `${d.name || ""} ${d.type || ""} ${d.subtype || ""}`.toLowerCase();
    return s && (
      (d.type && lower.includes(String(d.type).toLowerCase())) ||
      (d.subtype && lower.includes(String(d.subtype).toLowerCase()))
    );
  });

  const specificityScore =
    Number(hasClaimNumber) +
    Number(hasCarrier) +
    Number(hasActivityKeyword) +
    Number(hasDocumentKeyword);

  return genericHits >= 2 && specificityScore < 2;
}

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

    const latestMeaningfulActivity =
      recentActivity.find((a: any) => a.summary || a.promises || a.follow_up) || null;

    const recentEmails = (emailsRes.data ?? []).map((e: any) => ({
      date: e.sent_at,
      subject: e.subject,
      to: e.recipient_name || e.recipient_type,
      body_preview: (e.body || "").slice(0, 300),
    }));

    const recentDocuments = (filesRes.data ?? [])
      .filter((f: any) => {
        const text = `${f.file_name || ""} ${f.document_type || ""} ${f.document_subtype || ""} ${f.document_summary || ""}`.toLowerCase();
        return (
          text.includes("estimate") ||
          text.includes("payment") ||
          text.includes("check") ||
          text.includes("inspection") ||
          text.includes("report") ||
          text.includes("letter") ||
          text.includes("coverage") ||
          text.includes("denial") ||
          text.includes("proof") ||
          text.includes("rebuttal")
        );
      })
      .map((f: any) => ({
        name: f.file_name,
        type: f.document_type,
        subtype: f.document_subtype,
        summary: (f.document_summary || "").slice(0, 200),
        date: f.uploaded_at,
      }))
      .slice(0, 8);

    const firstName = (claim.policyholder_name || "").split(/\s+/)[0] || "there";

    // ── 3. Build fact hints ──────────────────────────────────────────────
    const factHints = {
      claim_number: claimSummary.claim_number,
      carrier: claimSummary.insurance_company,
      status: claimSummary.status,
      latest_activity_date: latestMeaningfulActivity?.date || null,
      latest_activity_type: latestMeaningfulActivity?.type || null,
      latest_activity_summary: latestMeaningfulActivity?.summary || null,
      recent_document_names: recentDocuments.slice(0, 3).map((d: any) => d.name),
      recent_email_subjects: recentEmails.slice(0, 3).map((e: any) => e.subject),
    };

    // ── 4. Build prompts ─────────────────────────────────────────────────
    const system = `You are Darwin Copilot for a public adjusting firm.
Your job is to draft a client claim update email based only on actual claim activity, notes, communications, emails, and documents.

CRITICAL RULES:
- Do not write a generic status update.
- The email must include at least 2 specific factual details from the provided data when such details exist.
- Specific factual details include:
  - carrier name
  - claim number
  - recent communication date
  - inspection status
  - payment/check status
  - recent document received
  - follow-up action taken
  - pending item
  - next confirmed step
- If specific facts exist and you fail to mention them, your answer is wrong.
- Do not invent facts.
- Do not mention internal strategy, internal disagreements, or unclear speculation.
- Write clearly in plain English for a client.
- Be reassuring but do not overpromise.
- If there has been little movement, say exactly what is still pending and what follow-up is being done.

EXTERNAL CONTENT WRITING RULES:
1. Never refer to Darwin, AI, or any automated system.
2. Use clean professional prose only.
3. No bullet points, markdown, emojis, or special formatting.
4. Address the client naturally as "${firstName}".`.trim();

    const user = `Draft a client claim update email using the information below.

FACT HINTS
${JSON.stringify(factHints, null, 2)}

CLAIM SUMMARY
${JSON.stringify(claimSummary, null, 2)}

LATEST MEANINGFUL ACTIVITY
${JSON.stringify(latestMeaningfulActivity, null, 2)}

RECENT NOTES
${JSON.stringify(recentNotes, null, 2)}

RECENT ACTIVITY
${JSON.stringify(recentActivity, null, 2)}

RECENT EMAILS
${JSON.stringify(recentEmails, null, 2)}

RECENT DOCUMENTS
${JSON.stringify(recentDocuments, null, 2)}

Before writing the email, identify for yourself:
1. the 2 to 4 most important concrete claim facts
2. the current status
3. the next confirmed step
4. what is still pending

Then draft the email using those concrete facts.

REQUIREMENTS:
- Output only the email body
- No subject line
- No markdown
- 2 to 5 short paragraphs
- Include at least 2 concrete claim-specific details if they exist in the data
- Prefer concrete facts over general reassurance
- If there is a recent communication, payment issue, check issue, document upload, inspection, or follow-up, mention it
- End with a warm closing only
- Do NOT include any team name or signature line after the closing`.trim();

    // ── 5. Call AI ───────────────────────────────────────────────────────
    const config = getModelForTask("client_update");
    const result = await callOpenAIText({
      system,
      user,
      model: config.model,
      reasoningEffort: "medium",
      temperature: 0.4,
      maxOutputTokens: 1200,
    });

    let emailBody = (result.text || "").trim();

    // ── 6. Quality gate: retry if too generic ────────────────────────────
    if (
      isGenericClientUpdateDraft(emailBody, {
        claimNumber: claimSummary.claim_number,
        carrier: claimSummary.insurance_company,
        recentDocuments,
        recentActivity,
      })
    ) {
      const retryUser = `${user}\n\nIMPORTANT: Your first draft was too generic.
Rewrite it and include actual claim-specific facts from the provided data.
You must mention at least 2 concrete details such as:
- carrier name
- specific recent communication
- check/payment issue
- document received
- follow-up action
- pending status
Do not write a vague update.`;

      const retry = await callOpenAIText({
        system,
        user: retryUser,
        model: config.model,
        reasoningEffort: "medium",
        temperature: 0.3,
        maxOutputTokens: 1200,
      });

      emailBody = (retry.text || "").trim();
    }

    if (!emailBody) {
      return new Response(JSON.stringify({ error: "Empty draft returned" }), { status: 502, headers: jsonHeaders });
    }

    return new Response(
      JSON.stringify({
        body: emailBody,
        debug: {
          recentNotesCount: recentNotes.length,
          recentActivityCount: recentActivity.length,
          recentEmailsCount: recentEmails.length,
          recentDocumentsCount: recentDocuments.length,
          latestMeaningfulActivity,
          factHints,
        },
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
