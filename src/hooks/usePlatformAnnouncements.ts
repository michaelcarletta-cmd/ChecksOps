import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAwsPollingFallback } from "@/hooks/useAwsPollingFallback";

export interface PlatformAnnouncement {
  id: string;
  title: string;
  message: string;
  severity: "info" | "maintenance" | "critical";
  scheduled_start: string | null;
  scheduled_end: string | null;
  refresh_instructions: string | null;
  is_active: boolean;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Announcements currently inside their display window. */
export function useActivePlatformAnnouncements() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["platform-announcements", "active"],
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async (): Promise<PlatformAnnouncement[]> => {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from("platform_announcements" as any)
        .select("*")
        .eq("is_active", true)
        .lte("starts_at", nowIso)
        .order("created_at", { ascending: false });
      if (error) return [];
      return ((data ?? []) as unknown as PlatformAnnouncement[]).filter(
        (a) => !a.ends_at || new Date(a.ends_at) > new Date()
      );
    },
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["platform-announcements"] });
  }, [queryClient]);

  // AWS staging: refetchInterval already covers freshness; keep a light poll hook for consistency.
  useAwsPollingFallback(true, invalidate, 30_000);

  // Push updates: any change to announcements appears instantly, no refresh needed.
  useEffect(() => {
    const channel = supabase
      .channel("platform-announcements-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "platform_announcements" },
        invalidate,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [invalidate]);

  return query;
}

/** Every announcement (platform owner only — RLS blocks others from writing). */
export function useAllPlatformAnnouncements() {
  return useQuery({
    queryKey: ["platform-announcements", "all"],
    queryFn: async (): Promise<PlatformAnnouncement[]> => {
      const { data, error } = await supabase
        .from("platform_announcements" as any)
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PlatformAnnouncement[];
    },
  });
}
