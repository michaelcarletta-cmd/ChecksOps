import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Mail, Loader2, CheckCircle, XCircle, Trash2, ExternalLink, Copy, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function OutlookConnectionSettings({ embedded }: { embedded?: boolean }) {
  const [connecting, setConnecting] = useState(false);
  const [cleanupSyncing, setCleanupSyncing] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Check URL params for OAuth callback result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('outlook_connected') === 'true') {
      toast({ title: "Outlook connected!", description: "Your Microsoft account has been linked successfully." });
      queryClient.invalidateQueries({ queryKey: ["email-connections"] });
      window.history.replaceState({}, '', window.location.pathname);
    }
    const outlookError = params.get('outlook_error');
    if (outlookError) {
      toast({ title: "Connection failed", description: decodeURIComponent(outlookError), variant: "destructive" });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const { data: connections, isLoading } = useQuery({
    queryKey: ["email-connections"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data, error } = await supabase
        .from("email_connections")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const handleGetAuthUrl = async () => {
    setConnecting(true);
    try {
      const { data, error } = await supabase.functions.invoke("outlook-email-sync", {
        body: { action: "get_auth_url" },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Failed to get auth URL");
      setAuthUrl(data.authUrl);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setConnecting(false);
    }
  };

  const handleCopyUrl = async () => {
    if (!authUrl) return;
    try {
      await navigator.clipboard.writeText(authUrl);
      toast({ title: "Copied!", description: "Paste this URL in a new browser tab to sign in with Microsoft." });
    } catch {
      toast({ title: "Copy failed", description: "Please select and copy the URL manually.", variant: "destructive" });
    }
  };

  const deleteConnection = useMutation({
    mutationFn: async (connectionId: string) => {
      const { data, error } = await supabase.functions.invoke("outlook-email-sync", {
        body: { action: "delete_connection", connection_id: connectionId },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Delete failed");
    },
    onSuccess: () => {
      toast({ title: "Connection removed" });
      queryClient.invalidateQueries({ queryKey: ["email-connections"] });
    },
  });

  const handleCleanupAndResync = async () => {
    setCleanupSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("outlook-email-sync", {
        body: { action: "cleanup_and_resync" },
      });

      // Detect non-2xx style errors (function returned an HTTP error instead of JSON)
      if (error) {
        const errMsg = error.message || String(error);
        const isNon2xx = errMsg.includes("non-2xx") || errMsg.includes("FunctionsHttpError");
        if (isNon2xx) {
          throw new Error(
            "The sync function needs to be redeployed so it returns errors correctly. " +
            "Deploy the Outlook sync function from the project root: npm run deploy:outlook-sync " +
            "(or: supabase functions deploy outlook-email-sync). Then try again."
          );
        }
        throw new Error(errMsg);
      }

      // Handle JSON body errors
      if (data && typeof data === "object" && data.success === false) {
        throw new Error(data.error || "Cleanup and resync failed");
      }

      const deleted = data?.deleted ?? 0;
      const imported = data?.total_imported ?? 0;
      const claims = data?.claims_synced ?? 0;
      toast({
        title: "Cleanup and resync complete",
        description: `Removed ${deleted} wrongly-attached email(s). Synced ${imported} email(s) to ${claims} claim(s).`,
      });
      queryClient.invalidateQueries({ queryKey: ["email-connections"] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    } catch (e: any) {
      const message = e?.message || String(e);
<<<<<<< HEAD
      console.error("Cleanup and resync error:", e);
      const hint = message.includes("Unknown action") || message.includes("cleanup_and_resync")
        ? " Deploy the Outlook sync function from the project root: npm run deploy:outlook-sync (or: supabase functions deploy outlook-email-sync). Then try again."
        : "";
=======
      const isNon2xx = /non-2xx|non-2xx code/i.test(message);
      const isUnknownAction = message.includes("Unknown action") || message.includes("cleanup_and_resync");
      const deployHint =
        " Deploy the Outlook sync function from the project root: npm run deploy:outlook-sync (or: supabase functions deploy outlook-email-sync). Then try again.";
      const hint = isNon2xx || isUnknownAction ? deployHint : "";
>>>>>>> 8c7ec8a (Outlook email sync: claim/subject matching, cleanup, 200 responses)
      toast({
        title: "Cleanup and resync failed",
        description:
          (isNon2xx ? "The sync function needs to be redeployed so it returns errors correctly. " : "") + message + hint,
        variant: "destructive",
        duration: 12000,
      });
    } finally {
      setCleanupSyncing(false);
    }
  };

  const Wrapper = embedded ? "div" : Card;

  return (
    <Wrapper className={embedded ? "space-y-4" : undefined}>
      {!embedded && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Outlook / Microsoft 365 Connection
          </CardTitle>
          <CardDescription>
            Connect your Microsoft account so Darwin can see claim-related emails
          </CardDescription>
        </CardHeader>
      )}
      <div>
        <CardContent className={embedded ? "p-0" : undefined}>
          {/* Existing connections */}
          {connections && connections.length > 0 && (
            <div className="space-y-2 mb-6">
              <Label className="text-sm font-medium">Connected Accounts</Label>
              {connections.map((conn: any) => (
                <div key={conn.id} className="flex items-center justify-between p-3 rounded-md border bg-muted/30">
                  <div className="flex items-center gap-3">
                    <Mail className="h-4 w-4 text-primary" />
                    <div>
                      <p className="text-sm font-medium">{conn.email_address}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{conn.provider === 'outlook_oauth' ? 'Microsoft OAuth' : conn.imap_host}</span>
                        {conn.last_sync_at && (
                          <span>• Last synced: {new Date(conn.last_sync_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {conn.last_sync_error ? (
                      <Badge variant="destructive" className="text-xs gap-1">
                        <XCircle className="h-3 w-3" /> Error
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs gap-1 border-green-500/30">
                        <CheckCircle className="h-3 w-3 text-green-700" /> Active
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => deleteConnection.mutate(conn.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2"
                onClick={handleCleanupAndResync}
                disabled={cleanupSyncing}
              >
                {cleanupSyncing ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {cleanupSyncing ? "Cleaning up and resyncing…" : "Cleanup and resync emails"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Removes emails attached to the wrong claim (e.g. by adjuster) and resyncs by claim number / policyholder name in subject.
              </p>
            </div>
          )}

          {/* Sign in with Microsoft */}
          <div className="space-y-4">
            {!authUrl ? (
              <>
                <Button
                  onClick={handleGetAuthUrl}
                  disabled={connecting}
                  className="w-full"
                  variant="outline"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Mail className="h-4 w-4 mr-2" />
                  )}
                  {connecting ? "Generating sign-in link..." : "Sign in with Microsoft"}
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Uses secure OAuth 2.0 — your password is never stored
                </p>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-medium">Open this link in a new browser tab to sign in:</p>
                <div className="flex gap-2">
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-md border bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open Microsoft Sign-In
                  </a>
                  <Button variant="outline" size="icon" onClick={handleCopyUrl} title="Copy URL">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  After signing in, come back here and click "Check Connection" below.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      queryClient.invalidateQueries({ queryKey: ["email-connections"] });
                      toast({ title: "Checking...", description: "Looking for your Microsoft connection." });
                    }}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Check Connection
                  </Button>
                  <Button variant="ghost" onClick={() => setAuthUrl(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </div>
    </Wrapper>
  );
}
