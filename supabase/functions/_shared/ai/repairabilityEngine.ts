/**
 * Repairability Decision Engine — determines whether damage is
 * repairable or not repairable based on material, age, damage type,
 * availability, code requirements, manufacturer specs, and claim facts.
 *
 * Integrates with Authority Knowledge Layer for backing evidence.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "./generate.ts";
import { retrieveAuthorityKnowledge, formatAuthorityKnowledge, type AuthorityEntry } from "./authorityKnowledge.ts";
import { withClaimCache } from "./intelligenceCache.ts";

export interface RepairabilityDecision {
  repairability: "repairable" | "not_repairable";
  reasoning: string[];
  requiredScope: string[];
  authoritySupport: string[];
}

/**
 * Version-aware cache wrapper. Reuses prior decision per
 * (claim, material, trade, damageType) until claim version bumps
 * (new file/dismantler/argument/declared-position).
 */
export async function determineRepairability(
  supabase: SupabaseClient,
  opts: {
    claimId: string;
    material: string | null;
    trade: string | null;
    damageType: string;
    state: string;
    claimFactsSummary: string;
    dismantlerFindings?: string;
  },
): Promise<RepairabilityDecision | null> {
  const subkey = `${opts.material || "_"}|${opts.trade || "_"}|${opts.damageType || "_"}`;
  return withClaimCache<RepairabilityDecision | null>(
    supabase,
    opts.claimId,
    "repairability",
    subkey,
    () => determineRepairabilityUncached(supabase, opts),
  );
}

async function determineRepairabilityUncached(
  supabase: SupabaseClient,
  opts: {
    claimId: string;
    material: string | null;
    trade: string | null;
    damageType: string;
    state: string;
    claimFactsSummary: string;
    dismantlerFindings?: string;
  },
): Promise<RepairabilityDecision | null> {
  try {
    // Get authority knowledge for repairability
    const authorities = await retrieveAuthorityKnowledge(supabase, {
      disputeType: "repairability",
      state: opts.state,
      trade: opts.trade,
      material: opts.material,
      userQuery: `repairability ${opts.material || ""} ${opts.damageType || ""}`,
    });

    const authorityContext = formatAuthorityKnowledge(authorities);

    const prompt = `You are a construction and insurance claims expert. Determine if the described damage is REPAIRABLE or NOT REPAIRABLE.

STRICT RULES:
- Base your decision ONLY on the facts provided
- Reference authority sources when available
- Do NOT guess or assume facts not in evidence
- Consider manufacturer specifications, building codes, material availability, and industry standards

CLAIM FACTS:
${opts.claimFactsSummary}

Material: ${opts.material || "Unknown"}
Trade: ${opts.trade || "Unknown"}
Damage Type: ${opts.damageType || "Unknown"}
State: ${opts.state || "Unknown"}

${opts.dismantlerFindings ? `DISMANTLER FINDINGS:\n${opts.dismantlerFindings}` : ""}

${authorityContext}

Return ONLY valid JSON:
{
  "repairability": "repairable" | "not_repairable",
  "reasoning": ["reason1", "reason2"],
  "required_scope": ["scope item 1", "scope item 2"],
  "authority_support": ["citation or reference 1"]
}`;

    const result = await generate({
      task: "analysis",
      system: "You are a construction damage repairability expert. Return only valid JSON.",
      user: prompt,
      temperature: 0.1,
      maxTokens: 1000,
      searchMode: "off",
    });

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      repairability: parsed.repairability === "not_repairable" ? "not_repairable" : "repairable",
      reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning : [],
      requiredScope: Array.isArray(parsed.required_scope) ? parsed.required_scope : [],
      authoritySupport: Array.isArray(parsed.authority_support) ? parsed.authority_support : [],
    };
  } catch (e) {
    console.error("[RepairabilityEngine] Error:", e);
    return null;
  }
}

export function formatRepairabilityDecision(decision: RepairabilityDecision | null): string {
  if (!decision) return "";
  const status = decision.repairability === "not_repairable" ? "NOT REPAIRABLE" : "REPAIRABLE";
  const parts = [
    `Determination: ${status}`,
    `Reasoning: ${decision.reasoning.join("; ")}`,
  ];
  if (decision.requiredScope.length) {
    parts.push(`Required Scope: ${decision.requiredScope.join("; ")}`);
  }
  if (decision.authoritySupport.length) {
    parts.push(`Authority Support: ${decision.authoritySupport.join("; ")}`);
  }
  return `=== REPAIRABILITY DECISION ===\n${parts.join("\n")}\n=== END REPAIRABILITY DECISION ===`;
}
