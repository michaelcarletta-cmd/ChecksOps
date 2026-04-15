/**
 * Carrier Behavior Intelligence — retrieves carrier-specific patterns,
 * denial reasons, adjuster behavior, and success strategies from
 * carrier_behavior_analytics and claim_outcome_learning.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";

export interface CarrierPattern {
  commonDenialReasons: string[];
  recurringArguments: string[];
  typicalAdjusterBehavior: string;
  highestSuccessStrategies: string[];
  keyTurningPoints: string[];
}

export async function retrieveCarrierBehavior(
  supabase: SupabaseClient,
  carrier: string,
  lossType: string,
  state: string,
): Promise<CarrierPattern | null> {
  if (!carrier || carrier === "Unknown") return null;

  try {
    const carrierToken = carrier.split(" ")[0];

    const [analyticsRes, outcomesRes] = await Promise.all([
      supabase.from("carrier_behavior_analytics")
        .select("most_common_denial_reasons, initial_denial_rate, avg_first_offer_vs_final, reversal_rate_after_supplement, reversal_rate_after_engineer")
        .ilike("carrier_name", `%${carrierToken}%`)
        .limit(1),
      supabase.from("claim_outcome_learning")
        .select("outcome, winning_arguments, key_turning_point, strategy_sequence, denial_rationale")
        .ilike("carrier", `%${carrierToken}%`)
        .limit(15),
    ]);

    const analytics = analyticsRes.data?.[0];
    const outcomes = outcomesRes.data || [];

    if (!analytics && !outcomes.length) return null;

    // Extract denial reasons
    const denialReasons: string[] = [];
    if (analytics?.most_common_denial_reasons) {
      const reasons = analytics.most_common_denial_reasons;
      if (Array.isArray(reasons)) denialReasons.push(...reasons.map(String).slice(0, 5));
      else if (typeof reasons === "object") denialReasons.push(...Object.values(reasons).map(String).slice(0, 5));
    }
    // Also from outcomes
    for (const o of outcomes) {
      if (o.denial_rationale && !denialReasons.includes(String(o.denial_rationale))) {
        denialReasons.push(String(o.denial_rationale).slice(0, 100));
      }
    }

    // Extract winning arguments as recurring argument patterns
    const argSet = new Set<string>();
    for (const o of outcomes) {
      const args = o.winning_arguments;
      if (Array.isArray(args)) args.forEach((a: any) => argSet.add(String(a).slice(0, 100)));
    }

    // Strategies
    const stratSet = new Set<string>();
    for (const o of outcomes) {
      const seq = o.strategy_sequence;
      if (Array.isArray(seq)) stratSet.add(seq.join(" → "));
      else if (typeof seq === "string") stratSet.add(seq);
    }

    // Turning points
    const turningPoints: string[] = [];
    for (const o of outcomes) {
      if (o.key_turning_point) turningPoints.push(String(o.key_turning_point).slice(0, 100));
    }

    // Adjuster behavior summary
    const denialRate = analytics?.initial_denial_rate;
    const offerRatio = analytics?.avg_first_offer_vs_final;
    const behaviorParts: string[] = [];
    if (denialRate != null) behaviorParts.push(`Initial denial rate: ${(denialRate * 100).toFixed(0)}%`);
    if (offerRatio != null) behaviorParts.push(`First offer vs final ratio: ${(offerRatio * 100).toFixed(0)}%`);
    if (analytics?.reversal_rate_after_supplement != null) {
      behaviorParts.push(`Supplement reversal rate: ${(analytics.reversal_rate_after_supplement * 100).toFixed(0)}%`);
    }

    return {
      commonDenialReasons: denialReasons.slice(0, 5),
      recurringArguments: [...argSet].slice(0, 5),
      typicalAdjusterBehavior: behaviorParts.join(". ") || "No adjuster behavior data",
      highestSuccessStrategies: [...stratSet].slice(0, 3),
      keyTurningPoints: turningPoints.slice(0, 3),
    };
  } catch (e) {
    console.error("[CarrierBehaviorIntel] Error:", e);
    return null;
  }
}

export function formatCarrierBehavior(pattern: CarrierPattern | null): string {
  if (!pattern) return "";
  const parts: string[] = [];
  if (pattern.commonDenialReasons.length) {
    parts.push(`Common Denial Reasons: ${pattern.commonDenialReasons.join("; ")}`);
  }
  if (pattern.typicalAdjusterBehavior) {
    parts.push(`Adjuster Behavior: ${pattern.typicalAdjusterBehavior}`);
  }
  if (pattern.highestSuccessStrategies.length) {
    parts.push(`Highest Success Strategies: ${pattern.highestSuccessStrategies.join("; ")}`);
  }
  if (pattern.keyTurningPoints.length) {
    parts.push(`Key Turning Points: ${pattern.keyTurningPoints.join("; ")}`);
  }
  return `=== CARRIER BEHAVIOR INTELLIGENCE ===\n${parts.join("\n")}\n=== END CARRIER BEHAVIOR INTELLIGENCE ===`;
}
