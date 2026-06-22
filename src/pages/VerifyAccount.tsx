import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";

/**
 * Landing page after Actum Authentecheck (Plaid) flow completes.
 * Actum redirects the user here; the postback webhook updates the account
 * status server-side. We poll briefly to reflect the latest status.
 */
export default function VerifyAccount() {
  const [params] = useSearchParams();
  const acct = params.get("acct");
  const ok = params.get("ok");
  const [status, setStatus] = useState<string>("pending");
  const [nickname, setNickname] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      if (!acct) { setLoading(false); return; }
      const { data } = await supabase
        .from("stakeholder_accounts")
        .select("verification_status, nickname")
        .eq("id", acct)
        .maybeSingle();
      if (cancelled) return;
      if (data?.nickname) setNickname(data.nickname);
      const s = data?.verification_status ?? "pending";
      setStatus(s);
      setLoading(false);
      if (s === "pending" && attempts < 10) {
        attempts += 1;
        setTimeout(poll, 1500);
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [acct]);

  const verified = status === "verified" || status === "admin_override";
  const failed = status === "failed" || ok === "0";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Bank account verification
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking status...
            </div>
          ) : verified ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-center space-y-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
              <p className="font-medium text-emerald-700">Account verified</p>
              <p className="text-sm text-muted-foreground">
                {nickname ? <>Your account "{nickname}" is</> : "Your account is"} ready to receive ACH payments. You can close this page.
              </p>
            </div>
          ) : failed ? (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-center space-y-2">
              <AlertTriangle className="h-10 w-10 text-rose-600 mx-auto" />
              <p className="font-medium text-rose-700">Verification not completed</p>
              <p className="text-sm text-muted-foreground">
                The bank login was cancelled or declined. Return to the app and click "Verify with bank login" to try again.
              </p>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 p-4 text-center space-y-2">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                Finishing verification... you can close this window once your status updates.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
