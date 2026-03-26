import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { runDarwinTask } from "../_shared/ai-router.ts";

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
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const { claimId } = body as { claimId?: string };
    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "claimId required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("id, claim_number, policyholder_name, status, insurance_company, loss_type, loss_date, policyholder_email")
      .eq("id", claimId)
      .single();

    if (claimErr || !claim) {
      return new Response(
        JSON.stringify({ error: "Claim not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: updates } = await supabase
      .from("claim_updates")
      .select("content, update_type, created_at")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(10);

    const updatesText = (updates ?? [])
      .map((u: any) => `[${u.update_type}] ${new Date(u.created_at).toLocaleDateString()}: ${(u.content || "").slice(0, 200)}`)
      .join("\n");

    const system = `You draft client updates for a public adjusting firm.
Write clearly, professionally, and in plain English.
Be reassuring without overpromising.
Do not use legalese unless necessary.

EXTERNAL CONTENT WRITING RULES:
1. AUTHORSHIP: Never refer to Darwin, AI, or any automated system. Write as if authored by the claims team.
2. PLAIN TEXT: Use clean professional prose with paragraph formatting. No bullet points, emoji, markdown, or special symbols.
3. TONE: Warm, professional, reassuring language for policyholder communication.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || "N/A"}
- Client Name: ${claim.policyholder_name || "Policyholder"}
- Insurance: ${claim.insurance_company || "N/A"}
- Current Status: ${claim.status || "N/A"}
- Loss Type: ${claim.loss_type || "N/A"}
- Loss Date: ${claim.loss_date || "N/A"}

RECENT ACTIVITY (most recent first):
${updatesText || "No recent activity logged."}`;

    const user = `Generate the client update email body.

Requirements:
- Keep it concise (2-4 short sentences, under 100 words)
- Summarize where things stand and what has been done recently
- Mention next steps we are taking
- End with a warm closing such as "Regards," or "Sincerely,"
- Do NOT include any team name or signature line
- Do NOT include a subject line — output only the email body
- No markdown`;

    const result = await runDarwinTask("client_update", system, user);

    const emailBody = (result.text || "").trim();
    if (!emailBody) {
      return new Response(
        JSON.stringify({ error: "Empty draft returned" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ body: emailBody }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("draft-client-update error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
