import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Trigger keywords that indicate escalation needs
const CONTRACTOR_TRIGGERS = [
  "repair attempt", "repairability", "repair required", "repairs needed",
  "contractor estimate", "scope of work", "construction", "remediation",
  "mitigation required", "emergency repair",
];

const PA_TRIGGERS = [
  "underpaid", "lowball", "significantly undervalued", "scope dispute",
  "denial reversed", "supplement denied repeatedly", "bad faith",
  "unreasonable delay", "unfair settlement", "coverage dispute",
  "appraisal demand", "umpire", "complex claim", "total loss dispute",
];

const ATTORNEY_TRIGGERS = [
  "bad faith", "litigation", "lawsuit", "statutory violation",
  "fraud", "dobi complaint", "regulatory complaint", "breach of contract",
  "unreasonable denial", "continued denial after", "attorney demand",
  "statute of limitations", "examination under oath", "euo",
];

function detectEscalationNeeds(claimMap: any, claimStatus: string | null, subStatus: string | null): {
  needsContractor: boolean;
  needsPA: boolean;
  needsAttorney: boolean;
  reasons: Record<string, string>;
} {
  const allText = [
    claimMap?.issue_summary || "",
    ...(claimMap?.escalation_flags || []),
    ...(claimMap?.pressure_points || []),
    claimMap?.recommended_next_step || "",
    claimStatus || "",
    subStatus || "",
  ].join(" ").toLowerCase();

  const reasons: Record<string, string> = {};

  const needsContractor = CONTRACTOR_TRIGGERS.some(t => {
    if (allText.includes(t)) {
      reasons.contractor = `The insurance company may require a repair attempt or contractor estimate. Getting a qualified contractor involved now can strengthen your claim position.`;
      return true;
    }
    return false;
  });

  const needsPA = PA_TRIGGERS.some(t => {
    if (allText.includes(t)) {
      reasons.pa = `Your claim shows signs of being significantly undervalued or disputed. A licensed Public Adjuster can advocate on your behalf to maximize your settlement.`;
      return true;
    }
    return false;
  });

  const needsAttorney = ATTORNEY_TRIGGERS.some(t => {
    if (allText.includes(t)) {
      reasons.attorney = `Your claim may involve potential legal issues that require professional legal counsel. An attorney specializing in insurance claims can protect your rights.`;
      return true;
    }
    return false;
  });

  return { needsContractor, needsPA, needsAttorney, reasons };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const { action, claimId } = await req.json();

    if (action === "check_escalation") {
      // Fetch claim data
      const [claimRes, mapRes, existingAlertsRes, contractorsRes] = await Promise.all([
        supabase.from("claims").select("status, sub_status, property_address, insurance_company, is_guided_mode").eq("id", claimId).single(),
        supabase.from("guided_claim_map").select("*").eq("claim_id", claimId).single(),
        supabase.from("referral_alerts").select("alert_type").eq("claim_id", claimId).eq("is_dismissed", false),
        supabase.from("claim_contractors").select("id").eq("claim_id", claimId).limit(1),
      ]);

      if (!claimRes.data?.is_guided_mode) {
        return new Response(JSON.stringify({ alerts: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const hasContractor = (contractorsRes.data || []).length > 0;
      const existingTypes = new Set((existingAlertsRes.data || []).map((a: any) => a.alert_type));
      const { needsContractor, needsPA, needsAttorney, reasons } = detectEscalationNeeds(
        mapRes.data,
        claimRes.data?.status,
        claimRes.data?.sub_status
      );

      const newAlerts: any[] = [];

      if (needsContractor && !hasContractor && !existingTypes.has("needs_contractor")) {
        newAlerts.push({
          claim_id: claimId,
          alert_type: "needs_contractor",
          trigger_reason: "Repair attempt or contractor estimate detected as needed",
          message: reasons.contractor,
          notification_method: "both",
        });
      }

      if (needsPA && !existingTypes.has("needs_public_adjuster")) {
        newAlerts.push({
          claim_id: claimId,
          alert_type: "needs_public_adjuster",
          trigger_reason: "Claim disputes suggest professional advocacy needed",
          message: reasons.pa,
          notification_method: "both",
        });
      }

      if (needsAttorney && !existingTypes.has("needs_attorney")) {
        newAlerts.push({
          claim_id: claimId,
          alert_type: "needs_attorney",
          trigger_reason: "Potential legal issues detected in claim",
          message: reasons.attorney,
          notification_method: "both",
        });
      }

      if (newAlerts.length > 0) {
        await supabase.from("referral_alerts").insert(newAlerts);
      }

      return new Response(JSON.stringify({ alerts: newAlerts, detected: { needsContractor, needsPA, needsAttorney } }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "search_local_professionals") {
      const { professionalType, state, query: searchQuery } = await req.json();

      // Use Lovable AI to search for local professionals
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) {
        return new Response(JSON.stringify({ error: "AI key not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const typeLabel = professionalType === "contractor" ? "licensed contractors" :
        professionalType === "public_adjuster" ? "licensed public adjusters" : "insurance claim attorneys";

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            {
              role: "system",
              content: `You are a professional directory assistant. Return a JSON array of reputable ${typeLabel} in ${state || "the area"}. Each entry should have: name, company, phone, website, specialties (array), rating (1-5), description. Return 5-10 results. Only return the JSON array, no other text.`,
            },
            {
              role: "user",
              content: `Find reputable ${typeLabel} in ${state || "the area"}${searchQuery ? ` specializing in ${searchQuery}` : ""}`,
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "return_professionals",
                description: "Return a list of found professionals",
                parameters: {
                  type: "object",
                  properties: {
                    professionals: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          company: { type: "string" },
                          phone: { type: "string" },
                          website: { type: "string" },
                          specialties: { type: "array", items: { type: "string" } },
                          rating: { type: "number" },
                          description: { type: "string" },
                        },
                        required: ["name", "company", "specialties", "description"],
                      },
                    },
                  },
                  required: ["professionals"],
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "return_professionals" } },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("AI search failed:", response.status, errText);
        return new Response(JSON.stringify({ professionals: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const aiData = await response.json();
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      let professionals: any[] = [];

      if (toolCall?.function?.arguments) {
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          professionals = parsed.professionals || [];
        } catch { /* ignore parse errors */ }
      }

      // Store discovered professionals in the database
      for (const pro of professionals) {
        await supabase.from("referral_professionals").upsert(
          {
            professional_type: professionalType,
            name: pro.name,
            company: pro.company || null,
            phone: pro.phone || null,
            website: pro.website || null,
            specialties: pro.specialties || [],
            states_served: state ? [state] : [],
            description: pro.description || null,
            rating: pro.rating || 0,
            is_auto_discovered: true,
            discovery_source: "ai_search",
            is_active: true,
          },
          { onConflict: "id" }
        );
      }

      return new Response(JSON.stringify({ professionals, stored: professionals.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("referral-engine error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
