import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FileSignature, Send, Copy } from "lucide-react";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";

interface SharedCheckPaymentDirectionProps {
  checkIntakeItemId: string;
  checkNumber?: string | null;
}

/**
 * Direction-to-Pay (DTP) composer for shared checks.
 *
 * Use this when a contractor / PA / sales rep will be paid from the check
 * proceeds but is NOT a named payee on the check itself. Endorsements come
 * from the named payees; this collects the *insured's* signed authorization
 * directing the funds to a third party.
 *
 * Implementation: creates a signature_request scoped by check_intake_item_id
 * with document_name "Direction to Pay - {recipient}" so it is clearly
 * distinct from endorsement requests in the same panel.
 */
export function SharedCheckPaymentDirection({
  checkIntakeItemId,
  checkNumber,
}: SharedCheckPaymentDirectionProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [recipientName, setRecipientName] = useState("");
  const [insuredName, setInsuredName] = useState("");
  const [insuredEmail, setInsuredEmail] = useState("");

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["shared-check-dtp-requests", checkIntakeItemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select("*, signature_signers(*)")
        .eq("check_intake_item_id", checkIntakeItemId)
        .ilike("document_name", "Direction to Pay%")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const recipient = recipientName.trim();
      const name = insuredName.trim();
      const email = insuredEmail.trim();

      if (!recipient) throw new Error("Enter the contractor / PA receiving payment.");
      if (!name || !email || !/.+@.+\..+/.test(email)) {
        throw new Error("Enter the insured's name and valid email.");
      }

      const docName = `Direction to Pay - ${recipient}${checkNumber ? ` (Check #${checkNumber})` : ""}`;

      const { data: req, error: reqErr } = await supabase
        .from("signature_requests")
        .insert({
          claim_id: null,
          check_intake_item_id: checkIntakeItemId,
          document_name: docName,
          document_path: `check-intake/${checkIntakeItemId}/payment-direction`,
          status: "draft",
        })
        .select()
        .single();
      if (reqErr) throw reqErr;

      const { error: signerErr } = await supabase.from("signature_signers").insert({
        signature_request_id: req.id,
        signer_name: name,
        signer_email: email.toLowerCase(),
        signing_order: 1,
        signer_type: "insured",
        status: "pending",
      });
      if (signerErr) throw signerErr;

      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId: req.id },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not send DTP request"));
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Direction-to-Pay request sent" });
      setRecipientName("");
      setInsuredName("");
      setInsuredEmail("");
      qc.invalidateQueries({ queryKey: ["shared-check-dtp-requests", checkIntakeItemId] });
    },
    onError: (err: Error) =>
      toast({ title: "Failed to send", description: err.message, variant: "destructive" }),
  });

  const resendMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId },
      });
      if (error) throw new Error(await getFunctionErrorMessage(error, "Could not resend"));
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Resent" });
      qc.invalidateQueries({ queryKey: ["shared-check-dtp-requests", checkIntakeItemId] });
    },
    onError: (err: Error) =>
      toast({ title: "Resend failed", description: err.message, variant: "destructive" }),
  });

  const copySignLink = (token: string) => {
    const url = `${window.location.origin}/sign?token=${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Sign link copied" });
  };

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileSignature className="h-4 w-4" />
          Request Direction to Pay (DTP)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Use this when a contractor, PA, or sales rep will be paid from this check but is{" "}
          <strong>not a named payee</strong>. The insured signs authorizing the disbursement —
          endorsements come from the named payees separately above.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Payment recipient (contractor / PA / rep)
            </Label>
            <Input
              placeholder="e.g. Acme Restoration LLC"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Insured name
              </Label>
              <Input
                placeholder="Policyholder name"
                value={insuredName}
                onChange={(e) => setInsuredName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Insured email
              </Label>
              <Input
                type="email"
                placeholder="insured@example.com"
                value={insuredEmail}
                onChange={(e) => setInsuredEmail(e.target.value)}
              />
            </div>
          </div>
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
            Send DTP request
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : requests.length > 0 ? (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium">Sent DTP requests ({requests.length})</p>
            {requests.map((req: any) => (
              <div key={req.id} className="rounded border p-2 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{req.document_name}</span>
                    <Badge
                      variant={
                        req.status === "completed"
                          ? "default"
                          : req.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {req.status}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground flex-shrink-0">
                    {new Date(req.created_at).toLocaleString()}
                  </span>
                </div>
                {req.last_error && (
                  <p className="text-destructive text-[11px]">{req.last_error}</p>
                )}
                <div className="space-y-1">
                  {(req.signature_signers ?? []).map((signer: any) => (
                    <div
                      key={signer.id}
                      className="flex items-center justify-between gap-2 bg-muted/40 rounded px-2 py-1"
                    >
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
