import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { fillPartnerSigners } from "@/lib/partnerSafeReads";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail, Plus, Send, Trash2, Copy } from "lucide-react";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";

interface SharedCheckEndorsementsProps {
  checkIntakeItemId: string;
  documentName?: string;
}

interface NewSigner {
  name: string;
  email: string;
}

/**
 * Endorsement composer for shared checks (check_intake_items) that don't have
 * a local claim. Creates a signature_request keyed off check_intake_item_id
 * and invokes send-signature-request to email signers.
 */
export function SharedCheckEndorsements({
  checkIntakeItemId,
  documentName,
}: SharedCheckEndorsementsProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newSigners, setNewSigners] = useState<NewSigner[]>([{ name: "", email: "" }]);

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["shared-check-sig-requests", checkIntakeItemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select("*, signature_signers(*)")
        .eq("check_intake_item_id", checkIntakeItemId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return fillPartnerSigners(data ?? []);
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const valid = newSigners
        .map((s) => ({ name: s.name.trim(), email: s.email.trim() }))
        .filter((s) => s.name && s.email && /.+@.+\..+/.test(s.email));

      if (valid.length === 0) {
        throw new Error("Add at least one signer with a valid name and email.");
      }

      const docName = documentName || "Check Endorsement";

      // 1) Create signature_request scoped to the intake item (no claim).
      const { data: req, error: reqErr } = await supabase
        .from("signature_requests")
        .insert({
          claim_id: null,
          check_intake_item_id: checkIntakeItemId,
          document_name: docName,
          document_path: `check-intake/${checkIntakeItemId}/endorsement`,
          status: "draft",
        })
        .select()
        .single();
      if (reqErr) throw reqErr;

      // 2) Create signers.
      const signerRows = valid.map((s, idx) => ({
        signature_request_id: req.id,
        signer_name: s.name,
        signer_email: s.email.toLowerCase(),
        signing_order: idx + 1,
        signer_type: "payee",
        status: "pending" as const,
      }));
      const { error: signerErr } = await supabase
        .from("signature_signers")
        .insert(signerRows);
      if (signerErr) throw signerErr;

      // 3) Invoke send-signature-request to email signers.
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId: req.id },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not send endorsement emails"));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Endorsement emails sent" });
      setNewSigners([{ name: "", email: "" }]);
      qc.invalidateQueries({ queryKey: ["shared-check-sig-requests", checkIntakeItemId] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to send", description: err.message, variant: "destructive" });
    },
  });

  const resendMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not resend"));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Resent" });
      qc.invalidateQueries({ queryKey: ["shared-check-sig-requests", checkIntakeItemId] });
    },
    onError: (err: Error) =>
      toast({ title: "Resend failed", description: err.message, variant: "destructive" }),
  });

  const copySignLink = (token: string) => {
    const url = `${window.location.origin}/sign?token=${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Sign link copied" });
  };

  const updateSigner = (i: number, patch: Partial<NewSigner>) => {
    setNewSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const removeSigner = (i: number) => {
    setNewSigners((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  };

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Send Endorsement Emails
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Add signers and email them a secure link to sign the check endorsement.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Compose new signers */}
        <div className="space-y-2">
          {newSigners.map((s, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1.2fr_auto] gap-2">
              <div className="space-y-1">
                {i === 0 && <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Name</Label>}
                <Input
                  placeholder="Signer name"
                  value={s.name}
                  onChange={(e) => updateSigner(i, { name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                {i === 0 && <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Email</Label>}
                <Input
                  type="email"
                  placeholder="signer@example.com"
                  value={s.email}
                  onChange={(e) => updateSigner(i, { email: e.target.value })}
                />
              </div>
              <div className={i === 0 ? "self-end" : ""}>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeSigner(i)}
                  disabled={newSigners.length === 1}
                  aria-label="Remove signer"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewSigners((prev) => [...prev, { name: "", email: "" }])}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add signer
            </Button>
            <Button
              size="sm"
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
            >
              {sendMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              Send endorsement emails
            </Button>
          </div>
        </div>

        {/* Existing requests */}
        {isLoading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : requests.length > 0 ? (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium">Sent requests ({requests.length})</p>
            {requests.map((req: any) => (
              <div key={req.id} className="rounded border p-2 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{req.document_name}</span>
                    <Badge variant={
                      req.status === "completed" ? "default" :
                      req.status === "failed" ? "destructive" : "secondary"
                    }>{req.status}</Badge>
                  </div>
                  <span className="text-muted-foreground flex-shrink-0">
                    {new Date(req.created_at).toLocaleString()}
                  </span>
                </div>
                {req.last_error && (
                  <p className="text-destructive text-[11px]">{req.last_error}</p>
                )}
                <div className="space-y-1">
                  {(req.signature_signers ?? [])
                    .sort((a: any, b: any) => a.signing_order - b.signing_order)
                    .map((signer: any) => (
                      <div key={signer.id} className="flex items-center justify-between gap-2 bg-muted/40 rounded px-2 py-1">
                        <div className="min-w-0">
                          <span className="font-medium">{signer.signer_name}</span>
                          <span className="text-muted-foreground"> · {signer.signer_email}</span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {signer.delivery_status && (
                            <Badge variant="outline" className="text-[10px]">
                              {signer.delivery_status}
                            </Badge>
                          )}
                          {signer.access_token && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => copySignLink(signer.access_token)}
                              aria-label="Copy sign link"
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => resendMutation.mutate(req.id)}
                  disabled={resendMutation.isPending}
                >
                  {resendMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Send className="h-3.5 w-3.5 mr-1" />
                  )}
                  Resend
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
