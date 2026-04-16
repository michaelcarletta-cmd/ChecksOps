/**
 * Cross-Document Contradiction Engine — compares across engineer
 * reports, adjuster emails, denial letters, estimates, and prior
 * communications to detect contradictions, shifting positions,
 * and admissions against interest.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "./generate.ts";
import { withClaimCache } from "./intelligenceCache.ts";

export interface ContradictionDetection {
  contradictionType: string;
  documentAName: string;
  documentBName: string;
  positionA: string;
  positionB: string;
  severity: "low" | "medium" | "high";
  rebuttalValue: string;
}

export async function detectContradictions(
  supabase: SupabaseClient,
  claimId: string,
): Promise<ContradictionDetection[]> {
  try {
    // Gather carrier-facing documents
    const [argumentsRes, rebuttalsRes, filesRes] = await Promise.all([
      supabase.from("claim_argument_map")
        .select("argument_text, argument_type, carrier_position_summary, source_file_name, source_file_id")
        .eq("claim_id", claimId)
        .limit(20),
      supabase.from("carrier_argument_rebuttals")
        .select("carrier_position, argument_type, source_file_name, source_file_id")
        .eq("claim_id", claimId)
        .limit(20),
      supabase.from("claim_files")
        .select("id, file_name, ai_summary, classification")
        .eq("claim_id", claimId)
        .in("classification", ["denial", "estimate_carrier", "engineer_report", "adjuster_email", "carrier_letter"])
        .limit(10),
    ]);

    const arguments_ = argumentsRes.data || [];
    const rebuttals = rebuttalsRes.data || [];
    const files = filesRes.data || [];

    // Collect all carrier positions
    const positions: Array<{ source: string; position: string; type: string }> = [];

    for (const arg of arguments_) {
      if (arg.carrier_position_summary) {
        positions.push({
          source: arg.source_file_name || "Unknown document",
          position: arg.carrier_position_summary.slice(0, 300),
          type: arg.argument_type,
        });
      }
    }

    for (const reb of rebuttals) {
      positions.push({
        source: reb.source_file_name || "Unknown document",
        position: reb.carrier_position.slice(0, 300),
        type: reb.argument_type,
      });
    }

    for (const f of files) {
      if (f.ai_summary) {
        positions.push({
          source: f.file_name,
          position: (typeof f.ai_summary === "string" ? f.ai_summary : JSON.stringify(f.ai_summary)).slice(0, 300),
          type: f.classification || "document",
        });
      }
    }

    if (positions.length < 2) return [];

    // Use AI to detect contradictions
    const positionsText = positions.map((p, i) =>
      `[${i + 1}] Source: ${p.source} | Type: ${p.type}\nPosition: ${p.position}`
    ).join("\n\n");

    const result = await generate({
      task: "analysis",
      system: `You are an insurance claims analyst detecting contradictions across carrier documents. Return only valid JSON array.`,
      user: `Analyze these carrier positions from the SAME claim for contradictions, shifting positions, and admissions against interest.

POSITIONS:
${positionsText}

Find:
1. Direct contradictions (carrier says X in one doc, Y in another)
2. Shifting positions (carrier changes stance over time)
3. Admissions against interest (carrier concedes something helpful)

Return JSON array (empty if none found):
[{
  "contradiction_type": "contradiction" | "shifting_position" | "admission_against_interest",
  "doc_a_index": number,
  "doc_b_index": number,
  "position_a": "what doc A says",
  "position_b": "what doc B says",
  "severity": "low" | "medium" | "high",
  "rebuttal_value": "how to use this in arguments"
}]`,
      temperature: 0.1,
      maxTokens: 1500,
      searchMode: "off",
    });

    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const contradictions: ContradictionDetection[] = parsed.slice(0, 5).map((c: any) => ({
      contradictionType: c.contradiction_type || "contradiction",
      documentAName: positions[c.doc_a_index - 1]?.source || "Unknown",
      documentBName: positions[c.doc_b_index - 1]?.source || "Unknown",
      positionA: c.position_a || "",
      positionB: c.position_b || "",
      severity: c.severity || "medium",
      rebuttalValue: c.rebuttal_value || "",
    }));

    // Store contradictions
    if (contradictions.length > 0) {
      const rows = contradictions.map((c) => ({
        claim_id: claimId,
        contradiction_type: c.contradictionType,
        document_a_name: c.documentAName,
        document_b_name: c.documentBName,
        carrier_position_a: c.positionA,
        carrier_position_b: c.positionB,
        severity: c.severity,
        rebuttal_value: c.rebuttalValue,
      }));
      await supabase.from("claim_contradiction_detections").insert(rows).throwOnError().catch(() => {});
    }

    return contradictions;
  } catch (e) {
    console.error("[ContradictionEngine] Error:", e);
    return [];
  }
}

export function formatContradictions(contradictions: ContradictionDetection[]): string {
  if (!contradictions.length) return "";
  const lines = contradictions.map((c) => {
    const label = c.contradictionType === "admission_against_interest" ? "ADMISSION"
      : c.contradictionType === "shifting_position" ? "SHIFTING POSITION"
      : "CONTRADICTION";
    return `[${label} - ${c.severity.toUpperCase()}]\n  ${c.documentAName}: "${c.positionA}"\n  ${c.documentBName}: "${c.positionB}"\n  → Rebuttal value: ${c.rebuttalValue}`;
  });
  return `=== CROSS-DOCUMENT CONTRADICTIONS ===\n${lines.join("\n\n")}\n=== END CONTRADICTIONS ===`;
}
