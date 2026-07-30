import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { applyMoovTheme } from "@/lib/payments/moovTheme";
import { Loader2, ShieldCheck, Landmark, AlertCircle, CheckCircle2 } from "lucide-react";


/**
 * Branded, login-free recipient payment setup page.
 *
 * A homeowner, subcontractor, or one-time vendor arrives here from a secure,
 * expiring link. Their bank details are collected by the provider's hosted
 * component and travel straight from this browser to the provider — routing
 * and account numbers never pass through or get stored by ChecksOps.
 */

interface SessionData {
  recipient: { id: string; name: string; status: string };
  payer: { name: string; logo_url: string | null };
  account_id: string;
  token: string;
  environment: string;
}

const MOOV_JS_SRC = "https://js.moov.io/v1";

function useMoovScript(enabled: boolean) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    if ((window as any).Moov) { setReady(true); return; }
    const existing = document.querySelector(`script[src="${MOOV_JS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => setReady(true));
      return;
    }
    const s = document.createElement("script");
    s.src = MOOV_JS_SRC;
    s.async = true;
    s.onload = () => setReady(true);
    document.body.appendChild(s);
  }, [enabled]);
  return ready;
}

export default function RecipientPaymentSetup() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const scriptReady = useMoovScript(!!session);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: fnErr } = await supabase.functions.invoke("moov-recipient-session", {
          body: { token },
        });
        if (fnErr) {
          let message = "This link is not valid.";
          try {
            const parsed = await (fnErr as any).context?.json?.();
            if (parsed?.error) message = parsed.error;
          } catch { /* keep default */ }
          throw new Error(message);
        }
        if ((data as any)?.error) throw new Error((data as any).error);
        if (!cancelled) setSession(data as SessionData);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!session || !scriptReady || !dropRef.current) return;
    const Moov = (window as any).Moov;
    if (!Moov?.mount) return;

    try {
      // Hosted bank-account component. Sensitive fields are rendered and
      // submitted by the provider, not by ChecksOps.
      Moov.mount(dropRef.current, {
        drop: "bank-account",
        token: session.token,
        accountID: session.account_id,
        onSuccess: () => setDone(true),
        onError: (err: any) => setError(err?.message ?? "Could not save your bank account."),
      });
    } catch (e: any) {
      setError(e?.message ?? "Could not load the secure bank form.");
    }
  }, [session, scriptReady]);

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <header className="text-center space-y-2">
          {session?.payer.logo_url ? (
            <img
              src={session.payer.logo_url}
              alt={`${session.payer.name} logo`}
              className="h-10 mx-auto object-contain"
            />
          ) : null}
          <h1 className="text-xl font-semibold tracking-tight">
            Set up your payment details
          </h1>
          {session ? (
            <p className="text-sm text-muted-foreground">
              {session.payer.name} is sending you a payment.
            </p>
          ) : null}
        </header>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Landmark className="h-4 w-4 text-primary" />
              Where should we send your money?
            </CardTitle>
            <CardDescription className="text-xs">
              Your bank details go directly to our payment provider over a secure connection.
              They are never stored on ChecksOps servers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && (
              <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading secure form…
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-xs text-destructive">{error}</p>
              </div>
            )}

            {done && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                <p className="text-xs text-emerald-500">
                  Your bank account is connected. You can close this page — the payment will arrive
                  in your account.
                </p>
              </div>
            )}

            {!loading && !error && !done && (
              <div ref={dropRef} className="min-h-[220px]" />
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground text-center flex items-center justify-center gap-1.5">
          <ShieldCheck className="h-3 w-3" />
          Secured by ChecksOps. This link expires and can only be used by you.
        </p>
      </div>
    </main>
  );
}
