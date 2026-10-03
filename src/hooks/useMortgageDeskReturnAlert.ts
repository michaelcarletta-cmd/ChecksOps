import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  buildReturnAckMessage,
  buildReturnMessage,
  deriveMortgageDeskReturnState,
  emptyMortgageDeskReturnState,
  returnAckLookupPattern,
  returnMessageLookupPattern,
  type MortgageDeskReturnRequest,
  type MortgageDeskReturnState,
} from "@/lib/mortgageDeskReturn";

type MessageClient = {
  from: (table: string) => any;
};

export function mortgageDeskReturnQueryKey(checkId: string | null | undefined) {
  return ["mortgage-desk-return", checkId || "none"] as const;
}

export function mortgageDeskReturnListQueryKey(checkIds: string[]) {
  return ["mortgage-desk-returns", [...checkIds].sort().join(",")] as const;
}

async function loadReturnState(
  client: MessageClient,
  checkIds: string[],
): Promise<Record<string, MortgageDeskReturnState>> {
  const ids = [...new Set(checkIds.filter(Boolean))];
  const empty: Record<string, MortgageDeskReturnState> = {};
  for (const id of ids) empty[id] = emptyMortgageDeskReturnState();
  if (ids.length === 0) return empty;

  const [requestsRes, messagesRes] = await Promise.all([
    client
      .from("mortgage_handling_requests")
      .select("id, check_intake_item_id, status, completed_at")
      .in("check_intake_item_id", ids)
      .eq("status", "completed"),
    client
      .from("check_messages")
      .select("id, check_id, body, created_at, is_deleted")
      .in("check_id", ids)
      .like("body", "MORTGAGE_DESK_RETURN%")
      .eq("is_deleted", false),
  ]);

  const requests = ((requestsRes.data || []) as MortgageDeskReturnRequest[]);
  const messages = (messagesRes.data || []) as Array<{
    id: string;
    check_id: string;
    body: string;
    created_at: string | null;
    is_deleted: boolean | null;
  }>;

  for (const checkId of ids) {
    empty[checkId] = deriveMortgageDeskReturnState(
      requests.filter((r) => r.check_intake_item_id === checkId),
      messages.filter((m) => m.check_id === checkId),
    );
  }
  return empty;
}

export function useMortgageDeskReturnAlert(checkId: string | null | undefined) {
  return useQuery({
    queryKey: mortgageDeskReturnQueryKey(checkId),
    enabled: !!checkId,
    queryFn: async () => {
      const map = await loadReturnState(supabase, [checkId!]);
      return map[checkId!] || emptyMortgageDeskReturnState();
    },
  });
}

export function useMortgageDeskReturnAlerts(checkIds: string[]) {
  const ids = [...new Set(checkIds.filter(Boolean))];
  return useQuery({
    queryKey: mortgageDeskReturnListQueryKey(ids),
    enabled: ids.length > 0,
    queryFn: () => loadReturnState(supabase, ids),
  });
}

export async function ensureMortgageDeskReturnMessage(
  client: MessageClient,
  params: { checkId: string; requestId: string; senderId: string | null },
): Promise<{ inserted: boolean; id?: string; error?: { message?: string } | null }> {
  const { data: existing } = await client
    .from("check_messages")
    .select("id")
    .eq("check_id", params.checkId)
    .like("body", returnMessageLookupPattern(params.requestId))
    .eq("is_deleted", false)
    .limit(1);
  if (existing && existing.length > 0) {
    return { inserted: false, id: existing[0].id };
  }
  const { data, error } = await client
    .from("check_messages")
    .insert({
      check_id: params.checkId,
      sender_id: params.senderId,
      body: buildReturnMessage(params.requestId),
    } as any)
    .select("id")
    .maybeSingle();
  if (error) return { inserted: false, error };
  return { inserted: true, id: data?.id };
}

export async function acknowledgeMortgageDeskReturn(
  client: MessageClient,
  params: { checkId: string; requestIds: string[]; senderId: string | null },
): Promise<{ inserted: number; error?: { message?: string } | null }> {
  let inserted = 0;
  for (const requestId of params.requestIds) {
    const { data: existing } = await client
      .from("check_messages")
      .select("id")
      .eq("check_id", params.checkId)
      .like("body", returnAckLookupPattern(requestId))
      .eq("is_deleted", false)
      .limit(1);
    if (existing && existing.length > 0) continue;
    const { error } = await client.from("check_messages").insert({
      check_id: params.checkId,
      sender_id: params.senderId,
      body: buildReturnAckMessage(requestId),
    } as any);
    if (error) return { inserted, error };
    inserted += 1;
  }
  return { inserted };
}

export function useAcknowledgeMortgageDeskReturn() {
  const qc = useQueryClient();
  return async (params: {
    checkId: string;
    requestIds: string[];
    senderId: string | null;
  }) => {
    const result = await acknowledgeMortgageDeskReturn(supabase, params);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["mortgage-desk-return"] }),
      qc.invalidateQueries({ queryKey: ["mortgage-desk-returns"] }),
      qc.invalidateQueries({ queryKey: ["check-messages", params.checkId] }),
      qc.invalidateQueries({ queryKey: ["mortgage-desk-requests", params.checkId] }),
      qc.invalidateQueries({ queryKey: ["mortgage-desk-request", params.checkId] }),
    ]);
    return result;
  };
}
