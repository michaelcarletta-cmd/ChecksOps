/**
 * Timeline + Violation Engine — analyzes claim events to detect
 * carrier violations: delayed response, failure to investigate,
 * denial without inspection, payment delays, inconsistent actions.
 *
 * Uses state-specific thresholds where available.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";

export interface ViolationDetection {
  violationType: string;
  severity: "low" | "medium" | "high";
  description: string;
  recommendedAction: string;
  daysExceeded?: number;
  statuteReference?: string;
}

// State-specific response deadlines (business days)
const STATE_DEADLINES: Record<string, { acknowledge: number; investigate: number; pay: number }> = {
  NJ: { acknowledge: 10, investigate: 30, pay: 30 },
  PA: { acknowledge: 10, investigate: 30, pay: 30 },
  NY: { acknowledge: 15, investigate: 30, pay: 35 },
  FL: { acknowledge: 14, investigate: 90, pay: 90 },
  TX: { acknowledge: 15, investigate: 45, pay: 5 }, // 5 days after decision
  CA: { acknowledge: 15, investigate: 40, pay: 30 },
  IL: { acknowledge: 15, investigate: 45, pay: 30 },
  DEFAULT: { acknowledge: 15, investigate: 45, pay: 30 },
};

function getDeadlines(state: string) {
  return STATE_DEADLINES[state?.toUpperCase()] || STATE_DEADLINES.DEFAULT;
}

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24));
}

export async function detectViolations(
  supabase: SupabaseClient,
  claimId: string,
  state: string,
): Promise<ViolationDetection[]> {
  try {
    const [eventsRes, claimRes] = await Promise.all([
      supabase.from("claim_events")
        .select("event_type, summary, occurred_at, importance_score")
        .eq("claim_id", claimId)
        .order("occurred_at", { ascending: true }),
      supabase.from("claims")
        .select("date_of_loss, created_at, status, sub_status")
        .eq("id", claimId)
        .maybeSingle(),
    ]);

    const events = eventsRes.data || [];
    const claim = claimRes.data;
    if (!claim) return [];

    const deadlines = getDeadlines(state);
    const violations: ViolationDetection[] = [];
    const dateOfLoss = claim.date_of_loss || claim.created_at;
    const now = new Date().toISOString();

    // Find key event dates
    const findEvent = (types: string[]) =>
      events.find((e: any) => types.some(t => e.event_type?.toLowerCase().includes(t)));

    const claimFiled = findEvent(["filed", "submitted", "reported"]);
    const acknowledged = findEvent(["acknowledge", "received", "assigned"]);
    const inspected = findEvent(["inspection", "inspect", "investigated"]);
    const denied = findEvent(["denial", "denied", "deny"]);
    const paid = findEvent(["payment", "paid", "check"]);
    const supplementFiled = findEvent(["supplement"]);

    const filedDate = claimFiled?.occurred_at || claim.created_at;

    // 1. Delayed acknowledgment
    if (filedDate && !acknowledged) {
      const daysSinceFiled = daysBetween(filedDate, now);
      if (daysSinceFiled > deadlines.acknowledge) {
        violations.push({
          violationType: "delayed_acknowledgment",
          severity: daysSinceFiled > deadlines.acknowledge * 2 ? "high" : "medium",
          description: `Carrier has not acknowledged the claim after ${daysSinceFiled} days (deadline: ${deadlines.acknowledge} days)`,
          recommendedAction: "Send formal demand for acknowledgment citing state regulations",
          daysExceeded: daysSinceFiled - deadlines.acknowledge,
        });
      }
    } else if (filedDate && acknowledged) {
      const daysToAck = daysBetween(filedDate, acknowledged.occurred_at);
      if (daysToAck > deadlines.acknowledge) {
        violations.push({
          violationType: "delayed_acknowledgment",
          severity: "medium",
          description: `Carrier acknowledged claim ${daysToAck} days after filing (deadline: ${deadlines.acknowledge} days)`,
          recommendedAction: "Document violation for regulatory complaint or leverage in negotiations",
          daysExceeded: daysToAck - deadlines.acknowledge,
        });
      }
    }

    // 2. Failure to investigate
    if (filedDate && !inspected) {
      const daysSinceFiled = daysBetween(filedDate, now);
      if (daysSinceFiled > deadlines.investigate) {
        violations.push({
          violationType: "failure_to_investigate",
          severity: "high",
          description: `No inspection conducted after ${daysSinceFiled} days (deadline: ${deadlines.investigate} days)`,
          recommendedAction: "Demand immediate inspection; prepare regulatory complaint",
          daysExceeded: daysSinceFiled - deadlines.investigate,
        });
      }
    }

    // 3. Denial without inspection
    if (denied && !inspected) {
      violations.push({
        violationType: "denial_without_inspection",
        severity: "high",
        description: "Carrier issued denial without conducting an on-site inspection",
        recommendedAction: "Challenge denial on procedural grounds; file regulatory complaint",
      });
    } else if (denied && inspected) {
      const denialDate = new Date(denied.occurred_at);
      const inspectionDate = new Date(inspected.occurred_at);
      if (denialDate < inspectionDate) {
        violations.push({
          violationType: "denial_before_inspection",
          severity: "high",
          description: "Denial letter predates the inspection date — carrier decided before investigating",
          recommendedAction: "Use as evidence of bad faith; include in regulatory complaint",
        });
      }
    }

    // 4. Payment delays
    if (paid && acknowledged) {
      const daysToPay = daysBetween(acknowledged.occurred_at, paid.occurred_at);
      if (daysToPay > deadlines.pay) {
        violations.push({
          violationType: "payment_delay",
          severity: daysToPay > deadlines.pay * 2 ? "high" : "medium",
          description: `Payment delayed ${daysToPay} days after acknowledgment (deadline: ${deadlines.pay} days)`,
          recommendedAction: "Cite prompt pay statute; demand interest on delayed payment",
          daysExceeded: daysToPay - deadlines.pay,
        });
      }
    }

    // 5. Inconsistent carrier actions — look for contradictory events
    const denialEvents = events.filter((e: any) => e.event_type?.toLowerCase().includes("deni"));
    const approvalEvents = events.filter((e: any) =>
      e.event_type?.toLowerCase().includes("approv") || e.event_type?.toLowerCase().includes("paid")
    );
    if (denialEvents.length > 0 && approvalEvents.length > 0) {
      violations.push({
        violationType: "inconsistent_actions",
        severity: "medium",
        description: "Carrier both denied and approved/paid portions of the claim — position may be inconsistent",
        recommendedAction: "Highlight inconsistency in rebuttal; use as leverage for full scope approval",
      });
    }

    // Store violations
    if (violations.length > 0) {
      const rows = violations.map((v) => ({
        claim_id: claimId,
        violation_type: v.violationType,
        severity: v.severity,
        description: v.description,
        recommended_action: v.recommendedAction,
        days_exceeded: v.daysExceeded || null,
        statute_reference: v.statuteReference || null,
      }));
      await Promise.resolve(supabase.from("claim_violation_detections").insert(rows).throwOnError()).catch(() => {});
    }

    return violations;
  } catch (e) {
    console.error("[ViolationEngine] Error:", e);
    return [];
  }
}

export function formatViolations(violations: ViolationDetection[]): string {
  if (!violations.length) return "";
  const lines = violations.map((v) =>
    `[${v.severity.toUpperCase()}] ${v.violationType}: ${v.description}\n  → ${v.recommendedAction}${v.daysExceeded ? ` (${v.daysExceeded} days exceeded)` : ""}`
  );
  return `=== CARRIER VIOLATIONS DETECTED ===\n${lines.join("\n\n")}\n=== END CARRIER VIOLATIONS ===`;
}
