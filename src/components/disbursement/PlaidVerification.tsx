import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePlaidLink } from "react-plaid-link";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle, Clock, XCircle, ShieldCheck, Loader2, Banknote,
} from "lucide-react";

interface Props {
  accountId: string;
  accountNickname: string;
  accountLast4: string;
  verificationStatus: string;
  /** Emailed verification token — set when an external account holder is linking. */
  publicToken?: string;
  onVerified?: () => void;
}

/**
 * Plaid Link bank verification.
 *
 * Unlike Authentecheck (a redirect to a hosted page, finalized asynchronously by
 * a postback), Plaid Link is an in-page overlay: onSuccess fires immediately and
 * `plaid-exchange` finalizes synchronously. No popups, no mobile OAuth session
 * loss, and status is correct the moment the modal closes.
 */
export function PlaidVerification({
  accountId,
  verificationStatus: status,
  publicToken,
  onVerified,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [linkToken, setLinkToken] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
    qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
  };

  const createLinkToken = useMutation({
    mutationFn: async () => {
      const fn = publicToken ? "plaid-link-token-create-public" : "plaid-link-token-create";
      const body = publicToken
        ? { token: publicToken }
        : { stakeholder_account_id: accountId };

      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) {
        let msg = error.message ?? "Failed to start verification";
        try {
          const b = await (error as any).context?.json?.();
          if (b?.error) msg = b.error;
        } catch {}
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      const token = (data as any)?.link_token as string | undefined;
      if (!token) throw new Error("No link token returned");
      return token;
    },
    onSuccess: (token) => setLinkToken(token),
    onError: (e: any) =>
      toast({
        title: "Couldn't start verification",
        description: e.message,
        variant: "destructive",
      }),
  });

  const exchange = useMutation({
    mutationFn: async (args: { public_token: string; account_id?: string }) => {
      const { data, error } = await supabase.functions.invoke("plaid-exchange", {
        body: {
          public_token: args.public_token,
          account_id: args.account_id,
          ...(publicToken ? { token: publicToken } : { stakeholder_account_id: accountId }),
        },
      });
      if (error) {
        let msg = error.message ?? "Verification failed";
        try {
          const b = await (error as any).context?.json?.();
          if (b?.error) msg = b.error;
        } catch {}
        throw new Error(msg);
      }
      if ((data as any)?.success === false) throw new Error((data as any).error);
      return data as any;
    },
    onSuccess: (data) => {
      invalidate();
      onVerified?.();
      toast({
        title: "Bank account verified",
        description: data?.institution
          ? `${data.institution} ••${data.mask} is ready for payments.`
          : "This account is ready for payments.",
      });
    },
    onError: (e: any) => {
      invalidate();
      toast({ title: "Verification failed", description: e.message, variant: "destructive" });
    },
  });

  const onSuccess = useCallback(
    (public_token: string, metadata: any) => {
      setLinkToken(null);
      exchange.mutate({
        public_token,
        account_id: metadata?.accounts?.[0]?.id ?? metadata?.account_id,
      });
    },
    [exchange],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: (err) => {
      setLinkToken(null);
      if (err) {
        toast({
          title: "Bank login closed",
          description: err.display_message ?? err.error_message ?? "You can try again.",
          variant: "destructive",
        });
      }
    },
  });

  // Auto-open as soon as the token is minted and Link is ready.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const busy = createLinkToken.isPending || exchange.isPending || !!linkToken;

  if (status === "verified" || status === "admin_override") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20 px-1.5 py-0.5 flex items-center gap-1 w-fit"
      >
        <ShieldCheck className="h-3 w-3" />
        Verified
      </Badge>
    );
  }

  const trigger = (label: string, className: string) => (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={() => createLinkToken.mutate()}
      disabled={busy}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin mr-1" />
      ) : (
        <Banknote className="h-3 w-3 mr-1" />
      )}
      {exchange.isPending ? "Verifying..." : label}
    </Button>
  );

  if (status === "failed" || status === "locked") {
    return (
      <div className="flex items-center justify-between gap-2 p-2 rounded border border-rose-100 bg-rose-50/40 mt-2">
        <div className="flex items-center gap-2">
          <XCircle className="h-3.5 w-3.5 text-rose-500" />
          <span className="text-[11px] font-medium text-rose-700">
            Verification failed — retry with bank login
          </span>
        </div>
        {trigger("Retry", "h-7 text-[10px] border-rose-200 text-rose-700 hover:bg-rose-100")}
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div className="flex items-center justify-between gap-2 p-2 rounded border bg-blue-50/50 border-blue-100 mt-2">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-blue-500" />
          <div className="text-[11px]">
            <p className="font-medium text-blue-700">Awaiting bank login</p>
            <p className="text-blue-600/70">Sign in to your bank to finish verifying.</p>
          </div>
        </div>
        {trigger("Reopen", "h-7 text-[10px] border-blue-200 text-blue-700 hover:bg-blue-100")}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 p-2 rounded border border-amber-100 bg-amber-50/30 mt-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-[11px] font-medium text-amber-700">Account not verified</span>
      </div>
      {trigger(
        "Verify with bank login",
        "h-7 text-[10px] border-amber-200 text-amber-700 hover:bg-amber-100",
      )}
    </div>
  );
}
