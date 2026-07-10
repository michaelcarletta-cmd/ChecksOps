import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, ShieldCheck, Loader2, RefreshCw } from "lucide-react";

/**
 * Landing page after Actum Authentecheck (Plaid) flow completes.
 * Actum redirects the user here; the postback webhook updates the account
 * status server-side. We poll for up to ~5 minutes with backoff and offer
 * a manual "Check now" button, since Actum's server-to-server postback can
 * lag or, on some merchant configs, arrive only after Plaid finishes
 * settling the identity check.
 */
export default function VerifyAccount() {
  const [params] = useSearchParams();
  // Actum's redirect only reliably preserves "order_id" and "merordernumber"
  // (echoing back our submitted merchantdata) — it does not carry through
  // arbitrary custom query params like our own "acct", so fall back to
  // merordernumber, which is the stakeholder_account id we originally sent.
  const acct = params.get("acct") || params.get("merordernumber");
  const ok = params.get("ok");
  const [status, setStatus] = useState<string>("pending");
  const [nickname, setNickname] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const cancelledRef = useRef(false);

  const fetchStatus = async () => {
    if (!acct) return null;
    const { data } = await supabase
      .from("stakeholder_accounts")
      .select("verification_status, nickname")
      .eq("id", acct)
      .maybeSingle();
    if (data?.nickname) setNickname(data.nickname);
    const s = data?.verification_status ?? "pending";
    setStatus(s);
    return s;
  };

  useEffect(() => {
    cancelledRef.current = false;
    if (!acct) { setLoading(false); return; }

    const startedAt = Date.now();
    // Poll with backoff: 1.5s for first 30s, then 5s, then 10s.
    // Stop after ~5 minutes.
    const scheduleNext = () => {
      if (cancelledRef.current) return;
      const elapsed = (Date.now() - startedAt) / 1000;
      setElapsedSec(Math.floor(elapsed));
      if (elapsed > 300) return; // 5 min cap
      const delay = elapsed < 30 ? 1500 : elapsed < 90 ? 5000 : 10000;
      setTimeout(async () => {
        if (cancelledRef.current) return;
        const s = await fetchStatus();
        if (s === "verified" || s === "admin_override" || s === "failed") return;
        scheduleNext();
      }, delay);
    };

    (async () => {
      const s = await fetchStatus();
      setLoading(false);
      if (s !== "verified" && s !== "admin_override" && s !== "failed") {
        scheduleNext();
      }
    })();

    return () => { cancelledRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acct]);

  const manualCheck = async () => {
    setRefreshing(true);
    await fetchStatus();
    setRefreshing(false);
  };

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
            <div className="rounded-md border bg-muted/30 p-4 text-center space-y-3">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                Waiting for your bank to confirm the verification.
                {elapsedSec > 20 && (
                  <> This usually takes a few seconds but can take up to a couple of minutes.</>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                Keep this page open{elapsedSec > 0 && <> — checked for {elapsedSec}s</>}.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={manualCheck}
                disabled={refreshing}
                className="mt-2"
              >
                {refreshing
                  ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking...</>
                  : <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Check status now</>}
              </Button>
              {elapsedSec > 120 && (
                <p className="text-xs text-muted-foreground pt-2 border-t">
                  Still waiting? Your bank sign-in went through, but our system
                  hasn't received confirmation from the payment processor yet.
                  Contact the sender — they can mark your account verified
                  manually.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
