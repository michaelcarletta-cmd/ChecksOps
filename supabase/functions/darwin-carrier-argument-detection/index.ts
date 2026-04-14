import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generate } from "../_shared/ai/generate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ARGUMENT_TYPES = [
  "warranty_language_misuse",
  "granule_loss_cosmetic",
  "wear_and_tear",
  "no_direct_physical_loss",
  "maintenance",
] as const;

type ArgumentType = typeof ARGUMENT_TYPES[number];

const FORBIDDEN_INSURANCE_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\brotted\s+decking\b/gi, "compromised decking"],
  [/\brotten\s+decking\b/gi, "compromised decking"],
  [/\brotted\s+(?:wood|sheathing|substrate)\b/gi, "damaged sheathing"],
  [/\brotten\s+(?:wood|sheathing|substrate)\b/gi, "damaged sheathing"],
  [/\bwood\s+rot\b/gi, "storm-damaged substrate"],
  [/\bdry\s+rot\b/gi, "storm-damaged substrate"],
  [/\bwet\s+rot\b/gi, "storm-damaged substrate"],
  [/\bdecay(?:ed|ing)?\b/gi, "deterioration"],
  [/\brot(?:ted|ting|ten)?\b/gi, "compromised"],
];

function sanitizeForbiddenInsuranceTerms(value: string | null | undefined): string | null {
  if (typeof value !== "string") return value ?? null;
  let sanitized = value;
  for (const [pattern, replacement] of FORBIDDEN_INSURANCE_TERM_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function sanitizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === "string" ? sanitizeForbiddenInsuranceTerms(value) : null))
    .filter((value): value is string => Boolean(value && value.trim()));
}

function sanitizeCitationArray(values: unknown): any[] {
  if (!Array.isArray(values)) return [];
  return values.map((citation: any) => ({
    ...citation,
    file_name:
      typeof citation?.file_name === "string"
        ? sanitizeForbiddenInsuranceTerms(citation.file_name)
        : citation?.file_name,
    snippet:
      typeof citation?.snippet === "string"
        ? sanitizeForbiddenInsuranceTerms(citation.snippet)
        : citation?.snippet,
  }));
}

// Keyword detection patterns for each argument type
const DETECTION_PATTERNS: Record<ArgumentType, RegExp[]> = {
  warranty_language_misuse: [
    /manufacturer['']?s?\s+warranty/i,
    /warranty\s+(claim|limitation|exclusion|does not cover)/i,
    /warranty\s+language/i,
    /TAMKO|GAF|Owens\s+Corning|CertainTeed|Atlas|IKO/i,
    /product\s+warranty/i,
    /defect\s+(remedy|warranty)/i,
  ],
  granule_loss_cosmetic: [
    /granule\s+(loss|displacement|erosion)/i,
    /cosmetic\s+(damage|only|in nature|appearance)/i,
    /aestheti(c|cal)\s+(damage|concern|issue)/i,
    /does\s+not\s+affect\s+(function|performance)/i,
    /granular\s+(surface|coating)/i,
    /surface\s+granule/i,
    /normal\s+granule/i,
  ],
  wear_and_tear: [
    /wear\s+and\s+tear/i,
    /normal\s+(wear|aging|deterioration)/i,
    /gradual\s+(deterioration|degradation|decline)/i,
    /age[\-\s]related/i,
    /natural\s+(aging|weathering)/i,
    /expected\s+service\s+life/i,
    /end\s+of\s+(useful\s+)?life/i,
    /pre[\-\s]?existing\s+(condition|damage|wear)/i,
  ],
  no_direct_physical_loss: [
    /no\s+direct\s+physical\s+loss/i,
    /no\s+(covered|physical)\s+(loss|damage)/i,
    /does\s+not\s+constitute\s+(direct\s+)?physical/i,
    /no\s+evidence\s+of\s+(physical|direct|covered)\s+(loss|damage)/i,
    /fail(s|ed)?\s+to\s+demonstrate\s+(direct\s+)?physical/i,
    /absence\s+of\s+(direct\s+)?physical/i,
  ],
  maintenance: [
    /maintenance\s+(issue|deficiency|neglect|related)/i,
    /lack\s+of\s+maintenance/i,
    /deferred\s+maintenance/i,
    /improper\s+(maintenance|installation|repair)/i,
    /homeowner['']?s?\s+maintenance/i,
    /failure\s+to\s+maintain/i,
    /pre[\-\s]?existing\s+condition/i,
    /prior\s+(damage|condition)/i,
  ],
};

function detectArgumentTypes(text: string): Array<{ type: ArgumentType; snippets: string[] }> {
  const detected: Array<{ type: ArgumentType; snippets: string[] }> = [];

  for (const argType of ARGUMENT_TYPES) {
    const patterns = DETECTION_PATTERNS[argType];
    const snippets: string[] = [];

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags + "g");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        // Extract surrounding context (±80 chars)
        const start = Math.max(0, match.index - 80);
        const end = Math.min(text.length, match.index + match[0].length + 80);
        const snippet = text.substring(start, end).replace(/\n/g, " ").trim();
        if (!snippets.some(s => s.includes(match![0]))) {
          snippets.push(snippet);
        }
        if (snippets.length >= 3) break;
      }
      if (snippets.length >= 3) break;
    }

    if (snippets.length > 0) {
      detected.push({ type: argType, snippets });
    }
  }

  return detected;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { claimId, fileId, fileName, extractedText } = await req.json();

    if (!claimId || !extractedText) {
      return new Response(
        JSON.stringify({ success: false, error: "claimId and extractedText required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Step 1: Regex-based argument detection
    const detected = detectArgumentTypes(extractedText);

    if (detected.length === 0) {
      console.log(`[CarrierArgDetect] No carrier arguments detected in file ${fileName || fileId}`);
      return new Response(
        JSON.stringify({ success: true, detected: 0, message: "No carrier arguments detected" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[CarrierArgDetect] Detected ${detected.length} argument types: ${detected.map(d => d.type).join(", ")}`);

    // Step 2: Fetch playbook cards for detected types
    const { data: playbookCards } = await supabase
      .from("rebuttal_playbook_cards")
      .select("*")
      .in("argument_type", detected.map(d => d.type));

    const playbookMap = new Map((playbookCards || []).map(c => [c.argument_type, c]));

    // Step 3: For each detected argument, generate a claim-specific rebuttal via AI
    const truncatedText = extractedText.substring(0, 15000);

    // Fetch claim context
    const { data: claim } = await supabase
      .from("claims")
      .select("claim_number, insurance_company, loss_type, loss_date, policyholder_address")
      .eq("id", claimId)
      .single();

    const results: any[] = [];

    for (const detection of detected) {
      const playbook = playbookMap.get(detection.type);

      const systemPrompt = `You are a senior insurance claims strategist. You are analyzing a carrier's denial/position document to generate a structured rebuttal for a public adjuster.

ARGUMENT TYPE DETECTED: ${detection.type.replace(/_/g, " ")}

REBUTTAL FRAMEWORK (from playbook):
- Principle: ${playbook?.principle || "Carrier argument misapplies standards"}
- Why Different: ${playbook?.why_different || "Insurance coverage standards differ from the carrier's cited basis"}
- What Proves Damage: ${playbook?.what_proves_damage || "Physical evidence of covered peril damage"}

EXTERNAL CONTENT RULE FOR carrier_ready_paragraph: Write the carrier_ready_paragraph as clean professional prose — no bullet points, emoji, markdown, or special symbols. Never refer to Darwin or AI. Write as if authored by the public adjuster.

FORBIDDEN TERMINOLOGY — ROT / DECAY: NEVER use "rot", "rotted", "rotting", "rotten", "decay", "decayed", or "decaying" in any output. These terms are never covered by insurance. Use "compromised decking", "damaged sheathing", or "storm-damaged substrate" instead.

You MUST return ONLY valid JSON. No markdown, no code blocks.`;

      const userPrompt = `Analyze this document text and generate a claim-specific rebuttal for the "${detection.type.replace(/_/g, " ")}" carrier argument.

CLAIM CONTEXT:
- Claim #: ${claim?.claim_number || "Unknown"}
- Carrier: ${claim?.insurance_company || "Unknown"}
- Loss Type: ${claim?.loss_type || "Unknown"}
- Loss Date: ${claim?.loss_date || "Unknown"}
- Address: ${claim?.policyholder_address || "Unknown"}

DETECTED ARGUMENT SNIPPETS FROM DOCUMENT:
${detection.snippets.map((s, i) => `${i + 1}. "${s}"`).join("\n")}

FULL DOCUMENT TEXT (truncated):
${truncatedText}

Return JSON:
{
  "carrier_position": "What the carrier is arguing (1-2 sentences from document)",
  "warranty_scope": "If warranty mentioned, what does the warranty actually cover vs what carrier claims (or null)",
  "damage_mechanism": "What physical damage mechanism is present based on document evidence",
  "loss_trigger": "What triggered the loss (direct physical loss description)",
  "exclusion_invoked": "What policy exclusion the carrier invoked",
  "storm_date": "Storm/loss date if mentioned (or null)",
  "collateral_hits": "Any collateral damage mentioned (soft metals, vents, etc.) or null",
  "pattern_notes": "Damage pattern notes from document or null",
  "expert_support": "Any expert/engineer findings mentioned or null",
  "principle": "The core rebuttal principle for THIS specific case",
  "why_different": "Why the carrier's argument fails for THIS case specifically",
  "what_proves_damage": "What specific evidence in this file proves functional damage",
  "documentation_checklist": ["Item 1 to document next", "Item 2", "..."],
  "carrier_ready_paragraph": "A formal, professional paragraph starting with 'We are not making a...' or similar rebuttal opening, specific to this claim. 3-5 sentences.",
  "citations": [
    {"file_name": "${fileName || "uploaded document"}", "snippet": "exact quote from text supporting this rebuttal point", "needs_review": false},
    {"file_name": "${fileName || "uploaded document"}", "snippet": "another quote", "needs_review": false}
  ],
  "confidence": 0.85
}

CRITICAL: Every assertion MUST have a citation from the document text. If you cannot find a direct quote, set needs_review: true on that citation.`;

      try {
        const aiResult = await generate({
          task: 'extraction',
          system: systemPrompt,
          user: userPrompt,
          claimId,
          searchMode: 'off',
          temperature: 0.2,
          maxTokens: 3000,
          jsonMode: true,
        });

        console.log(`[CarrierArgDetect] model=${aiResult.model}, cached=${aiResult.cached}, type=${detection.type}`);

        let content = aiResult.text;

        // Strip markdown code blocks
        content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

        let parsed: any;
        try {
          parsed = JSON.parse(content);
        } catch {
          console.error(`[CarrierArgDetect] Failed to parse AI JSON for ${detection.type}`);
          continue;
        }

        const sanitizedCitations = sanitizeCitationArray(parsed.citations);
        const sanitizedChecklist = sanitizeStringArray(parsed.documentation_checklist);
        const fallbackChecklist = sanitizeStringArray(playbook?.documentation_checklist);
        const hasNeedsReview = sanitizedCitations.some((c: any) => c.needs_review);

        // Upsert into carrier_argument_rebuttals
        const { data: inserted, error: insertError } = await supabase
          .from("carrier_argument_rebuttals")
          .upsert(
            {
              claim_id: claimId,
              argument_type: detection.type,
              carrier_position:
                sanitizeForbiddenInsuranceTerms(parsed.carrier_position || detection.snippets[0]) ||
                "Carrier position requires review",
              warranty_scope: sanitizeForbiddenInsuranceTerms(parsed.warranty_scope) || null,
              damage_mechanism: sanitizeForbiddenInsuranceTerms(parsed.damage_mechanism) || null,
              loss_trigger: sanitizeForbiddenInsuranceTerms(parsed.loss_trigger) || null,
              exclusion_invoked: sanitizeForbiddenInsuranceTerms(parsed.exclusion_invoked) || null,
              storm_date: sanitizeForbiddenInsuranceTerms(parsed.storm_date) || null,
              collateral_hits: sanitizeForbiddenInsuranceTerms(parsed.collateral_hits) || null,
              pattern_notes: sanitizeForbiddenInsuranceTerms(parsed.pattern_notes) || null,
              expert_support: sanitizeForbiddenInsuranceTerms(parsed.expert_support) || null,
              principle:
                sanitizeForbiddenInsuranceTerms(parsed.principle || playbook?.principle) ||
                "Carrier argument misapplies standards",
              why_different:
                sanitizeForbiddenInsuranceTerms(parsed.why_different || playbook?.why_different) ||
                "Insurance coverage standards differ from the carrier's cited basis",
              what_proves_damage:
                sanitizeForbiddenInsuranceTerms(parsed.what_proves_damage || playbook?.what_proves_damage) ||
                "Physical evidence of covered peril damage",
              documentation_checklist:
                sanitizedChecklist.length > 0 ? sanitizedChecklist : fallbackChecklist,
              carrier_ready_paragraph:
                sanitizeForbiddenInsuranceTerms(
                  parsed.carrier_ready_paragraph || playbook?.carrier_ready_template
                ) || "",
              citations: sanitizedCitations,
              source_file_id: fileId || null,
              source_file_name: fileName || null,
              confidence: parsed.confidence || 0.5,
              needs_review: hasNeedsReview,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "claim_id,argument_type", ignoreDuplicates: false }
          )
          .select()
          .single();

        if (insertError) {
          // If upsert fails due to no unique constraint, try insert
          console.log(`[CarrierArgDetect] Upsert failed, trying insert: ${insertError.message}`);
          await supabase.from("carrier_argument_rebuttals").insert({
            claim_id: claimId,
            argument_type: detection.type,
              carrier_position:
                sanitizeForbiddenInsuranceTerms(parsed.carrier_position || detection.snippets[0]) ||
                "Carrier position requires review",
              warranty_scope: sanitizeForbiddenInsuranceTerms(parsed.warranty_scope) || null,
              damage_mechanism: sanitizeForbiddenInsuranceTerms(parsed.damage_mechanism) || null,
              loss_trigger: sanitizeForbiddenInsuranceTerms(parsed.loss_trigger) || null,
              exclusion_invoked: sanitizeForbiddenInsuranceTerms(parsed.exclusion_invoked) || null,
              storm_date: sanitizeForbiddenInsuranceTerms(parsed.storm_date) || null,
              collateral_hits: sanitizeForbiddenInsuranceTerms(parsed.collateral_hits) || null,
              pattern_notes: sanitizeForbiddenInsuranceTerms(parsed.pattern_notes) || null,
              expert_support: sanitizeForbiddenInsuranceTerms(parsed.expert_support) || null,
              principle:
                sanitizeForbiddenInsuranceTerms(parsed.principle || playbook?.principle) ||
                "Carrier argument misapplies standards",
              why_different:
                sanitizeForbiddenInsuranceTerms(parsed.why_different || playbook?.why_different) ||
                "Insurance coverage standards differ from the carrier's cited basis",
              what_proves_damage:
                sanitizeForbiddenInsuranceTerms(parsed.what_proves_damage || playbook?.what_proves_damage) ||
                "Physical evidence of covered peril damage",
              documentation_checklist:
                sanitizedChecklist.length > 0 ? sanitizedChecklist : fallbackChecklist,
              carrier_ready_paragraph:
                sanitizeForbiddenInsuranceTerms(
                  parsed.carrier_ready_paragraph || playbook?.carrier_ready_template
                ) || "",
              citations: sanitizedCitations,
            source_file_id: fileId || null,
            source_file_name: fileName || null,
            confidence: parsed.confidence || 0.5,
            needs_review: hasNeedsReview,
          });
        }

        // Update playbook usage count
        if (playbook) {
          await supabase
            .from("rebuttal_playbook_cards")
            .update({ usage_count: (playbook.usage_count || 0) + 1, last_used_at: new Date().toISOString() })
            .eq("id", playbook.id);
        }

        results.push({ type: detection.type, confidence: parsed.confidence, needs_review: hasNeedsReview });
        console.log(`[CarrierArgDetect] Generated rebuttal for ${detection.type} (confidence: ${parsed.confidence})`);
      } catch (err) {
        console.error(`[CarrierArgDetect] Error processing ${detection.type}:`, err);
      }
    }

    // Log to darwin action log
    await supabase.from("darwin_action_log").insert({
      claim_id: claimId,
      action_type: "carrier_argument_detection",
      action_details: {
        file_id: fileId,
        file_name: fileName,
        detected_types: results.map(r => r.type),
        total_detected: results.length,
      },
      was_auto_executed: true,
      result: `Detected ${results.length} carrier argument(s): ${results.map(r => r.type).join(", ")}`,
      trigger_source: "darwin_carrier_argument_detection",
    });

    return new Response(
      JSON.stringify({ success: true, detected: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[CarrierArgDetect] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
