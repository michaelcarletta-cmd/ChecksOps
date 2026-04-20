import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ClaimMicrotask, MicrotaskPriority, MicrotaskStatus } from "@/services/claimOperationsService";
import { useToast } from "@/hooks/use-toast";

export function useClaimMicrotasks(claimId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["claim-microtasks", claimId];

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<ClaimMicrotask[]> => {
      const { data, error } = await supabase
        .from("claim_microtasks")
        .select("*")
        .eq("claim_id", claimId)
        .order("priority", { ascending: true }) // immediate first alphabetically reversed
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data || []) as ClaimMicrotask[];
    },
    enabled: !!claimId,
  });

  const createMicrotask = useMutation({
    mutationFn: async (input: {
      title: string;
      description?: string;
      task_type?: string;
      priority?: MicrotaskPriority;
      due_at?: string;
      is_blocking?: boolean;
      assigned_to?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("claim_microtasks").insert({
        claim_id: claimId,
        title: input.title,
        description: input.description || null,
        task_type: input.task_type || null,
        priority: input.priority || "normal",
        due_at: input.due_at || null,
        is_blocking: input.is_blocking || false,
        assigned_to: input.assigned_to || null,
        created_by: user?.id || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Microtask created" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateMicrotask = useMutation({
    mutationFn: async (input: { id: string } & Partial<ClaimMicrotask>) => {
      const { id, ...updates } = input;
      // If completing, set completed_at
      if (updates.status === "done") {
        (updates as any).completed_at = new Date().toISOString();
      }
      const { error } = await supabase
        .from("claim_microtasks")
        .update(updates)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMicrotask = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("claim_microtasks")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Microtask deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return {
    microtasks: query.data || [],
    loading: query.isLoading,
    refetch: query.refetch,
    createMicrotask,
    updateMicrotask,
    deleteMicrotask,
  };
}
