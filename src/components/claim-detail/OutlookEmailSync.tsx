import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Loader2, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface OutlookEmailSyncProps {
  claimId: string;
}

export function OutlookEmailSync({ claimId }: OutlookEmailSyncProps) {
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<{ imported: number; matching: number } | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Check if user has an active email connection
  const { data: hasConnection } = useQuery({
    queryKey: ["email-connection-exists"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      const { data } = await supabase
        .from("email_connections")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .limit(1);
      return data && data.length > 0;
    },
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("outlook-email-sync", {
        body: { action: "sync_emails", claim_id: claimId },
      });

      if (error) throw error;

      // Handle JSON body errors
      if (data?.success === false) throw new Error(data.error || "Sync failed");

      setLastResult({ imported: data.imported, matching: data.matching });

      if (data.warning) {
        toast({
          title: "Sync completed with warnings",
          description: data.warning,
          variant: "destructive",
        });
        queryClient.invalidateQueries({ queryKey: ["emails", claimId] });
      } else if (data.imported > 0) {
        toast({
          title: "Emails synced!",
          description: `Imported ${data.imported} new email${data.imported > 1 ? "s" : ""} from Outlook.`,
        });
        queryClient.invalidateQueries({ queryKey: ["emails", claimId] });
      } else if (data.matching > 0) {
        toast({
          title: "Already up to date",
          description: `Found ${data.matching} matching emails, but all were already imported.`,
        });
      } else {
        toast({
          title: "No matching emails",
          description: "No emails in your Outlook matched this claim's details.",
        });
      }
    } catch (e: any) {
      toast({ title: "Sync failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  if (!hasConnection) return null;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={syncing}
        className="gap-2"
      >
        {syncing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        Sync Outlook
      </Button>
      {lastResult && lastResult.imported > 0 && (
        <Badge variant="outline" className="text-xs gap-1 text-green-700 border-green-500/30">
          <CheckCircle className="h-3 w-3" />
          {lastResult.imported} imported
        </Badge>
      )}
    </div>
  );
}
