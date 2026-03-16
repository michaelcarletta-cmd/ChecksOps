import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CanonicalTimelineEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  summary: string | null;
  actor: string | null;
  source_artifact_id: string | null;
  source_artifact_type: string | null;
  source_table?: string | null;
  source_row_id?: string | null;
  metadata_json: Record<string, unknown>;
  date_source?: string | null;
  date_confidence?: number | null;
  date_evidence?: string | null;
  doc_type?: string | null;
  is_manual?: boolean;
  is_editable?: boolean;
  is_pinned?: boolean;
  importance_score?: number | null;
  dispute_tag?: string | null;
  supports_escalation?: boolean;
  supports_rebuttal?: boolean;
  is_verified?: boolean;
  verification_basis?: string | null;
  derived?: boolean;
}

export interface CanonicalTimelineSummary {
  total_events: number;
  verified_events: number;
  document_backed_events: number;
  manual_events: number;
  escalation_candidates: number;
  rebuttal_candidates: number;
}

export interface CanonicalTimelinePayload {
  claimId: string;
  claim: any;
  summary: CanonicalTimelineSummary;
  events: CanonicalTimelineEvent[];
}

export function useCanonicalTimeline(claimId: string) {
  const [events, setEvents] = useState<CanonicalTimelineEvent[]>([]);
  const [summary, setSummary] = useState<CanonicalTimelineSummary | null>(null);
  const [claim, setClaim] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("get-claim-timeline", {
        body: { claimId },
      });
      if (fnErr) throw fnErr;
      const payload = data as CanonicalTimelinePayload;
      setEvents(payload.events || []);
      setSummary(payload.summary || null);
      setClaim(payload.claim || null);
    } catch (err) {
      console.error("useCanonicalTimeline error:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    load();
  }, [load]);

  // Subscribe to all canonical source tables for auto-refresh
  useEffect(() => {
    const channel = supabase
      .channel(`canonical-timeline-${claimId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_events", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_updates", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_files", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "emails", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "inspections", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_payments", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_checks", filter: `claim_id=eq.${claimId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "claims", filter: `id=eq.${claimId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [claimId, load]);

  return { events, summary, claim, loading, error, reload: load };
}
