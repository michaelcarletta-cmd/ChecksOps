import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  buildReturnAckMessage,
  buildReturnMessage,
  emptyMortgageDeskReturnState,
  loadMortgageDeskReturnStates,
  returnAckLookupPattern,
  returnMessageLookupPattern,
  type MortgageDeskReturnReadClient,
  type MortgageDeskReturnState,
} from "@/lib/mortgageDeskReturn";

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message?: string } | null }>;

/**
 * Minimal structural view of the data client (Supabase or the AWS adapter)
 * used by these helpers, so tests can pass a fake client.
 */
type QueryChain = QueryResult<Array<Record<string, unknown>>> & {
  select: (columns: string) => QueryChain;
  in: (column: string, values: string[]) => QueryChain;
  eq: (column: string, value: unknown) => QueryChain;
  like: (column: string, pattern: string) => QueryChain;
  limit: (count: number) => QueryChain;
  maybeSingle: () => QueryResult<Record<string, unknown>>;
};

type MessageClient = {
  from: (table: string) => {
    select: (columns: string) => QueryChain;
    insert: (values: Record<string, unknown>) => QueryChain;
  };
};

const defaultClient = supabase as unknown as MessageClient;

export function mortgageDeskReturnQueryKey(checkId: string | null | undefined) {
  return ["mortgage-desk-return", checkId || "none"] as const;
}

export function mortgageDeskReturnListQueryKey(checkIds: string[]) {
  return ["mortgage-desk-returns", [...checkIds].sort().join(",")] as const;
}

function loadReturnState(
  client: MessageClient,
  checkIds: string[],
): Promise<Record<string, MortgageDeskReturnState>> {
  return loadMortgageDeskReturnStates(client as unknown as MortgageDeskReturnReadClient, checkIds);
}

export function useMortgageDeskReturnAlert(checkId: string | null | undefined) {
  return useQuery({
    queryKey: mortgageDeskReturnQueryKey(checkId),
    enabled: !!checkId,
    queryFn: async () => {
      const map = await loadReturnState(defaultClient, [checkId!]);
      return map[checkId!] || emptyMortgageDeskReturnState();
    },
  });
}

export function useMortgageDeskReturnAlerts(checkIds: string[]) {
  const ids = [...new Set(checkIds.filter(Boolean))];
  return useQuery({
    queryKey: mortgageDeskReturnListQueryKey(ids),
    enabled: ids.length > 0,
    queryFn: () => loadReturnState(defaultClient, ids),
    // Keep the previous map while a new id set loads so badges don't flicker,
    // and match the loss-draft dashboard's refetchOnWindowFocus choice.
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

export async function ensureMortgageDeskReturnMessage(
  params: { checkId: string; requestId: string; senderId: string | null },
  client: MessageClient = defaultClient,
): Promise<{ inserted: boolean; id?: string; error?: { message?: string } | null }> {
  const { data: existing } = await client
    .from("check_messages")
    .select("id")
    .eq("check_id", params.checkId)
    .like("body", returnMessageLookupPattern(params.requestId))
    .eq("is_deleted", false)
    .limit(1);
  if (existing && existing.length > 0) {
    return { inserted: false, id: String(existing[0].id) };
  }
  const { data, error } = await client
    .from("check_messages")
    .insert({
      check_id: params.checkId,
      sender_id: params.senderId,
      body: buildReturnMessage(params.requestId),
    })
    .select("id")
    .maybeSingle();
  if (error) return { inserted: false, error };
  return { inserted: true, id: data?.id ? String(data.id) : undefined };
}

export async function acknowledgeMortgageDeskReturn(
  params: { checkId: string; requestIds: string[]; senderId: string | null },
  client: MessageClient = defaultClient,
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
    });
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
    const result = await acknowledgeMortgageDeskReturn(params);
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
