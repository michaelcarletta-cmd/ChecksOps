import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";

/* ------------------------------------------------------------------ */
/*  Shared row types — matching DB schema, no `as any`                 */
/* ------------------------------------------------------------------ */

export interface LossDraftRecord {
  id: string;
  claim_id: string | null;
  mortgage_servicer: string;
  loss_draft_contact: string | null;
  escrow_status: string;
  draw_stage: number;
  draw_amount_requested: number;
  draw_amount_released: number;
  holdback_amount: number;
  total_escrowed: number;
  follow_up_date: string | null;
  follow_up_count: number;
  last_contact_at: string | null;
  check_sent_date: string | null;
  check_received_date: string | null;
  check_received_back_date: string | null;
  monitoring_type: string;
  tracking_number_sent: string | null;
  notes: string | null;
  check_intake_item_id: string | null;
  check_intake_items?: {
    check_number: string | null;
    amount: number | null;
    payee_line: string | null;
    carrier_name: string | null;
    status: string | null;
  } | null;
}

export interface LossDraftRelease {
  id: string;
  draw_number: number;
  amount_requested: number;
  amount_released: number;
  holdback_amount: number;
  status: string;
  release_date: string | null;
  requested_at: string;
  released_at: string | null;
  notes: string | null;
}

export interface LossDraftDoc {
  id: string;
  document_type: string;
  document_label: string;
  is_required: boolean;
  is_submitted: boolean;
  submitted_at: string | null;
  notes: string | null;
  file_path: string | null;
  file_name: string | null;
}

export interface LossDraftAuditEntry {
  id: string;
  action: string;
  actor_id: string | null;
  amount: number | null;
  notes: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

export function useLossDraftDetail(lossDraftId: string) {
  return useQuery({
    queryKey: queryKeys.lossDraft.detail(lossDraftId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_tracking")
        .select("*, check_intake_items(check_number, amount, payee_line, carrier_name, status)")
        .eq("id", lossDraftId)
        .single();
      if (error) throw error;
      return data as unknown as LossDraftRecord;
    },
    enabled: !!lossDraftId,
  });
}

export function useLossDraftReleases(lossDraftId: string) {
  return useQuery({
    queryKey: queryKeys.lossDraft.releases(lossDraftId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_releases")
        .select("*")
        .eq("loss_draft_id", lossDraftId)
        .order("draw_number", { ascending: true });
      if (error) throw error;
      return (data ?? []) as LossDraftRelease[];
    },
    enabled: !!lossDraftId,
  });
}

export function useLossDraftDocs(lossDraftId: string) {
  return useQuery({
    queryKey: queryKeys.lossDraft.docs(lossDraftId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_documents")
        .select("*")
        .eq("loss_draft_id", lossDraftId)
        .order("is_required", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LossDraftDoc[];
    },
    enabled: !!lossDraftId,
  });
}

export function useLossDraftAudit(lossDraftId: string) {
  return useQuery({
    queryKey: queryKeys.lossDraft.audit(lossDraftId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_audit_log")
        .select("*")
        .eq("loss_draft_id", lossDraftId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as LossDraftAuditEntry[];
    },
    enabled: !!lossDraftId,
  });
}

/**
 * Returns a function that invalidates every cached query tied to this loss draft —
 * detail, releases, docs, and audit. Use after any mutating action.
 */
export function useInvalidateLossDraft(lossDraftId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.lossDraft.detail(lossDraftId) });
    qc.invalidateQueries({ queryKey: queryKeys.lossDraft.releases(lossDraftId) });
    qc.invalidateQueries({ queryKey: queryKeys.lossDraft.docs(lossDraftId) });
    qc.invalidateQueries({ queryKey: queryKeys.lossDraft.audit(lossDraftId) });
  };
}
