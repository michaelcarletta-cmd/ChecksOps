import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const { claimId, artifactType, firedRuleIds } = await req.json();
    if (!claimId || !artifactType) {
      return new Response(JSON.stringify({ success: false, error: "claimId and artifactType required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cap fired rules
    const ruleIds = (firedRuleIds || []).slice(0, 5);

    // 1) Load claim metadata
    const { data: claim, error: claimErr } = await adminClient
      .from("claims")
      .select("*, claim_adjusters(*)")
      .eq("id", claimId)
      .single();

    if (claimErr || !claim) {
      return new Response(JSON.stringify({ success: false, error: "Claim not found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Detect state
    const stateCode = detectState(claim);
    if (!stateCode) {
      return new Response(JSON.stringify({ success: false, error: "Cannot detect PA/NJ state for this claim" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2) Load fired escalation rules
    let firedRules: any[] = [];
    if (ruleIds.length > 0) {
      const { data } = await adminClient
        .from("escalation_trigger_rules")
        .select("regulation_citation, regulation_summary, recommended_action, escalation_strength")
        .in("id", ruleIds);
      firedRules = data || [];
    }

    // Determine escalation strength from rules
    const strengthOrder = ["regulatory_leverage", "formal_leverage", "soft_leverage"];
    const maxStrength = firedRules.reduce((best: string, r: any) => {
      const rIdx = strengthOrder.indexOf(r.escalation_strength);
      const bIdx = strengthOrder.indexOf(best);
      return rIdx < bIdx ? r.escalation_strength : best;
    }, "soft_leverage");

    // 3) Load templates for this state + artifact type
    const { data: templates } = await adminClient
      .from("escalation_artifact_templates")
      .select("insert_block_type, template_body")
      .eq("state_code", stateCode)
      .eq("artifact_type", artifactType)
      .eq("is_active", true)
      .order("insert_block_type");

    if (!templates || templates.length === 0) {
      return new Response(JSON.stringify({ success: false, error: `No templates found for ${stateCode}/${artifactType}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4) Build claim variables
    const adjuster = claim.claim_adjusters?.[0];
    const daysSinceFiled = Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24));
    
    const vars: Record<string, string> = {
      claim_number: claim.claim_number || "N/A",
      policy_number: claim.policy_number || "N/A",
      insured_name: claim.policyholder_name || "N/A",
      property_address: claim.policyholder_address || "N/A",
      loss_date: claim.loss_date || "N/A",
      carrier: claim.insurance_company || "N/A",
      adjuster_name: adjuster?.adjuster_name || "Claims Department",
      days_since_filed: String(daysSinceFiled),
      company_name: "Freedom Adjustment",
      engineer_report_ref: "[Attached Engineering Report]",
      scope_items: "[See attached scope documentation with photographs]",
    };

    // 5) Assemble draft from template blocks
    let draft = "";
    // Order: opening → type-specific blocks → closing
    const openingBlock = templates.find(t => t.insert_block_type === "opening");
    const closingBlock = templates.find(t => t.insert_block_type === "closing");
    const middleBlocks = templates.filter(t => t.insert_block_type !== "opening" && t.insert_block_type !== "closing");

    if (openingBlock) draft += openingBlock.template_body + "\n\n";
    for (const block of middleBlocks) {
      draft += block.template_body + "\n\n";
    }

    // Insert regulatory references from fired rules (max 2)
    const citations = firedRules.slice(0, 2);
    if (citations.length > 0) {
      draft += "### Regulatory Standards\n\n";
      for (const rule of citations) {
        draft += `**${rule.regulation_citation}**: ${rule.regulation_summary}\n\n`;
      }
    }

    if (closingBlock) draft += closingBlock.template_body;

    // 6) Replace variables
    for (const [key, value] of Object.entries(vars)) {
      draft = draft.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // 7) Tone guardrail check
    const toneViolations = checkToneGuardrails(draft);
    if (toneViolations.length > 0) {
      console.warn("Tone violations detected in draft:", toneViolations);
      // Auto-sanitize
      for (const v of toneViolations) {
        draft = draft.replace(new RegExp(v, "gi"), "[language removed for tone compliance]");
      }
    }

    // 8) Save to claim_files (as markdown document)
    const fileName = `${artifactType.replace(/_/g, "-")}-${new Date().toISOString().slice(0, 10)}.md`;
    const filePath = `${claimId}/escalation-artifacts/${fileName}`;
    const fileContent = new TextEncoder().encode(draft);

    const { error: uploadError } = await adminClient.storage
      .from("claim-files")
      .upload(filePath, fileContent, { contentType: "text/markdown", upsert: true });

    let documentId: string | null = null;

    // Find the "Carrier Documents" or "Freedom Adjustment Documents" folder
    const folderName = artifactType === "supplement" ? "Freedom Adjustment Documents" : "Carrier Documents";
    const { data: folders } = await adminClient
      .from("claim_folders")
      .select("id")
      .eq("claim_id", claimId)
      .eq("name", folderName)
      .limit(1);

    const folderId = folders?.[0]?.id || null;

    if (!uploadError) {
      const { data: fileRecord } = await adminClient
        .from("claim_files")
        .insert({
          claim_id: claimId,
          file_name: fileName,
          file_path: filePath,
          file_type: "text/markdown",
          folder_id: folderId,
          uploaded_by: user.id,
        })
        .select("id")
        .single();
      documentId = fileRecord?.id || null;
    }

    // 9) Log escalation action
    const { data: action, error: actionErr } = await adminClient
      .from("escalation_actions")
      .insert({
        claim_id: claimId,
        state_code: stateCode,
        fired_rule_ids: ruleIds,
        escalation_strength: maxStrength,
        artifact_type: artifactType,
        artifact_document_id: documentId,
        draft_content: draft,
        status: "drafted",
        created_by: user.id,
      })
      .select("id")
      .single();

    if (actionErr) {
      console.error("Failed to log escalation action:", actionErr);
    }

    return new Response(JSON.stringify({
      success: true,
      actionId: action?.id,
      documentId,
      draftContent: draft,
      artifactType,
      stateCode,
      escalationStrength: maxStrength,
      firedRuleCount: firedRules.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("draft-escalation-artifact error:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ success: false, error: errMsg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// --- Helpers ---

const STATE_PATTERNS = [
  { code: "NJ", regex: /(^|[\s,])NJ([\s,]|$)/i },
  { code: "NJ", regex: /\bNEW\s+JERSEY\b/i },
  { code: "PA", regex: /(^|[\s,])PA([\s,]|$)/i },
  { code: "PA", regex: /\bPENNSYLVANIA\b/i },
];
const ZIP_STATE_REGEX = /\b([A-Z]{2})\s+\d{5}\b/;

function detectState(claim: any): string | null {
  const structured = (claim?.client_state || claim?.property_state || "").toUpperCase().trim();
  if (structured === "PA" || structured === "PENNSYLVANIA") return "PA";
  if (structured === "NJ" || structured === "NEW JERSEY") return "NJ";

  const address = claim?.policyholder_address || "";
  if (!address) return null;

  const zipMatch = address.toUpperCase().match(ZIP_STATE_REGEX);
  if (zipMatch) {
    if (zipMatch[1] === "PA") return "PA";
    if (zipMatch[1] === "NJ") return "NJ";
  }

  for (const { code, regex } of STATE_PATTERNS) {
    if (regex.test(address)) return code;
  }
  return null;
}

function checkToneGuardrails(text: string): string[] {
  const violations: string[] = [];
  const banned = [
    /\bbad\s+faith\b/gi,
    /\bviolation\b/gi,
    /\bfailure\s+to\s+comply\b/gi,
    /\bthreat(en|s|ened)?\b/gi,
    /\blitigation\b/gi,
    /\bDOI\s+complaint\b/gi,
    /\blawsuit\b/gi,
  ];
  for (const pattern of banned) {
    const match = text.match(pattern);
    if (match) violations.push(match[0]);
  }
  return violations;
}
