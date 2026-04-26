/**
 * Authority Knowledge Layer — retrieves authority-grade knowledge
 * (building codes, manufacturer specs, statutes, case law) and
 * ranks them above internal knowledge.
 *
 * Source types: building_code, manufacturer_spec, statute, case_law
 * Labels: [CODE], [MANUFACTURER], [LAW], [CASE]
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export interface AuthorityEntry {
  title: string;
  content: string;
  sourceType: string;
  authorityLevel: number;
  jurisdiction: string;
  trade: string | null;
  material: string | null;
  applicabilityTags: string[];
  label: string;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  building_code: "CODE",
  manufacturer_spec: "MANUFACTURER",
  statute: "LAW",
  case_law: "CASE",
  regulation: "CODE",
  standard: "CODE",
};

const AUTHORITY_SOURCE_TYPES = ["building_code", "manufacturer_spec", "statute", "case_law"];

const AUTHORITY_TRIGGER_DISPUTES = new Set([
  "code", "causation", "repairability", "policy_interpretation",
]);

const AUTHORITY_TRIGGER_TERMS = [
  "building code", "manufacturer", "regulation", "statute", "ordinance",
  "irc", "ibc", "nfpa", "standard", "requirement", "specification",
  "case law", "precedent", "ruling",
];

export function shouldInjectAuthority(disputeType: string, userQuery: string): boolean {
  if (AUTHORITY_TRIGGER_DISPUTES.has(disputeType)) return true;
  const lower = userQuery.toLowerCase();
  return AUTHORITY_TRIGGER_TERMS.some((t) => lower.includes(t));
}

export async function retrieveAuthorityKnowledge(
  supabase: SupabaseClient,
  opts: {
    disputeType: string;
    state: string;
    trade: string | null;
    material: string | null;
    userQuery: string;
  },
): Promise<AuthorityEntry[]> {
  if (!shouldInjectAuthority(opts.disputeType, opts.userQuery)) return [];

  try {
    let query = supabase
      .from("claim_knowledge_library")
      .select("title, content, source_type, authority_level, jurisdiction, trade, material, applicability_tags, dispute_type, state")
      .in("source_type", AUTHORITY_SOURCE_TYPES)
      .order("authority_level", { ascending: true })
      .limit(10);

    if (opts.disputeType && opts.disputeType !== "general") {
      query = query.or(`dispute_type.eq.${opts.disputeType},dispute_type.is.null`);
    }
    if (opts.state) {
      query = query.or(`state.eq.${opts.state},state.is.null,jurisdiction.eq.national`);
    }

    const { data, error } = await query;
    if (error || !data?.length) return [];

    return data
      .map((entry: any) => {
        let relevance = entry.authority_level || 1;
        if (opts.trade && entry.trade && entry.trade.toLowerCase() === opts.trade.toLowerCase()) relevance += 2;
        if (opts.material && entry.material && entry.material.toLowerCase() === opts.material.toLowerCase()) relevance += 2;
        // Check applicability tags
        const tags: string[] = entry.applicability_tags || [];
        if (tags.includes(opts.disputeType)) relevance += 1;
        return {
          title: entry.title,
          content: (entry.content || "").slice(0, 600),
          sourceType: entry.source_type,
          authorityLevel: entry.authority_level || 1,
          jurisdiction: entry.jurisdiction || "national",
          trade: entry.trade,
          material: entry.material,
          applicabilityTags: tags,
          label: SOURCE_TYPE_LABELS[entry.source_type] || "AUTHORITY",
          _relevance: relevance,
        };
      })
      .sort((a: any, b: any) => a._relevance - b._relevance) // lower authority_level = higher authority
      .slice(0, 5)
      .map(({ _relevance, ...entry }: any) => entry as AuthorityEntry);
  } catch (e) {
    console.error("[AuthorityKnowledge] Retrieval error:", e);
    return [];
  }
}

export function formatAuthorityKnowledge(entries: AuthorityEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e) =>
    `[${e.label}] ${e.title} (${e.jurisdiction})\n${e.content}`
  );
  return `=== AUTHORITY KNOWLEDGE ===\n${lines.join("\n\n")}\n=== END AUTHORITY KNOWLEDGE ===`;
}
