import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { usePlaidLink } from "react-plaid-link";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";

type LoadState = "loading" | "redirecting" | "plaid" | "already_verified" | "verified" | "error";

/**
 * Public landing page for an emailed "link your bank account" link
 * (/verify-account/:token). No ChecksOps login required — the token itself
 * authenticates the request.
 *
 * `bank-link-session` resolves the tenant's payment rail server-side and returns
 * either a hosted Authentecheck URL (redirect) or a Plaid link token (in-page
 * overlay), so this page doesn't need to know which rail is active.
 */
export default function VerifyAccountStart() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [linkToken, setLinkToken] = useState<string | null>(null);

  const start = async () => {
    if (!token) {
      setErrorMessage("This verification link is missing information.");
      setState("error");
      return;
    }
    setState("loading");
    setLinkToken(null);
    const { data, error } = await supabase.functions.invoke("bank-link-session", {
      body: { token },
    });

    let payload: any = data;
    if (error) {
      let msg = error.message ?? "Failed to start verification";
      try {
        const body = await (error as any).context?.json?.();
        if (body) payload = body;
        if (body?.error) msg = body.error;
      } catch { /* ignore */ }
      if (payload?.alreadyVerified) {
        setState("already_verified");
        return;
      }
      setErrorMessage(msg);
      setState("error");
      return;
    }

    if (payload?.alreadyVerified) {
      setState("already_verified");
      return;
    }

    if (payload?.rail === "plaid" && payload?.link_token) {
      setLinkToken(payload.link_token);
      setState("plaid");
      return;
    }

    if (payload?.error || !payload?.url) {
      setErrorMessage(payload?.error ?? "No session URL returned");
      setState("error");
      return;
    }
    setState("redirecting");
    window.location.href = payload.url as string;
  };

  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const finishPlaid = useCallback(
    async (publicToken: string, accountId?: string) => {
      setState("loading");
      const { data, error } = await supabase.functions.invoke("plaid-exchange", {
        body: { token, public_token: publicToken, account_id: accountId },
      });
      if (error || (data as any)?.success === false) {
        let msg = error?.message ?? (data as any)?.error ?? "Verification failed";
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) msg = body.error;
        } catch { /* ignore */ }
        setErrorMessage(msg);
        setState("error");
        return;
      }
      setState("verified");
    },
    [token],
  );

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Link your bank account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(state === "loading" || state === "redirecting") && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {state === "loading" ? "Preparing secure bank login..." : "Redirecting to your bank login..."}
            </div>
          )}

          {state === "plaid" && linkToken && (
            <PlaidLauncher
              linkToken={linkToken}
              onComplete={finishPlaid}
              onCancel={(msg) => {
                setErrorMessage(msg);
                setState("error");
              }}
            />
          )}

          {(state === "already_verified" || state === "verified") && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-center space-y-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
              <p className="font-medium text-emerald-700">
                {state === "verified" ? "Bank account verified" : "Already verified"}
              </p>
              <p className="text-sm text-muted-foreground">
                {state === "verified"
                  ? "Your account is linked and ready to receive payments. You can close this page."
                  : "This account has already been verified. You can close this page."}
              </p>
            </div>
          )}

          {state === "error" && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-center space-y-3">
              <AlertTriangle className="h-10 w-10 text-rose-600 mx-auto" />
              <p className="font-medium text-rose-700">Couldn't start verification</p>
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
              <Button size="sm" variant="outline" onClick={start}>
                Try again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PlaidLauncher({
  linkToken,
  onComplete,
  onCancel,
}: {
  linkToken: string;
  onComplete: (publicToken: string, accountId?: string) => void;
  onCancel: (message: string) => void;
}) {
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata: any) =>
      onComplete(publicToken, metadata?.accounts?.[0]?.id ?? metadata?.account_id),
    onExit: (err) => {
      if (err) {
        onCancel(err.display_message ?? err.error_message ?? "Bank login was closed before finishing.");
      }
    },
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  return (
    <div className="space-y-3 text-center">
      <p className="text-sm text-muted-foreground">
        Sign in to your bank to securely link your account. We never see your bank password.
      </p>
      <Button onClick={() => open()} disabled={!ready} className="w-full">
        {ready ? "Continue to bank login" : "Preparing..."}
      </Button>
    </div>
  );
}
