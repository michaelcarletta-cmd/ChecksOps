import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
  return useQuery({
    queryKey: ["platform-announcements", "active"],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
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
