import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { FileSignature, Loader2, CheckCircle, Clock, AlertCircle, Eye, ExternalLink, XCircle } from "lucide-react";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";

interface SendForSignatureButtonProps {
  claim: any;
  onUpdate?: () => void;
}

export function SendForSignatureButton({ claim, onUpdate }: SendForSignatureButtonProps) {
  const [sending, setSending] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const hasContractPdf = !!claim.contract_pdf_path;
  const hasSignerEmail = !!claim.policyholder_email;
  const esignStatus = claim.esign_status || "draft";

  const canSend = hasContractPdf && hasSignerEmail && 
    !["sending", "sent", "completed"].includes(esignStatus);

  const handleSendForSignature = async () => {
    if (!canSend) return;

    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("esign-send", {
        body: { claimId: claim.id }
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not send signature request"));
      }
      if (data?.error) throw new Error(data.error);

      toast({
        title: "Sent for signature",
        description: `Contract sent to ${claim.policyholder_email}`,
      });

      // Refresh claim data
      queryClient.invalidateQueries({ queryKey: ["claim", claim.id] });
      onUpdate?.();
    } catch (error: any) {
      console.error("Error sending for signature:", error);
      toast({
        title: "Failed to send",
        description: error.message || "Could not send for signature",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const getStatusBadge = () => {
    switch (esignStatus) {
      case "sending":
        return <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Sending</Badge>;
      case "sent":
        return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" /> Awaiting Signature</Badge>;
      case "viewed":
        return <Badge variant="secondary" className="gap-1"><Eye className="h-3 w-3" /> Viewed</Badge>;
      case "completed":
        return <Badge variant="default" className="gap-1 bg-green-600"><CheckCircle className="h-3 w-3" /> Signed</Badge>;
      case "declined":
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> Declined</Badge>;
      case "error":
        return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> Error</Badge>;
      default:
        return <Badge variant="outline" className="gap-1">Draft</Badge>;
    }
  };

  const getButtonDisabledReason = () => {
    if (!hasContractPdf) return "Generate contract PDF first";
    if (!hasSignerEmail) return "Policyholder email required";
    if (esignStatus === "sending") return "Sending in progress...";
    if (esignStatus === "sent") return "Already sent - awaiting signature";
    if (esignStatus === "completed") return "Already signed";
    return null;
  };

  const disabledReason = getButtonDisabledReason();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileSignature className="h-4 w-4" />
          E-Signature
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Status:</span>
          {getStatusBadge()}
        </div>

        {claim.esign_sent_at && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Sent:</span>
            <span>{new Date(claim.esign_sent_at).toLocaleDateString()}</span>
          </div>
        )}

        {claim.esign_completed_at && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Completed:</span>
            <span>{new Date(claim.esign_completed_at).toLocaleDateString()}</span>
          </div>
        )}

        {claim.esign_error_message && (
          <div className="text-sm text-red-600 bg-red-50 p-2 rounded">
            {claim.esign_error_message}
          </div>
        )}

        {claim.signed_pdf_url && (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={() => window.open(claim.signed_pdf_url, "_blank")}
          >
            <ExternalLink className="h-4 w-4" />
            View Signed Document
          </Button>
        )}

        {claim.esign_signing_link && esignStatus === "sent" && (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={() => window.open(claim.esign_signing_link, "_blank")}
          >
            <ExternalLink className="h-4 w-4" />
            View Signing Link
          </Button>
        )}

        <Button
          onClick={handleSendForSignature}
          disabled={!canSend || sending}
          className="w-full gap-2"
          title={disabledReason || undefined}
        >
          {sending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Sending...
            </>
          ) : (
            <>
              <FileSignature className="h-4 w-4" />
              Send for Signature
            </>
          )}
        </Button>

        {disabledReason && !sending && (
          <p className="text-xs text-muted-foreground text-center">
            {disabledReason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
