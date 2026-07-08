import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";

type LoadState = "loading" | "redirecting" | "already_verified" | "error";

/**
 * Public landing page for an emailed "link your bank account" link
 * (/verify-account/:token). No ChecksOps login required — the token itself
 * authenticates the request. On load, fetches a fresh Actum Authentecheck
 * session for this token and redirects the browser into it.
 */
export default function VerifyAccountStart() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");

  const start = async () => {
    if (!token) {
      setErrorMessage("This verification link is missing information.");
      setState("error");
      return;
    }
    setState("loading");
    const { data, error } = await supabase.functions.invoke("actum-authentecheck-init-token", {
      body: { token },
    });
    if (error) {
      let msg = error.message ?? "Failed to start verification";
      try {
        const body = await (error as any).context?.json?.();
        if (body?.error) msg = body.error;
      } catch { /* ignore */ }
      setErrorMessage(msg);
      setState("error");
      return;
    }
    if ((data as any)?.alreadyVerified) {
      setState("already_verified");
      return;
    }
    if ((data as any)?.error || !(data as any)?.url) {
      setErrorMessage((data as any)?.error ?? "No session URL returned");
      setState("error");
      return;
    }
    setState("redirecting");
    window.location.href = (data as any).url as string;
  };

  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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

          {state === "already_verified" && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-center space-y-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
              <p className="font-medium text-emerald-700">Already verified</p>
              <p className="text-sm text-muted-foreground">
                This account has already been verified. You can close this page.
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
