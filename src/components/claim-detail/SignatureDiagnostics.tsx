import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  Activity, AlertTriangle, CheckCircle, ChevronDown, Clock, Copy, ExternalLink,
  Loader2, Mail, RefreshCw, Send, XCircle, Link2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";

interface SignatureDiagnosticsProps {
  claimId: string;
  claim: any;
}

export function SignatureDiagnostics({ claimId, claim }: SignatureDiagnosticsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);

  const { data: requests, isLoading } = useQuery({
    queryKey: ["sig-diagnostics", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select(`*, signature_signers(*)`)
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: eventLogs } = useQuery({
    queryKey: ["esign-event-logs", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("esign_event_logs")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const resendMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not resend signature request"));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Signature request resent" });
      queryClient.invalidateQueries({ queryKey: ["sig-diagnostics", claimId] });
      queryClient.invalidateQueries({ queryKey: ["esign-event-logs", claimId] });
    },
    onError: (err: Error) => {
      toast({ title: "Resend failed", description: err.message, variant: "destructive" });
    },
  });

  const manualBypassMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId, skipEmail: true },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not generate signer links"));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      const links = data?.signerLinks?.map((l: any) => l.sign_url).join("\n") || "";
      navigator.clipboard.writeText(links);
      toast({ title: "Sign links copied to clipboard", description: "Email was NOT sent — manual delivery mode" });
      queryClient.invalidateQueries({ queryKey: ["sig-diagnostics", claimId] });
      queryClient.invalidateQueries({ queryKey: ["esign-event-logs", claimId] });
    },
    onError: (err: Error) => {
      toast({ title: "Bypass failed", description: err.message, variant: "destructive" });
    },
  });

  const copySignLink = (token: string) => {
    const url = `${window.location.origin}/sign?token=${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Sign link copied" });
  };

  const getStatusIcon = (status: string) => {
    if (["completed", "signed", "sent", "ok", "success"].includes(status)) return <CheckCircle className="h-3.5 w-3.5 text-green-600" />;
    if (["failed", "error", "declined"].includes(status)) return <XCircle className="h-3.5 w-3.5 text-red-600" />;
    if (["pending", "in_progress", "sending"].includes(status)) return <Clock className="h-3.5 w-3.5 text-yellow-600" />;
    return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  const getStatusColor = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (["completed", "signed", "sent"].includes(status)) return "default";
    if (["failed", "error", "declined"].includes(status)) return "destructive";
    if (["pending", "in_progress"].includes(status)) return "secondary";
    return "outline";
  };

  if (isLoading) {
    return <div className="flex items-center justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  if (!requests?.length) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground text-sm">
          No signature requests to diagnose
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Signature Diagnostics
        </h3>
      </div>

      {requests.map((req: any) => {
        const reqLogs = eventLogs?.filter((l: any) => l.request_id === req.id) || [];
        const lastEvent = reqLogs[0];
        const isExpanded = expandedRequest === req.id;

        return (
          <Card key={req.id} className={cn(
            "border",
            req.status === "failed" && "border-red-500/50 bg-red-50/30 dark:bg-red-950/10"
          )}>
            <Collapsible open={isExpanded} onOpenChange={() => setExpandedRequest(isExpanded ? null : req.id)}>
              <CollapsibleTrigger className="w-full">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-left">
                      <CardTitle className="text-sm">{req.document_name}</CardTitle>
                      <Badge variant={getStatusColor(req.status)}>{req.status}</Badge>
                      {req.provider_status && (
                        <Badge variant="outline" className="text-xs">{req.provider_status}</Badge>
                      )}
                    </div>
                    <ChevronDown className={cn("h-4 w-4 transition-transform text-muted-foreground", isExpanded && "rotate-180")} />
                  </div>
                  {req.last_error && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-red-600">
                      <AlertTriangle className="h-3 w-3" />
                      {req.last_error}
                    </div>
                  )}
                </CardHeader>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <CardContent className="pt-0 space-y-4">
                  {/* Request Meta */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Created:</span> {new Date(req.created_at).toLocaleString()}</div>
                    <div><span className="text-muted-foreground">Sent at:</span> {req.sent_at ? new Date(req.sent_at).toLocaleString() : "—"}</div>
                    <div><span className="text-muted-foreground">Completed at:</span> {req.completed_at ? new Date(req.completed_at).toLocaleString() : "—"}</div>
                    <div><span className="text-muted-foreground">Provider msg ID:</span> {req.provider_message_id || "—"}</div>
                  </div>

                  {/* Signers */}
                  <div>
                    <p className="text-xs font-medium mb-2">Signers</p>
                    <div className="space-y-2">
                      {req.signature_signers?.sort((a: any, b: any) => a.signing_order - b.signing_order).map((signer: any) => (
                        <div key={signer.id} className="flex items-center justify-between text-xs p-2 rounded bg-muted/50 gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {getStatusIcon(signer.delivery_status || signer.status)}
                            <span className="font-medium truncate">{signer.signer_name}</span>
                            <span className="text-muted-foreground truncate">{signer.signer_email}</span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {signer.delivery_status && (
                              <Badge variant={getStatusColor(signer.delivery_status)} className="text-[10px] px-1.5">
                                {signer.delivery_status}
                              </Badge>
                            )}
                            {signer.delivery_error && (
                              <span className="text-red-600 truncate max-w-[120px]" title={signer.delivery_error}>
                                {signer.delivery_error}
                              </span>
                            )}
                            {signer.email_sent_at && (
                              <span className="text-muted-foreground">
                                <Mail className="h-3 w-3 inline" /> {new Date(signer.email_sent_at).toLocaleTimeString()}
                              </span>
                            )}
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); copySignLink(signer.access_token); }}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resendMutation.mutate(req.id)}
                      disabled={resendMutation.isPending}
                    >
                      {resendMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                      Resend Email
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => manualBypassMutation.mutate(req.id)}
                      disabled={manualBypassMutation.isPending}
                    >
                      {manualBypassMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Link2 className="h-3.5 w-3.5 mr-1" />}
                      Generate Link Only
                    </Button>
                  </div>

                  {/* Event Log */}
                  {reqLogs.length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-2">Event Log ({reqLogs.length})</p>
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-1">
                          {reqLogs.map((log: any) => (
                            <div key={log.id} className="flex items-start gap-2 text-[11px] p-1.5 rounded hover:bg-muted/50">
                              {getStatusIcon(log.status)}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-medium">{log.stage}</span>
                                  <Badge variant={getStatusColor(log.status)} className="text-[9px] px-1 py-0">{log.status}</Badge>
                                  <span className="text-muted-foreground ml-auto flex-shrink-0">
                                    {new Date(log.created_at).toLocaleTimeString()}
                                  </span>
                                </div>
                                {log.message && <p className="text-muted-foreground mt-0.5">{log.message}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        );
      })}
    </div>
  );
}
