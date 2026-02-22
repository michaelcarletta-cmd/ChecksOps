import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    const systemPrompt = `You are drafting a brief, professional claim update email for the policyholder. Use ONLY the claim context below. Write in plain language; no internal jargon (no "RCV", "supplement", "carrier dismantler", etc.). Be reassuring and clear.

CLAIM CONTEXT:
- Claim Number: ${claim.claim_number || "N/A"}
- Client Name: ${claim.policyholder_name || "Policyholder"}
- Insurance: ${claim.insurance_company || "N/A"}
- Current Status: ${claim.status || "N/A"}
- Loss Type: ${claim.loss_type || "N/A"}
- Loss Date: ${claim.loss_date || "N/A"}

RECENT ACTIVITY (most recent first):
${updatesText || "No recent activity logged."}

GUIDELINES:
1. Summarize where things stand and what has been done recently.
2. Mention next steps we are taking (e.g. following up with carrier, gathering documents).
3. Keep it to 2–4 short sentences; under 100 words.
4. Sign off as "Freedom Claims Team" or similar.
5. Do NOT include a subject line — output only the email body.`;

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Generate the client update email body." },
        ],
        temperature: 0.6,
      }),
    });

    const aiData = await aiResponse.json();
    if (!aiResponse.ok || aiData.error) {
      console.error("draft-client-update OpenAI error:", aiData);
      return new Response(
        JSON.stringify({ error: aiData.error?.message || "Failed to generate draft" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailBody = (aiData.choices?.[0]?.message?.content ?? "").trim();
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
